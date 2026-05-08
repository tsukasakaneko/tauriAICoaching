# License Key Validation Specification — tauriAICoaching

## Overview

The license subsystem controls feature access tiers for the tauriAICoaching desktop application.
A license key encodes a tier, an optional expiry date, and a random nonce, all signed with an
Ed25519 private key held exclusively by the vendor. The application validates keys at activation
time and may re-check subscription expiry at runtime.

## Key Format

A license key has the format:

```
{PREFIX}-{base64url_no_pad(payload[4] ‖ ed25519_sig[64])}
```

- Total decoded length: **exactly 68 bytes** (4 payload + 64 signature).
- Prefix is case-insensitive and must match the tier code in payload[0].

### Payload Layout (4 bytes)

| Byte | Name          | Meaning                                                   |
|------|---------------|-----------------------------------------------------------|
| [0]  | `tier_code`   | 0x01 = ProLifetime, 0x02 = CloudMonthly, 0x03 = Credit10, 0x04 = Credit30 |
| [1]  | `expiry_year` | Years since 2020; 0xFF = no expiry                        |
| [2]  | `expiry_month`| Month 1–12; 0xFF = no expiry                              |
| [3]  | `nonce`       | Random byte for uniqueness                                |

### Valid Prefix → Tier Mapping

| Prefix    | Tier Code | Description          |
|-----------|-----------|----------------------|
| VCOACH    | 0x01      | Pro Lifetime         |
| VCLOUD    | 0x02      | Cloud Monthly        |
| VCREDIT   | 0x03      | Credit 10            |
| VCREDIT   | 0x04      | Credit 30            |

Any other (prefix, tier_code) combination MUST be rejected.

## Invariants

### INV-LIC-001: Signature Verification is Mandatory in Production

**In any production build**, every call to `validate_key` MUST verify the Ed25519 signature of
the payload before granting any license tier. A key MUST be rejected if:
- The signature is missing or malformed.
- The public key (`LICENSE_PUBLIC_KEY`) is absent.
- Signature verification fails cryptographically.

A debug-only bypass (skipping verification when `LICENSE_PUBLIC_KEY` is absent in `debug_assertions`
builds) is acceptable ONLY when `cfg!(debug_assertions)` is true. Release builds compiled without
`debug_assertions` MUST NOT skip verification regardless of environment.

### INV-LIC-002: Prefix–Tier Consistency

The decoded `tier_code` in payload[0] and the key prefix MUST be checked together. A key with
prefix VCOACH but tier_code 0x02 MUST be rejected, and vice versa. Neither field alone is
sufficient to determine the tier.

### INV-LIC-003: CloudMonthly Expiry Check

For tier_code 0x02 (CloudMonthly), if both `expiry_year` and `expiry_month` are not 0xFF, the
key MUST be rejected if the current local date is strictly after the last day of the expiry
month in year `2020 + expiry_year`. The comparison MUST be:
```
now.year() > key_year || (now.year() == key_year && now.month() > key_month)
```
Keys where either `expiry_year` or `expiry_month` is 0xFF are treated as non-expiring.

### INV-LIC-004: No Signature Bypass for Helper Functions

Functions that decode and inspect a stored raw key (e.g., `get_cloud_expiry`,
`cloud_subscription_expired`) MUST NOT be used to grant elevated privileges or override
a previously completed validation. These helpers read only the payload bytes and do NOT
re-verify the signature — they are safe for re-checking expiry on an **already-validated** key,
but MUST NOT be used as a substitute for `validate_key` on an untrusted input.

### INV-LIC-005: Exact Length Enforcement

Any decoded key that is not exactly 68 bytes MUST be rejected before any further parsing.
Partial or over-length keys must not be accepted.

### INV-LIC-006: No Replay / Key Isolation

Each (tier, nonce) pair represents a unique activation. The nonce byte in payload[3] is a
random byte that gives uniqueness but does NOT itself prevent replay. The application MUST
store and compare the raw key string at the application layer (Tauri store) to detect reuse.

## Pre-conditions

- **Pre-LIC-001:** Input to `validate_key` is an untrusted string from the user.
- **Pre-LIC-002:** The `LICENSE_PUBLIC_KEY` build-time constant is a valid 32-byte Ed25519
  verifying key encoded as base64url (no padding).

## Post-conditions

- **Post-LIC-001:** A successful return from `validate_key` guarantees:
  1. The key was signed by the private key corresponding to `LICENSE_PUBLIC_KEY`.
  2. The prefix matches the tier code.
  3. For CloudMonthly keys: the key is not expired at the time of validation.
  4. Decoded length is exactly 68 bytes.
- **Post-LIC-002:** An error return from `validate_key` carries a human-readable Japanese
  error message and MUST NOT grant any license tier.

## Threat Model

| Threat                         | Attack Vector                                  | Mitigated By                        |
|-------------------------------|------------------------------------------------|-------------------------------------|
| Forged key                    | Attacker creates a plausible key string        | Ed25519 signature verification      |
| Expired subscription bypass   | Manipulating system clock or expiry bytes      | `is_expired` check at validation    |
| Debug bypass in production    | Build without public key set                   | Release-mode guard in `verify_signature` |
| Tier escalation               | Mismatched prefix/tier_code                    | Pair validation in `validate_key`   |
| Replay attack                 | Submitting previously used key                 | Application-layer storage and comparison |
