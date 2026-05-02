use hmac::{Hmac, Mac};
use sha2::Sha256;

type HmacSha256 = Hmac<Sha256>;

// Injected at compile time via LICENSE_HMAC_SECRET env var.
// Falls back to a dev-only placeholder; production builds MUST set the env var.
const HMAC_SECRET: &[u8] = match option_env!("LICENSE_HMAC_SECRET") {
    Some(s) => s.as_bytes(),
    None => b"dev-only-insecure-secret-not-for-production",
};

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(tag = "type")]
pub enum LicenseTier {
    ProLifetime,
    CloudMonthly { expiry_year: u8, expiry_month: u8 },
    Credit10,
    Credit30,
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub struct LicenseInfo {
    pub tier: LicenseTier,
    pub nonce: u8,
    pub raw_key: String,
}

// Key format: {PREFIX}-{XXXXXXXX}-{XXXXXXXX}
// 16 hex chars total = 8 bytes:
//   [0]    tier code (0x01=pro_lifetime, 0x02=cloud_monthly, 0x03=credit_10, 0x04=credit_30)
//   [1]    expiry_year since 2020 (0xFF = no expiry)
//   [2]    expiry_month 1-12 (0xFF = no expiry)
//   [3]    nonce (random byte for uniqueness)
//   [4..8] first 4 bytes of HMAC-SHA256(secret, bytes[0..4])
//
// Prefixes: VCOACH (0x01), VCLOUD (0x02), VCREDIT (0x03/0x04)
pub fn validate_key(key: &str) -> Result<LicenseInfo, String> {
    let key = key.trim().to_uppercase();
    let parts: Vec<&str> = key.split('-').collect();

    if parts.len() < 3 {
        return Err("キーの形式が正しくありません".to_string());
    }

    let prefix = parts[0];
    let hex_body: String = parts[1..].join("");

    if hex_body.len() != 16 {
        return Err("キーの長さが正しくありません".to_string());
    }

    let body_bytes = hex::decode(&hex_body)
        .map_err(|_| "キーに無効な文字が含まれています".to_string())?;

    let tier_code = body_bytes[0];
    let expiry_year = body_bytes[1];
    let expiry_month = body_bytes[2];
    let nonce = body_bytes[3];
    let sig_given = &body_bytes[4..8];

    // Verify HMAC signature
    let mut mac = HmacSha256::new_from_slice(HMAC_SECRET)
        .map_err(|_| "内部エラー: HMAC初期化失敗".to_string())?;
    mac.update(&body_bytes[0..4]);
    let sig_computed = mac.finalize().into_bytes();

    if sig_computed[0..4] != *sig_given {
        return Err("キーが無効です".to_string());
    }

    // Verify prefix matches tier code
    let tier = match (tier_code, prefix) {
        (0x01, "VCOACH") => LicenseTier::ProLifetime,
        (0x02, "VCLOUD") => {
            if expiry_year != 0xFF && expiry_month != 0xFF {
                if is_expired(expiry_year, expiry_month) {
                    return Err("このキーは有効期限切れです".to_string());
                }
            }
            LicenseTier::CloudMonthly { expiry_year, expiry_month }
        }
        (0x03, "VCREDIT") => LicenseTier::Credit10,
        (0x04, "VCREDIT") => LicenseTier::Credit30,
        _ => return Err("キーの形式が正しくありません".to_string()),
    };

    Ok(LicenseInfo {
        tier,
        nonce,
        raw_key: key.to_string(),
    })
}

/// Returns `(expiry_year_since_2020, expiry_month)` for a CloudMonthly key, or `None`
/// for keys with no expiry or if the key cannot be parsed.
pub fn get_cloud_expiry(raw_key: &str) -> Option<(u8, u8)> {
    let key = raw_key.trim().to_uppercase();
    let parts: Vec<&str> = key.split('-').collect();
    if parts.len() < 3 { return None; }
    let hex_body: String = parts[1..].join("");
    if hex_body.len() != 16 { return None; }
    let Ok(body_bytes) = hex::decode(&hex_body) else { return None; };
    if body_bytes[0] != 0x02 { return None; } // Not a CloudMonthly key
    let expiry_year = body_bytes[1];
    let expiry_month = body_bytes[2];
    if expiry_year == 0xFF { return None; } // Permanent — no expiry
    Some((expiry_year, expiry_month))
}

/// Returns `true` if a stored CloudMonthly raw key has passed its expiry month.
/// Non-cloud keys always return `false` (they don't expire this way).
pub fn cloud_subscription_expired(raw_key: &str) -> bool {
    match get_cloud_expiry(raw_key) {
        Some((year, month)) => is_expired(year, month),
        None => false,
    }
}

fn is_expired(expiry_year_since_2020: u8, expiry_month: u8) -> bool {
    use chrono::{Datelike, Local};
    let now = Local::now();
    let key_year = 2020i32 + expiry_year_since_2020 as i32;
    let key_month = expiry_month as u32;
    // Key is valid through the end of key_month; expired when current month is past it
    now.year() > key_year || (now.year() == key_year && now.month() > key_month)
}
