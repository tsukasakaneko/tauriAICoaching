use sha2::{Digest, Sha256};
use tauri::{AppHandle, State};
use tauri_plugin_store::StoreExt;

use crate::license::validate_key;
use crate::HttpClient;

const STORE_PATH: &str = "settings.json";
const KEY_LICENSE_TIER: &str = "license_tier";
const KEY_LICENSE_KEY: &str = "license_key";
const KEY_CLOUD_CREDITS: &str = "cloud_credits";
const KEY_LICENSE_TOKEN: &str = "license_token";
const KEY_CLOUD_EXPIRES_AT: &str = "cloud_expires_at";

// P0-1: クレジット残高の正はサーバー台帳。ローカルストアは表示用キャッシュに格下げ。
// リモート API の URL はフロントエンドと同じ VITE_API_URL をビルド時に注入する。
const REMOTE_API_URL: Option<&str> = option_env!("VITE_API_URL");

fn remote_api_url() -> String {
    REMOTE_API_URL
        .filter(|s| !s.is_empty())
        .unwrap_or("http://127.0.0.1:3002")
        .trim_end_matches('/')
        .to_string()
}

/// Normalizes the key prefix to uppercase while preserving the base64url body.
fn normalize_key_prefix(key: &str) -> String {
    if let Some(pos) = key.find('-') {
        format!("{}{}", key[..pos].to_uppercase(), &key[pos..])
    } else {
        key.to_uppercase()
    }
}

/// 端末を一意に識別するハッシュ。OS のマシンIDベースなので再インストールでも変わらない。
fn device_hash() -> Result<String, String> {
    let uid = machine_uid::get()
        .map_err(|_| "端末IDの取得に失敗しました".to_string())?;
    let mut hasher = Sha256::new();
    hasher.update(b"valorant-ai-coaching:");
    hasher.update(uid.as_bytes());
    Ok(format!("{:x}", hasher.finalize()))
}

#[derive(serde::Serialize)]
pub struct LicenseStatus {
    pub tier: String,
    pub cloud_credits: i64,
    pub has_key: bool,
    pub cloud_expires_at: Option<String>, // "YYYY-MM" for cloud subscriptions, None otherwise
}

