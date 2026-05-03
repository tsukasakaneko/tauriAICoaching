/// License key generation tool for VALORANT AI Coaching.
///
/// Usage:
///
///   # Generate a new Ed25519 keypair (run once; keep the private key secret)
///   cargo run --bin keygen -- generate-keypair
///
///   # Create a license key (reads LICENSE_PRIVATE_KEY from environment)
///   LICENSE_PRIVATE_KEY=<base64url> cargo run --bin keygen -- create-key --tier pro
///   LICENSE_PRIVATE_KEY=<base64url> cargo run --bin keygen -- create-key --tier cloud   --expiry 2026-12
///   LICENSE_PRIVATE_KEY=<base64url> cargo run --bin keygen -- create-key --tier credit10
///   LICENSE_PRIVATE_KEY=<base64url> cargo run --bin keygen -- create-key --tier credit30
///
/// After generating a keypair, set the public key in your CI environment:
///   GitHub Secret: LICENSE_PUBLIC_KEY = <public key base64url printed above>
///
/// NEVER commit the private key to the repository.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use ed25519_dalek::{SigningKey, Signer};
use rand::rngs::OsRng;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(|s| s.as_str()) {
        Some("generate-keypair") => generate_keypair(),
        Some("create-key") => create_key(&args[2..]),
        _ => {
            eprintln!("Usage:");
            eprintln!("  keygen generate-keypair");
            eprintln!("  keygen create-key --tier pro|cloud|credit10|credit30 [--expiry YYYY-MM]");
            std::process::exit(1);
        }
    }
}

fn generate_keypair() {
    let signing_key = SigningKey::generate(&mut OsRng);
    let verifying_key = signing_key.verifying_key();

    println!("=== Ed25519 Keypair ===");
    println!();
    println!("Private key (keep secret, set as LICENSE_PRIVATE_KEY when issuing keys):");
    println!("  {}", URL_SAFE_NO_PAD.encode(signing_key.to_bytes()));
    println!();
    println!("Public key (set as LICENSE_PUBLIC_KEY GitHub Secret for CI builds):");
    println!("  {}", URL_SAFE_NO_PAD.encode(verifying_key.to_bytes()));
    println!();
    println!("NEVER commit the private key. Store it in a password manager.");
}

fn create_key(args: &[String]) {
    let mut tier = String::new();
    let mut expiry = String::new();
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--tier" => {
                tier = args.get(i + 1).cloned().unwrap_or_default();
                i += 2;
            }
            "--expiry" => {
                expiry = args.get(i + 1).cloned().unwrap_or_default();
                i += 2;
            }
            _ => {
                i += 1;
            }
        }
    }

    let private_key_b64 = std::env::var("LICENSE_PRIVATE_KEY")
        .expect("LICENSE_PRIVATE_KEY env var is required");

    let private_key_bytes = URL_SAFE_NO_PAD.decode(&private_key_b64)
        .expect("Invalid base64url in LICENSE_PRIVATE_KEY");
    let private_key_array: [u8; 32] = private_key_bytes
        .try_into()
        .expect("LICENSE_PRIVATE_KEY must be 32 bytes (43 base64url chars)");
    let signing_key = SigningKey::from_bytes(&private_key_array);

    let (tier_code, prefix, expiry_year, expiry_month) = match tier.as_str() {
        "pro" => (0x01u8, "VCOACH", 0xFFu8, 0xFFu8),
        "cloud" => {
            let (year, month) = parse_expiry(&expiry);
            (0x02u8, "VCLOUD", year, month)
        }
        "credit10" => (0x03u8, "VCREDIT", 0xFFu8, 0xFFu8),
        "credit30" => (0x04u8, "VCREDIT", 0xFFu8, 0xFFu8),
        _ => {
            eprintln!("Unknown tier '{}'. Use: pro, cloud, credit10, credit30", tier);
            std::process::exit(1);
        }
    };

    let nonce: u8 = rand::random();
    let payload = [tier_code, expiry_year, expiry_month, nonce];
    let signature = signing_key.sign(&payload);

    let mut body = Vec::with_capacity(68);
    body.extend_from_slice(&payload);
    body.extend_from_slice(&signature.to_bytes());

    println!("{}-{}", prefix, URL_SAFE_NO_PAD.encode(&body));
}

fn parse_expiry(expiry: &str) -> (u8, u8) {
    if expiry.is_empty() {
        eprintln!("--expiry YYYY-MM is required for cloud tier");
        std::process::exit(1);
    }
    let (year_str, month_str) = expiry.split_once('-')
        .expect("--expiry must be YYYY-MM format");
    let year: u32 = year_str.parse().expect("Invalid year in --expiry");
    let month: u8 = month_str.parse().expect("Invalid month in --expiry");
    if year < 2020 || year > 2275 {
        eprintln!("Year must be between 2020 and 2275");
        std::process::exit(1);
    }
    if month < 1 || month > 12 {
        eprintln!("Month must be 1–12");
        std::process::exit(1);
    }
    ((year - 2020) as u8, month)
}
