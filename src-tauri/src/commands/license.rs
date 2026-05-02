use tauri::AppHandle;
use tauri_plugin_store::StoreExt;

use crate::license::{validate_key, LicenseTier};

const STORE_PATH: &str = "settings.json";
const KEY_LICENSE_TIER: &str = "license_tier";
const KEY_LICENSE_KEY: &str = "license_key";
const KEY_CLOUD_CREDITS: &str = "cloud_credits";
const KEY_USED_CREDIT_NONCES: &str = "used_credit_nonces";
const CLOUD_MONTHLY_CREDITS: i64 = 30;

#[derive(serde::Serialize)]
pub struct LicenseStatus {
    pub tier: String,
    pub cloud_credits: i64,
    pub has_key: bool,
    pub cloud_expires_at: Option<String>, // "YYYY-MM" for CloudMonthly, None otherwise
}

#[tauri::command]
pub fn activate_license(app: AppHandle, key: String) -> Result<LicenseStatus, String> {
    let info = validate_key(&key)?;

    let store = app.store(STORE_PATH)
        .map_err(|e| format!("設定の読み込みに失敗しました: {}", e))?;

    match &info.tier {
        LicenseTier::ProLifetime => {
            store.set(KEY_LICENSE_TIER, serde_json::json!("pro"));
            store.set(KEY_LICENSE_KEY, serde_json::json!(key));
        }
        LicenseTier::CloudMonthly { .. } => {
            // Prevent re-activating the identical key to reset credits every time.
            // A legitimate renewal uses a new key for the next billing month.
            let current_key = store.get(KEY_LICENSE_KEY)
                .and_then(|v| v.as_str().map(|s| s.to_string()));
            if current_key.as_deref() == Some(&info.raw_key) {
                return Err("このVCLOUDキーは既にアクティベート済みです。翌月分のキーを使用してください。".to_string());
            }
            store.set(KEY_LICENSE_TIER, serde_json::json!("cloud"));
            store.set(KEY_LICENSE_KEY, serde_json::json!(&info.raw_key));
            // Add monthly credits (replace, not accumulate, for subscription renewals)
            store.set(KEY_CLOUD_CREDITS, serde_json::json!(CLOUD_MONTHLY_CREDITS));
        }
        LicenseTier::Credit10 | LicenseTier::Credit30 => {
            // Prevent reuse: check nonce
            let nonce = info.nonce;
            let used_nonces: Vec<u8> = store.get(KEY_USED_CREDIT_NONCES)
                .and_then(|v| serde_json::from_value(v).ok())
                .unwrap_or_default();

            if used_nonces.contains(&nonce) {
                return Err("このクレジットキーはすでに使用済みです".to_string());
            }

            let add = if info.tier == LicenseTier::Credit10 { 10i64 } else { 30i64 };
            let current: i64 = store.get(KEY_CLOUD_CREDITS)
                .and_then(|v| v.as_i64())
                .unwrap_or(0);
            store.set(KEY_CLOUD_CREDITS, serde_json::json!(current + add));

            // Upgrade tier to 'cloud' if not already — credits are only usable under cloud tier
            let current_tier = store.get(KEY_LICENSE_TIER)
                .and_then(|v| v.as_str().map(|s| s.to_string()))
                .unwrap_or_else(|| "free".to_string());
            if current_tier != "cloud" {
                store.set(KEY_LICENSE_TIER, serde_json::json!("cloud"));
            }

            // Mark nonce as used
            let mut updated_nonces = used_nonces;
            updated_nonces.push(nonce);
            store.set(KEY_USED_CREDIT_NONCES, serde_json::to_value(&updated_nonces).unwrap());
        }
    }

    store.save().map_err(|e| format!("設定の保存に失敗しました: {}", e))?;

    Ok(build_license_status(&store))
}

#[tauri::command]
pub fn get_license_status(app: AppHandle) -> LicenseStatus {
    let Ok(store) = app.store(STORE_PATH) else {
        return LicenseStatus { tier: "free".to_string(), cloud_credits: 0, has_key: false };
    };
    build_license_status(&store)
}

fn build_license_status(store: &tauri_plugin_store::Store<tauri::Wry>) -> LicenseStatus {
    let tier = store.get(KEY_LICENSE_TIER)
        .and_then(|v| v.as_str().map(|s| s.to_string()))
        .unwrap_or_else(|| "free".to_string());
    let cloud_credits = store.get(KEY_CLOUD_CREDITS)
        .and_then(|v| v.as_i64())
        .unwrap_or(0);
    let raw_key = store.get(KEY_LICENSE_KEY)
        .and_then(|v| v.as_str().map(|s| s.to_string()));
    let has_key = raw_key.is_some();

    // Derive expiry display string from the stored VCLOUD key
    let cloud_expires_at = if tier == "cloud" {
        raw_key.as_deref()
            .and_then(crate::license::get_cloud_expiry)
            .map(|(year, month)| format!("{}-{:02}", 2020i32 + year as i32, month))
    } else {
        None
    };

    LicenseStatus { tier, cloud_credits, has_key, cloud_expires_at }
}
