use tauri::{AppHandle, State};
use tauri_plugin_store::StoreExt;

use crate::ai_provider::{AiConfig, AiProviderType, CoachingReport};
use crate::prompt_builder::{AnalyzePayload, build_system_prompt, build_user_prompt};
use crate::HttpClient;

const STORE_PATH: &str = "settings.json";
const KEY_AI_CONFIG: &str = "ai_config";
const KEY_LICENSE_TIER: &str = "license_tier";
const KEY_LICENSE_KEY: &str = "license_key";
const KEY_CLOUD_CREDITS: &str = "cloud_credits";

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageStatus {
    tier: String,
    cloud_credits: i64,
}

fn load_ai_config(app: &AppHandle) -> AiConfig {
    let Ok(store) = app.store(STORE_PATH) else {
        return AiConfig::default();
    };
    store.get(KEY_AI_CONFIG)
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default()
}

fn get_license_tier(app: &AppHandle) -> String {
    let Ok(store) = app.store(STORE_PATH) else {
        return "free".to_string();
    };
    store.get(KEY_LICENSE_TIER)
        .and_then(|v| v.as_str().map(|s| s.to_string()))
        .unwrap_or_else(|| "free".to_string())
}

fn get_cloud_credits(app: &AppHandle) -> i64 {
    let Ok(store) = app.store(STORE_PATH) else {
        return 0;
    };
    store.get(KEY_CLOUD_CREDITS)
        .and_then(|v| v.as_i64())
        .unwrap_or(0)
}

#[tauri::command]
pub async fn ai_analyze(
    app: AppHandle,
    http: State<'_, HttpClient>,
    payload: AnalyzePayload,
) -> Result<CoachingReport, String> {
    let tier = get_license_tier(&app);
    let config = load_ai_config(&app);

    match tier.as_str() {
        "free" => {
            return Err(
                "ライセンスキーが必要です。設定画面からキーをアクティベートしてください。"
                    .to_string(),
            );
        }
        "cloud" => {
            // Re-validate CloudMonthly subscription expiry on every analysis
            if let Ok(store) = app.store(STORE_PATH) {
                let stored_key = store.get(KEY_LICENSE_KEY)
                    .and_then(|v| v.as_str().map(|s| s.to_string()));
                if let Some(raw_key) = stored_key {
                    if crate::license::cloud_subscription_expired(&raw_key) {
                        store.set(KEY_LICENSE_TIER, serde_json::json!("free"));
                        store.set(KEY_CLOUD_CREDITS, serde_json::json!(0i64));
                        let _ = store.save();
                        return Err(
                            "VCLOUDサブスクリプションの有効期限が切れました。新しいVCLOUDキーを入力してください。"
                                .to_string(),
                        );
                    }
                }
            }

            // 事前ガード(キャッシュ値)。残高の正はサーバー台帳で、
            // クラウド分析はリモート /analyze がサーバー側で消費・拒否する。
            if config.provider == AiProviderType::Cloud {
                if get_cloud_credits(&app) <= 0 {
                    return Err(
                        "クラウドAIのクレジットが不足しています。VCREDITキーを入力してクレジットを追加してください。"
                            .to_string(),
                    );
                }
            }
        }
        _ => {} // "pro": unlimited
    }

    const MAX_TOTAL_INPUT: usize = 10_000;
    let total_input_len = payload.rank.len()
        + payload.agent.len()
        + payload.review.len()
        + payload.self_assessment.iter().map(|s| s.len()).sum::<usize>();
    if total_input_len > MAX_TOTAL_INPUT {
        return Err("入力データが大きすぎます。各フィールドを短くしてください。".to_string());
    }

    let system_prompt = build_system_prompt(&payload.agent, &payload.rank);
    let user_prompt = build_user_prompt(&payload);

    // クレジット消費はサーバー台帳側で行う(P0-1)。ローカルでのデクリメントは廃止。
    crate::ai_provider::call_ai(&http.0, &config, &system_prompt, &user_prompt).await
}

#[tauri::command]
pub fn get_ai_config(app: AppHandle) -> AiConfig {
    let mut config = load_ai_config(&app);
    if let Some(key) = &config.claude_api_key {
        if key.len() > 8 {
            config.claude_api_key = Some(format!("{}...{}", &key[..4], &key[key.len()-4..]));
        }
    }
    config
}

#[tauri::command]
pub fn set_ai_config(app: AppHandle, config: AiConfig) -> Result<(), String> {
    crate::ai_provider::validate_ollama_url(&config.ollama_url)?;

    let final_config = if config.claude_api_key.as_deref().map(|k| k.contains("...")).unwrap_or(false) {
        let existing = load_ai_config(&app);
        AiConfig { claude_api_key: existing.claude_api_key, ..config }
    } else {
        config
    };

    let store = app.store(STORE_PATH)
        .map_err(|e| format!("設定の保存に失敗しました: {}", e))?;
    store.set(KEY_AI_CONFIG, serde_json::to_value(&final_config).unwrap());
    store.save().map_err(|e| format!("設定ファイルの書き込みに失敗しました: {}", e))?;
    Ok(())
}

#[tauri::command]
pub async fn test_claude_key(
    http: State<'_, HttpClient>,
    api_key: String,
    model: String,
) -> Result<String, String> {
    crate::ai_provider::test_claude_connection(&http.0, &api_key, &model).await?;
    Ok("Claude APIキーの認証に成功しました".to_string())
}

#[tauri::command]
pub async fn test_ollama(
    http: State<'_, HttpClient>,
    url: String,
    model: String,
) -> Result<String, String> {
    crate::ai_provider::validate_ollama_url(&url)?;
    crate::ai_provider::test_ollama_connection(&http.0, &url, &model).await
}

#[tauri::command]
pub async fn get_usage_status(
    app: AppHandle,
    http: State<'_, HttpClient>,
) -> Result<UsageStatus, String> {
    // サーバー台帳から最新残高を取得してキャッシュを更新(オフライン時はキャッシュ値)
    let _ = crate::commands::license::refresh_status_from_server(&app, &http.0).await;
    Ok(UsageStatus {
        tier: get_license_tier(&app),
        cloud_credits: get_cloud_credits(&app),
    })
}
