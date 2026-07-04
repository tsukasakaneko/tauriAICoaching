use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use ed25519_dalek::{Signature, VerifyingKey, Verifier};

// Ed25519 public key (32 bytes, base64url-encoded without padding).
// Set LICENSE_PUBLIC_KEY env var at build time for production.
// Dev builds without this env var skip signature verification for convenience.
const PUBLIC_KEY_B64: Option<&str> = option_env!("LICENSE_PUBLIC_KEY");

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(tag = "type")]
pub enum LicenseTier {
    ProLifetime,
    CloudMonthly { expiry_year: u8, expiry_month: u8 },
    Credit10,
    Credit30,
    Credit80,
    CloudYearly { expiry_year: u8, expiry_month: u8 },
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub struct LicenseInfo {
    pub tier: LicenseTier,
    pub nonce: u8,
    pub raw_key: String,
}

// Key format: {PREFIX}-{base64url_no_pad(payload[4] + ed25519_sig[64])}
//
// payload layout (4 bytes):
//   [0] tier code: 0x01=ProLifetime, 0x02=CloudMonthly, 0x03=Credit10, 0x04=Credit30
//   [1] expiry_year since 2020 (0xFF = no expiry)
//   [2] expiry_month 1–12      (0xFF = no expiry)
//   [3] nonce (random byte for uniqueness)
//
// 期限の長さは発行側(backend-remote / keygen)にのみ存在し、ここでは payload の
// 年月と現在を比較するだけ。クレジット系(VCREDIT)は発行時+6ヶ月で発行される
// (P0-4: 資金決済法・前払式支払手段の適用除外要件)。既発行の1年キーも
// payload どおり有効なまま互換動作する。
//
// Total decoded: 68 bytes (4 payload + 64 Ed25519 signature)
// Prefixes: VCOACH (0x01), VCLOUD (0x02), VCREDIT (0x03/0x04)
//
// Note: in debug builds without LICENSE_PUBLIC_KEY the signature check is skipped
// so developers can test the activation flow before setting up their keypair.
pub fn validate_key(key: &str) -> Result<LicenseInfo, String> {
    let key = key.trim();

    let dash_pos = key.find('-').ok_or("キーの形式が正しくありません")?;
    let prefix = key[..dash_pos].to_uppercase();
    let body = &key[dash_pos + 1..];

    let decoded = URL_SAFE_NO_PAD.decode(body)
        .map_err(|_| "キーに無効な文字が含まれています".to_string())?;

    if decoded.len() != 68 {
        return Err("キーの長さが正しくありません".to_string());
    }

    let payload = &decoded[0..4];
    let sig_bytes: &[u8; 64] = decoded[4..68]
        .try_into()
        .map_err(|_| "内部エラー: 署名サイズが不正です".to_string())?;

    verify_signature(payload, sig_bytes)?;

    let tier_code = payload[0];
    let expiry_year = payload[1];
    let expiry_month = payload[2];
    let nonce = payload[3];

    let tier = match (tier_code, prefix.as_str()) {
        (0x01, "VCOACH") => LicenseTier::ProLifetime,
        (0x02, "VCLOUD") => {
            if expiry_year != 0xFF && expiry_month != 0xFF
                && is_expired(expiry_year, expiry_month)
            {
                return Err("このキーは有効期限切れです".to_string());
            }
            LicenseTier::CloudMonthly { expiry_year, expiry_month }
        }
        (0x06, "VCLOUD") => {
            if is_expired(expiry_year, expiry_month) {
                return Err("このキーは有効期限切れです".to_string());
            }
            LicenseTier::CloudYearly { expiry_year, expiry_month }
        }
        (0x03, "VCREDIT") => {
            if expiry_year != 0xFF && expiry_month != 0xFF
                && is_expired(expiry_year, expiry_month)
            {
                return Err("このクレジットキーは有効期限切れです".to_string());
            }
            LicenseTier::Credit10
        }
        (0x04, "VCREDIT") => {
            if expiry_year != 0xFF && expiry_month != 0xFF
                && is_expired(expiry_year, expiry_month)
            {
                return Err("このクレジットキーは有効期限切れです".to_string());
            }
            LicenseTier::Credit30
        }
        (0x05, "VCREDIT") => {
            if expiry_year != 0xFF && expiry_month != 0xFF
                && is_expired(expiry_year, expiry_month)
            {
                return Err("このクレジットキーは有効期限切れです".to_string());
            }
            LicenseTier::Credit80
        }
        _ => return Err("キーの形式が正しくありません".to_string()),
    };

    Ok(LicenseInfo {
        tier,
        nonce,
        raw_key: key.to_string(),
    })
}

fn verify_signature(payload: &[u8], sig_bytes: &[u8; 64]) -> Result<(), String> {
    match PUBLIC_KEY_B64 {
        Some(pub_key_b64) => {
            let pub_key_bytes = URL_SAFE_NO_PAD.decode(pub_key_b64)
                .map_err(|_| "内部エラー: 公開鍵が不正です".to_string())?;
            let pub_key_array: &[u8; 32] = pub_key_bytes.as_slice()
                .try_into()
                .map_err(|_| "内部エラー: 公開鍵のサイズが不正です".to_string())?;
            let verifying_key = VerifyingKey::from_bytes(pub_key_array)
                .map_err(|_| "内部エラー: 公開鍵の読み込みに失敗しました".to_string())?;
            let signature = Signature::from_bytes(sig_bytes);
            verifying_key.verify(payload, &signature)
                .map_err(|_| "キーが無効です".to_string())
        }
        None => {
            if cfg!(debug_assertions) {
                Ok(()) // Dev builds without LICENSE_PUBLIC_KEY: skip verification
            } else {
                Err("内部エラー: LICENSE_PUBLIC_KEY が設定されていません".to_string())
            }
        }
    }
}

/// Returns `(expiry_year_since_2020, expiry_month)` for a CloudMonthly or CloudYearly key, or `None`.
pub fn get_cloud_expiry(raw_key: &str) -> Option<(u8, u8)> {
    let key = raw_key.trim();
    let dash_pos = key.find('-')?;
    let body = &key[dash_pos + 1..];
    let decoded = URL_SAFE_NO_PAD.decode(body).ok()?;
    if decoded.len() != 68 { return None; }
    if decoded[0] != 0x02 && decoded[0] != 0x06 { return None; } // Not a cloud subscription
    let expiry_year = decoded[1];
    let expiry_month = decoded[2];
    if expiry_year == 0xFF { return None; } // No expiry
    Some((expiry_year, expiry_month))
}

/// Returns `true` if a stored CloudMonthly raw key has passed its expiry month.
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
    now.year() > key_year || (now.year() == key_year && now.month() > key_month)
}
