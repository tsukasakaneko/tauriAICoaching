use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiConfig {
    pub provider: AiProviderType,
    pub claude_api_key: Option<String>,
    pub claude_model: String,
    pub ollama_url: String,
    pub ollama_model: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum AiProviderType {
    Cloud,
    Local,
}

impl Default for AiConfig {
    fn default() -> Self {
        Self {
            provider: AiProviderType::Cloud,
            claude_api_key: None,
            claude_model: "claude-sonnet-4-6".to_string(),
            ollama_url: "http://127.0.0.1:11434".to_string(),
            ollama_model: "llama3.1:8b".to_string(),
        }
    }
}

// Shared JSON response structures matching the TypeScript CoachingReport type
#[derive(Debug, Serialize, Deserialize)]
pub struct CoachingReport {
    pub improvements: Vec<Improvement>,
    pub training_plan: Vec<String>,
    pub summary: Summary,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Improvement {
    pub title: String,
    pub description: String,
    pub cause: String,
    pub actions: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Summary {
    pub strengths: String,
    pub weaknesses: String,
    pub focus: String,
}

pub async fn call_ai(
    client: &reqwest::Client,
    config: &AiConfig,
    system_prompt: &str,
    user_prompt: &str,
) -> Result<CoachingReport, String> {
    let raw = match config.provider {
        AiProviderType::Cloud => {
            let api_key = config.claude_api_key.as_deref()
                .ok_or("Claude APIキーが設定されていません。設定画面でAPIキーを入力してください。")?;
            call_claude(client, api_key, &config.claude_model, system_prompt, user_prompt).await?
        }
        AiProviderType::Local => {
            call_ollama(client, &config.ollama_url, &config.ollama_model, system_prompt, user_prompt).await?
        }
    };

    parse_and_validate(raw)
}

async fn call_claude(
    client: &reqwest::Client,
    api_key: &str,
    model: &str,
    system_prompt: &str,
    user_prompt: &str,
) -> Result<String, String> {
    #[derive(Serialize)]
    struct ClaudeRequest<'a> {
        model: &'a str,
        max_tokens: u32,
        system: &'a str,
        messages: Vec<ClaudeMessage<'a>>,
    }

    #[derive(Serialize)]
    struct ClaudeMessage<'a> {
        role: &'a str,
        content: &'a str,
    }

    #[derive(Deserialize)]
    struct ClaudeResponse {
        content: Vec<ClaudeContent>,
    }

    #[derive(Deserialize)]
    struct ClaudeContent {
        text: Option<String>,
    }

    let request_body = ClaudeRequest {
        model,
        max_tokens: 2048,
        system: system_prompt,
        messages: vec![ClaudeMessage { role: "user", content: user_prompt }],
    };

    let response = client
        .post("https://api.anthropic.com/v1/messages")
        .header("x-api-key", api_key)
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json")
        .json(&request_body)
        .send()
        .await
        .map_err(|e| format!("Claude APIへの接続に失敗しました: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        if status.as_u16() == 401 {
            return Err("Claude APIキーが無効です。設定画面で正しいキーを入力してください。".to_string());
        }
        return Err(format!("Claude API エラー ({}): {}", status, body));
    }

    let claude_resp: ClaudeResponse = response
        .json()
        .await
        .map_err(|e| format!("レスポンスの解析に失敗しました: {}", e))?;

    claude_resp.content.into_iter()
        .find_map(|c| c.text)
        .ok_or_else(|| "Claude APIから空のレスポンスが返されました".to_string())
}

async fn call_ollama(
    client: &reqwest::Client,
    base_url: &str,
    model: &str,
    system_prompt: &str,
    user_prompt: &str,
) -> Result<String, String> {
    #[derive(Serialize)]
    struct OllamaRequest<'a> {
        model: &'a str,
        messages: Vec<OllamaMessage<'a>>,
        stream: bool,
        format: &'a str,
    }

    #[derive(Serialize)]
    struct OllamaMessage<'a> {
        role: &'a str,
        content: &'a str,
    }

    #[derive(Deserialize)]
    struct OllamaResponse {
        message: OllamaResponseMessage,
    }

    #[derive(Deserialize)]
    struct OllamaResponseMessage {
        content: String,
    }

    let url = format!("{}/api/chat", base_url);
    let request_body = OllamaRequest {
        model,
        messages: vec![
            OllamaMessage { role: "system", content: system_prompt },
            OllamaMessage { role: "user", content: user_prompt },
        ],
        stream: false,
        format: "json",
    };

    let response = client
        .post(&url)
        .json(&request_body)
        .send()
        .await
        .map_err(|_| "Ollamaへの接続に失敗しました。Ollamaが起動しているか確認してください。".to_string())?;

    if !response.status().is_success() {
        return Err(format!("Ollama エラー ({})", response.status()));
    }

    let ollama_resp: OllamaResponse = response
        .json()
        .await
        .map_err(|e| format!("Ollamaレスポンスの解析に失敗しました: {}", e))?;

    Ok(ollama_resp.message.content)
}

fn parse_and_validate(raw: String) -> Result<CoachingReport, String> {
    let parsed: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|_| "AIのレスポンスがJSON形式ではありません。もう一度お試しください。".to_string())?;

    // Validate structure
    let improvements = parsed["improvements"].as_array()
        .ok_or("AIレスポンスのimprovementsフィールドが不正です")?;

    for item in improvements {
        if item["title"].as_str().is_none()
            || item["description"].as_str().is_none()
            || item["cause"].as_str().is_none()
            || item["actions"].as_array().is_none()
        {
            return Err("AIレスポンスのimprovements形式が不正です".to_string());
        }
    }

    if parsed["training_plan"].as_array().is_none() {
        return Err("AIレスポンスのtraining_planフィールドが不正です".to_string());
    }

    let summary = &parsed["summary"];
    if summary["strengths"].as_str().is_none()
        || summary["weaknesses"].as_str().is_none()
        || summary["focus"].as_str().is_none()
    {
        return Err("AIレスポンスのsummaryフィールドが不正です".to_string());
    }

    serde_json::from_value(parsed)
        .map_err(|e| format!("レスポンスの変換に失敗しました: {}", e))
}
