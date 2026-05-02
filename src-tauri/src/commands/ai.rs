use tauri::{AppHandle, State};
use tauri_plugin_store::StoreExt;

use crate::ai_provider::{AiConfig, AiProviderType, CoachingReport};
use crate::license::LicenseTier;
use crate::prompt_builder::{AnalyzePayload, build_system_prompt, build_user_prompt};
use crate::HttpClient;

const STORE_PATH: &str = "settings.json";
const KEY_AI_CONFIG: &str = "ai_config";
const KEY_LICENSE_TIER: &str = "license_tier";
const KEY_ANALYSIS_COUNT: &str = "analysis_count";
const KEY_CLOUD_CREDITS: &str = "cloud_credits";
const FREE_TIER_LIMIT: u32 = 3;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageStatus {
    tier: String,
    analysis_count: u32,
    free_limit: u32,
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

fn get_analysis_count(app: &AppHandle) -> u32 {
    let Ok(store) = app.store(STORE_PATH) else {
        return 0;
    };
    store.get(KEY_ANALYSIS_COUNT)
        .and_then(|v| v.as_u64())
        .unwrap_or(0) as u32
}

fn increment_analysis_count(app: &AppHandle) {
    if let Ok(store) = app.store(STORE_PATH) {
        let count = get_analysis_count(app) + 1;
        let _ = store.set(KEY_ANALYSIS_COUNT, serde_json::json!(count));
        let _ = store.save();
    }
}

fn get_cloud_credits(app: &AppHandle) -> i64 {
    let Ok(store) = app.store(STORE_PATH) else {
        return 0;
    };
    store.get(KEY_CLOUD_CREDITS)
        .and_then(|v| v.as_i64())
        .unwrap_or(0)
}

fn decrement_cloud_credits(app: &AppHandle) {
    if let Ok(store) = app.store(STORE_PATH) {
        let credits = (get_cloud_credits(app) - 1).max(0);
        let _ = store.set(KEY_CLOUD_CREDITS, serde_json::json!(credits));
        let _ = store.save();
    }
}

#[tauri::command]
pub async fn ai_analyze(
    app: AppHandle,
    http: State<'_, HttpClient>,
    payload: AnalyzePayload,
) -> Result<CoachingReport, String> {
    let tier = get_license_tier(&app);
    let config = load_ai_config(&app);

    // License check
    match tier.as_str() {
        "free" => {
            let count = get_analysis_count(&app);
            if count >= FREE_TIER_LIMIT {
                return Err(format!(
                    "無料プランの分析回数上限（{}回）に達しました。プロライセンスキーを入力してください。",
                    FREE_TIER_LIMIT
                ));
            }
        }
        "cloud" => {
            // Re-validate CloudMonthly subscription expiry on every analysis.
            // Activation-time check alone is insufficient — the subscription may have
            // expired since the key was first entered.
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

            if config.provider == AiProviderType::Cloud {
                let credits = get_cloud_credits(&app);
                if credits <= 0 {
                    return Err(
                        "クラウドAIのクレジットが不足しています。VCREDITキーを入力してクレジットを追加してください。"
                            .to_string(),
                    );
                }
            }
        }
        _ => {} // "pro" tier: no limits
    }

    let system_prompt = build_system_prompt(&payload.agent, &payload.rank);
    let user_prompt = build_user_prompt(&payload);

    let result = crate::ai_provider::call_ai(&http.0, &config, &system_prompt, &user_prompt).await?;

    // Deduct credits/count after successful call
    match tier.as_str() {
        "free" => increment_analysis_count(&app),
        "cloud" => {
            if config.provider == AiProviderType::Cloud {
                decrement_cloud_credits(&app);
            }
        }
        _ => {}
    }

    Ok(result)
}

#[tauri::command]
pub fn get_ai_config(app: AppHandle) -> AiConfig {
    let mut config = load_ai_config(&app);
    // Mask API key for security
    if let Some(key) = &config.claude_api_key {
        if key.len() > 8 {
            config.claude_api_key = Some(format!("{}...{}", &key[..4], &key[key.len()-4..]));
        }
    }
    config
}

#[tauri::command]
pub fn set_ai_config(app: AppHandle, config: AiConfig) -> Result<(), String> {
    // If the masked key is passed back, keep the existing key
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
pub fn get_usage_status(app: AppHandle) -> UsageStatus {
    UsageStatus {
        tier: get_license_tier(&app),
        analysis_count: get_analysis_count(&app),
        free_limit: FREE_TIER_LIMIT,
        cloud_credits: get_cloud_credits(&app),
    }
}
