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
    /// 前回比 (P1-9)。前回データがない場合は AI が出力しない
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub progress: Option<Progress>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Progress {
    pub comparisons: Vec<ProgressComparison>,
    #[serde(default)]
    pub comment: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ProgressComparison {
    pub metric: String,
    pub previous: String,
    pub current: String,
    pub assessment: String,
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

/// Rewrites `http://localhost` to `http://127.0.0.1` to prevent DNS rebinding
/// attacks where `/etc/hosts` remaps localhost to an internal network address.
/// HTTPS is intentionally left unchanged: a TLS certificate issued to `localhost`
/// already prevents rebinding because the cert won't match a remapped IP.
fn normalize_ollama_url(raw: &str) -> String {
    // Normalize http://localhost[:PORT][/...] only — not https://.
    if let Some(rest) = raw.strip_prefix("http://localhost:") {
        return format!("http://127.0.0.1:{}", rest);
    }
    if raw == "http://localhost" || raw.starts_with("http://localhost/") {
        return raw.replacen("http://localhost", "http://127.0.0.1", 1);
    }
    raw.to_string()
}

/// Validates that an Ollama URL is restricted to loopback or RFC-1918 private
/// addresses to prevent SSRF. Accepts http/https only.
pub fn validate_ollama_url(raw: &str) -> Result<(), String> {
    let parsed = reqwest::Url::parse(raw)
        .map_err(|_| "Ollama URL の形式が正しくありません".to_string())?;

    match parsed.scheme() {
        "http" | "https" => {}
        _ => return Err("Ollama URL は http:// または https:// で始まる必要があります".to_string()),
    }

    let host = parsed.host_str()
        .ok_or_else(|| "Ollama URL にホストが指定されていません".to_string())?;

    if host == "localhost" {
        return Ok(());
    }

    // Strip brackets from IPv6 literals before parsing
    let ip: std::net::IpAddr = host.trim_matches(|c| c == '[' || c == ']')
        .parse()
        .map_err(|_| "Ollama URL のホストは loopback またはプライベート IP アドレスである必要があります".to_string())?;

    if ip.is_loopback() {
        return Ok(());
    }

    let is_private = match ip {
        std::net::IpAddr::V4(v4) => {
            let o = v4.octets();
            o[0] == 10
                || (o[0] == 172 && (16..=31).contains(&o[1]))
                || (o[0] == 192 && o[1] == 168)
        }
        std::net::IpAddr::V6(_) => false,
    };

    if is_private {
        Ok(())
    } else {
        Err("Ollama URL はローカルまたはプライベートネットワークのアドレスのみ使用できます".to_string())
    }
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
        // P1-9: progress(前回比)セクション追加分のヘッドルームを確保
        max_tokens: 2600,
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

    let base_url = normalize_ollama_url(base_url);
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

pub async fn test_claude_connection(
    client: &reqwest::Client,
    api_key: &str,
    model: &str,
) -> Result<(), String> {
    #[derive(Serialize)]
    struct Req<'a> {
        model: &'a str,
        max_tokens: u32,
        messages: Vec<Msg<'a>>,
    }
    #[derive(Serialize)]
    struct Msg<'a> {
        role: &'a str,
        content: &'a str,
    }

    let body = Req {
        model,
        max_tokens: 1,
        messages: vec![Msg { role: "user", content: "hi" }],
    };

    let res = client
        .post("https://api.anthropic.com/v1/messages")
        .header("x-api-key", api_key)
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Claude APIへの接続に失敗しました: {}", e))?;

    match res.status().as_u16() {
        200..=299 => Ok(()),
        401 => Err("Claude APIキーが無効です。正しいキーを入力してください。".to_string()),
        status => Err(format!("Claude API エラー ({})", status)),
    }
}

pub async fn test_ollama_connection(
    client: &reqwest::Client,
    url: &str,
    model: &str,
) -> Result<String, String> {
    #[derive(Deserialize)]
    struct TagsResponse {
        models: Vec<ModelInfo>,
    }
    #[derive(Deserialize)]
    struct ModelInfo {
        name: String,
    }

    let url = normalize_ollama_url(url);
    let tags_url = format!("{}/api/tags", url.trim_end_matches('/'));

    let res = client
        .get(&tags_url)
        .send()
        .await
        .map_err(|_| "Ollamaへの接続に失敗しました。Ollamaが起動しているか確認してください。".to_string())?;

    if !res.status().is_success() {
        return Err(format!("Ollama エラー ({})", res.status()));
    }

    let tags: TagsResponse = res
        .json()
        .await
        .map_err(|_| "Ollamaのレスポンスを解析できませんでした".to_string())?;

    let model_base = model.split(':').next().unwrap_or(model);
    let found = tags.models.iter().any(|m| {
        m.name == model
            || m.name.starts_with(&format!("{}:", model_base))
            || m.name == model_base
    });

    if found {
        Ok(format!("Ollamaへの接続に成功しました。モデル {} を確認しました。", model))
    } else if tags.models.is_empty() {
        Err(format!(
            "Ollamaに接続できましたが、モデルが見つかりません。`ollama pull {}` を実行してください。",
            model
        ))
    } else {
        let available: Vec<&str> = tags.models.iter().map(|m| m.name.as_str()).collect();
        Err(format!(
            "Ollamaに接続できましたが、モデル {} が見つかりません。`ollama pull {}` を実行してください。利用可能: {}",
            model, model, available.join(", ")
        ))
    }
}

fn strip_code_fences(raw: &str) -> &str {
    let s = raw.trim();
    // Claude sometimes wraps JSON in ```json ... ``` or ``` ... ``` fences
    if let Some(inner) = s.strip_prefix("```json") {
        inner.trim_start_matches('\n').trim_end_matches("```").trim()
    } else if let Some(inner) = s.strip_prefix("```") {
        inner.trim_start_matches('\n').trim_end_matches("```").trim()
    } else {
        s
    }
}

fn parse_and_validate(raw: String) -> Result<CoachingReport, String> {
    let clean = strip_code_fences(&raw);
    let mut parsed: serde_json::Value = serde_json::from_str(clean)
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

    // progress は任意項目。壊れた progress でレポート全体を失敗させない
    if !parsed["progress"].is_null()
        && serde_json::from_value::<Progress>(parsed["progress"].clone()).is_err()
    {
        if let Some(obj) = parsed.as_object_mut() {
            obj.remove("progress");
        }
    }

    serde_json::from_value(parsed)
        .map_err(|e| format!("レスポンスの変換に失敗しました: {}", e))
}
