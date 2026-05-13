use tauri::AppHandle;
use tauri_plugin_store::StoreExt;

use crate::license::{validate_key, LicenseTier};

const STORE_PATH: &str = "settings.json";
const KEY_LICENSE_TIER: &str = "license_tier";
const KEY_LICENSE_KEY: &str = "license_key";
const KEY_CLOUD_CREDITS: &str = "cloud_credits";
const KEY_USED_CREDIT_NONCES: &str = "used_credit_nonces";
const KEY_FIRST_PAYMENT_DONE: &str = "first_payment_done";
const CLOUD_MONTHLY_CREDITS: i64 = 50;
const CLOUD_YEARLY_CREDITS: i64 = 600; // 50/月 × 12ヶ月を一括付与
const CREDIT80_CREDITS: i64 = 80;
const FIRST_PAYMENT_BONUS: i64 = 10;

/// Normalizes the key prefix to uppercase while preserving the base64url body.
fn normalize_key_prefix(key: &str) -> String {
    if let Some(pos) = key.find('-') {
        format!("{}{}", key[..pos].to_uppercase(), &key[pos..])
    } else {
        key.to_uppercase()
    }
}

#[derive(serde::Serialize)]
pub struct LicenseStatus {
    pub tier: String,
    pub cloud_credits: i64,
    pub has_key: bool,
    pub cloud_expires_at: Option<String>, // "YYYY-MM" for CloudMonthly, None otherwise
}

/// Returned from activate_license so the frontend can show a bonus notification.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivationResult {
    pub license: LicenseStatus,
    /// Credits granted as a first-payment welcome bonus (0 if not applicable).
    pub first_payment_bonus: i64,
}

#[tauri::command]
pub fn activate_license(app: AppHandle, key: String) -> Result<ActivationResult, String> {
    let info = validate_key(&key)?;

    let store = app.store(STORE_PATH)
        .map_err(|e| format!("設定の読み込みに失敗しました: {}", e))?;

    let is_first_payment = !store.get(KEY_FIRST_PAYMENT_DONE)
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    let mut first_payment_bonus = 0i64;

    match &info.tier {
        LicenseTier::ProLifetime => {
            store.set(KEY_LICENSE_TIER, serde_json::json!("pro"));
            store.set(KEY_LICENSE_KEY, serde_json::json!(&info.raw_key));

            if is_first_payment {
                // Welcome bonus: Pro users get cloud credits to try Cloud AI immediately
                let current: i64 = store.get(KEY_CLOUD_CREDITS)
                    .and_then(|v| v.as_i64())
                    .unwrap_or(0);
                store.set(KEY_CLOUD_CREDITS, serde_json::json!(current + FIRST_PAYMENT_BONUS));
                store.set(KEY_FIRST_PAYMENT_DONE, serde_json::json!(true));
                first_payment_bonus = FIRST_PAYMENT_BONUS;
            }
        }
        LicenseTier::CloudMonthly { .. } => {
            // Prevent re-activating the identical key to reset credits (C-01: compare normalized key)
            let current_key = store.get(KEY_LICENSE_KEY)
                .and_then(|v| v.as_str().map(|s| s.to_string()));
            let normalized = normalize_key_prefix(&info.raw_key);
            if current_key.as_deref().map(|k| k.eq_ignore_ascii_case(&normalized)).unwrap_or(false) {
                return Err("このVCLOUDキーは既にアクティベート済みです。翌月分のキーを使用してください。".to_string());
            }

            let bonus = if is_first_payment { FIRST_PAYMENT_BONUS } else { 0 };
            store.set(KEY_LICENSE_TIER, serde_json::json!("cloud"));
            store.set(KEY_LICENSE_KEY, serde_json::json!(normalized));
            store.set(KEY_CLOUD_CREDITS, serde_json::json!(CLOUD_MONTHLY_CREDITS + bonus));

            if is_first_payment {
                store.set(KEY_FIRST_PAYMENT_DONE, serde_json::json!(true));
                first_payment_bonus = bonus;
            }
        }
        LicenseTier::CloudYearly { .. } => {
            let current_key = store.get(KEY_LICENSE_KEY)
                .and_then(|v| v.as_str().map(|s| s.to_string()));
            let normalized = normalize_key_prefix(&info.raw_key);
            if current_key.as_deref().map(|k| k.eq_ignore_ascii_case(&normalized)).unwrap_or(false) {
                return Err("このVCLOUDキーは既にアクティベート済みです。".to_string());
            }

            let bonus = if is_first_payment { FIRST_PAYMENT_BONUS } else { 0 };
            store.set(KEY_LICENSE_TIER, serde_json::json!("cloud"));
            store.set(KEY_LICENSE_KEY, serde_json::json!(normalized));
            store.set(KEY_CLOUD_CREDITS, serde_json::json!(CLOUD_YEARLY_CREDITS + bonus));

            if is_first_payment {
                store.set(KEY_FIRST_PAYMENT_DONE, serde_json::json!(true));
                first_payment_bonus = bonus;
            }
        }
        LicenseTier::Credit10 | LicenseTier::Credit30 | LicenseTier::Credit80 => {
            let nonce = info.nonce;
            let used_nonces: Vec<u8> = store.get(KEY_USED_CREDIT_NONCES)
                .and_then(|v| serde_json::from_value(v).ok())
                .unwrap_or_default();

            if used_nonces.contains(&nonce) {
                return Err("このクレジットキーはすでに使用済みです".to_string());
            }

            let add = match &info.tier {
                LicenseTier::Credit10 => 10i64,
                LicenseTier::Credit30 => 30i64,
                LicenseTier::Credit80 => CREDIT80_CREDITS,
                _ => unreachable!(),
            };
            let current: i64 = store.get(KEY_CLOUD_CREDITS)
                .and_then(|v| v.as_i64())
                .unwrap_or(0);
            store.set(KEY_CLOUD_CREDITS, serde_json::json!(current + add));

            let current_tier = store.get(KEY_LICENSE_TIER)
                .and_then(|v| v.as_str().map(|s| s.to_string()))
                .unwrap_or_else(|| "free".to_string());
            if current_tier == "free" {
                store.set(KEY_LICENSE_TIER, serde_json::json!("cloud"));
            }

            let mut updated_nonces = used_nonces;
            updated_nonces.push(nonce);
            store.set(KEY_USED_CREDIT_NONCES, serde_json::to_value(&updated_nonces).unwrap());
        }
    }

    store.save().map_err(|e| format!("設定の保存に失敗しました: {}", e))?;

    Ok(ActivationResult {
        license: build_license_status(&store),
        first_payment_bonus,
    })
}

#[tauri::command]
pub fn get_license_status(app: AppHandle) -> LicenseStatus {
    let Ok(store) = app.store(STORE_PATH) else {
        return LicenseStatus { tier: "free".to_string(), cloud_credits: 0, has_key: false, cloud_expires_at: None };
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

    let cloud_expires_at = if tier == "cloud" {
        raw_key.as_deref()
            .and_then(crate::license::get_cloud_expiry)
            .map(|(year, month)| format!("{}-{:02}", 2020i32 + year as i32, month))
    } else {
        None
    };

    // Also expose 1-year credit expiry (VCREDIT with expiry set)
    // For now cloud_expires_at only covers subscription keys; credits are consumed before expiry

    LicenseStatus { tier, cloud_credits, has_key, cloud_expires_at }
}