/// Returned from activate_license so the frontend can show a bonus notification.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivationResult {
    pub license: LicenseStatus,
    /// Credits granted as a first-payment welcome bonus (0 if not applicable).
    pub first_payment_bonus: i64,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ActivateResponse {
    license_token: String,
    tier: String,
    credits: i64,
    expires_at: Option<String>,
    first_payment_bonus: i64,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct StatusResponse {
    tier: String,
    credits: i64,
    expires_at: Option<String>,
}

#[derive(serde::Deserialize)]
struct ErrorResponse {
    message: Option<String>,
}

async fn error_message(response: reqwest::Response, fallback: &str) -> String {
    response
        .json::<ErrorResponse>()
        .await
        .ok()
        .and_then(|e| e.message)
        .unwrap_or_else(|| fallback.to_string())
}

/// サーバーのステータスをローカルの表示用キャッシュに反映する。
fn cache_status(
    store: &tauri_plugin_store::Store<tauri::Wry>,
    tier: &str,
    credits: i64,
    expires_at: &Option<String>,
) {
    store.set(KEY_LICENSE_TIER, serde_json::json!(tier));
    store.set(KEY_CLOUD_CREDITS, serde_json::json!(credits));
    match expires_at {
        Some(exp) => store.set(KEY_CLOUD_EXPIRES_AT, serde_json::json!(exp)),
        None => {
            store.delete(KEY_CLOUD_EXPIRES_AT);
        }
    }
    let _ = store.save();
}

fn build_license_status(store: &tauri_plugin_store::Store<tauri::Wry>) -> LicenseStatus {
    let tier = store.get(KEY_LICENSE_TIER)
        .and_then(|v| v.as_str().map(|s| s.to_string()))
        .unwrap_or_else(|| "free".to_string());
    let cloud_credits = store.get(KEY_CLOUD_CREDITS)
        .and_then(|v| v.as_i64())
        .unwrap_or(0);
    let has_key = store.get(KEY_LICENSE_KEY)
        .and_then(|v| v.as_str().map(|s| s.to_string()))
        .is_some();
    let cloud_expires_at = store.get(KEY_CLOUD_EXPIRES_AT)
        .and_then(|v| v.as_str().map(|s| s.to_string()));

    LicenseStatus { tier, cloud_credits, has_key, cloud_expires_at }
}

/// サーバー台帳から最新ステータスを取得しキャッシュを更新する。
/// トークン未保持・オフライン・サーバーエラー時は None(呼び出し側はキャッシュを使う)。
pub async fn refresh_status_from_server(app: &AppHandle, http: &reqwest::Client) -> Option<()> {
    let store = app.store(STORE_PATH).ok()?;
    let token = store.get(KEY_LICENSE_TOKEN)
        .and_then(|v| v.as_str().map(|s| s.to_string()))?;

    let response = http
        .get(format!("{}/license/status", remote_api_url()))
        .bearer_auth(&token)
        .send()
        .await
        .ok()?;

    if !response.status().is_success() {
        return None;
    }

    let status: StatusResponse = response.json().await.ok()?;
    cache_status(&store, &status.tier, status.credits, &status.expires_at);
    Some(())
}

#[tauri::command]
pub async fn activate_license(
    app: AppHandle,
    http: State<'_, HttpClient>,
    key: String,
) -> Result<ActivationResult, String> {
    // 形式・署名・期限のローカル即時チェック(エラーメッセージの改善用。正の検証はサーバー)
    let info = validate_key(&key)?;
    let normalized = normalize_key_prefix(&info.raw_key);
    let device = device_hash()?;

    let response = http.0
        .post(format!("{}/license/activate", remote_api_url()))
        .json(&serde_json::json!({ "key": normalized, "deviceHash": device }))
        .send()
        .await
        .map_err(|_| {
            "ライセンスサーバーに接続できませんでした。ネットワーク接続を確認してください。".to_string()
        })?;

    if !response.status().is_success() {
        return Err(error_message(response, "アクティベートに失敗しました").await);
    }

    let activated: ActivateResponse = response
        .json()
        .await
        .map_err(|_| "サーバーレスポンスの解析に失敗しました".to_string())?;

    let store = app.store(STORE_PATH)
        .map_err(|e| format!("設定の読み込みに失敗しました: {}", e))?;

    store.set(KEY_LICENSE_KEY, serde_json::json!(normalized));
    store.set(KEY_LICENSE_TOKEN, serde_json::json!(activated.license_token));
    cache_status(&store, &activated.tier, activated.credits, &activated.expires_at);
    store.save().map_err(|e| format!("設定の保存に失敗しました: {}", e))?;

    Ok(ActivationResult {
        license: build_license_status(&store),
        first_payment_bonus: activated.first_payment_bonus,
    })
}

#[tauri::command]
pub async fn get_license_status(
    app: AppHandle,
    http: State<'_, HttpClient>,
) -> Result<LicenseStatus, String> {
    // サーバー照会に成功すればキャッシュが更新され、失敗時はキャッシュ値を返す
    let _ = refresh_status_from_server(&app, &http.0).await;

    let Ok(store) = app.store(STORE_PATH) else {
        return Ok(LicenseStatus {
            tier: "free".to_string(),
            cloud_credits: 0,
            has_key: false,
            cloud_expires_at: None,
        });
    };
    Ok(build_license_status(&store))
}

/// フロントエンドがリモート /analyze に添付するライセンストークンを返す。
#[tauri::command]
pub fn get_license_token(app: AppHandle) -> Option<String> {
    let store = app.store(STORE_PATH).ok()?;
    store.get(KEY_LICENSE_TOKEN)
        .and_then(|v| v.as_str().map(|s| s.to_string()))
}
