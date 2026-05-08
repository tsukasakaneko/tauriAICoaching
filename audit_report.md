# tauriAICoaching Security Audit Report

**Target:** tsukasakaneko/tauriAICoaching  
**Branch:** claude/investigate-speca-repo-o3ZU2  
**Methodology:** SPECA (Specification-Driven Property Extraction and Code Audit)  
**Date:** 2026-05-08  
**Total API Cost:** ~$16 USD

---

## Executive Summary

SPECA analyzed 3 specification files (license key validation, authentication/authorization, API security) and generated 35 security properties across 25 subgraphs. After re-running with the actual codebase in `target_workspace/`:

| Severity | Count |
|----------|-------|
| Critical | 3 |
| High     | 2 |
| Medium   | 5 |
| Informational | 25 |

---

## Confirmed Vulnerabilities

### [CRITICAL] C-01 — License Credit Multiplication via Case-Sensitive Duplicate Guard Bypass

**Property:** PROP-license-key-inv-011  
**Location:** `src-tauri/src/commands/license.rs:64`

The duplicate-key guard for VCLOUD (CloudMonthly) keys is case-sensitive. A user who activates `VCLOUD-<body>` (receiving 30 credits) can exhaust them and resubmit the identical key as `vcloud-<body>` via the `activate_license` Tauri IPC. The `==` comparison misses the stored key and writes another 30 credits.

**Fix:** Normalize the incoming key to uppercase before the duplicate check (or compare with `.eq_ignore_ascii_case()`).

---

### [CRITICAL] C-02 — Known Default JWT Secret in Remote Backend

**Property:** PROP-license-key-pre-001  
**Location:** `backend-remote/server.js:10-13`

The local backend (`backend/server.js`) validates `JWT_SECRET` length ≥ 32 on startup and calls `process.exit(1)` if it matches the placeholder. The remote production backend (`backend-remote/server.js`) has no such check. A developer who copies `.env.example` without changing `JWT_SECRET` deploys with a publicly known signing secret; an attacker can forge valid JWTs for any user ID.

**Fix:** Add the same startup guard to `backend-remote/server.js`, and rotate the secret if already deployed with the default.

---

### [CRITICAL] C-03 — Free Users Can Access Paid Autorecord / AI Analysis

**Property:** PROP-license-key-inv-018  
**Location:** `backend/routes/autorecord.js:200`

`POST /autorecord/start` only checks `requireAuth` (valid JWT), not whether `is_paid = 1`. A free-tier user with a valid JWT can trigger screen recording; when a match ends, `analyzeVideo` fires an Anthropic API call at the server's expense without any license enforcement.

**Fix:** Add an `is_paid` check (or license-tier middleware) to all `/autorecord/*` routes before any processing.

---

### [HIGH] H-01 — Tauri Settings Store World-Readable (Claude API Key Exposed)

**Properties:** PROP-license-key-inv-025, PROP-license-key-inv-015  
**Location:** `src-tauri/src/commands/ai.rs` — `store.save()`

`settings.json` is created with the system's default umask (typically `0o644`). On multi-user Linux systems, any co-tenant process running as the same UID (or with filesystem read access) can read `~/.local/share/tauriAICoaching/settings.json` and extract the plaintext `claude_api_key` and `license_key`. No `set_permissions(0o600)` is applied after store initialization.

**Fix:** After opening the store, set file permissions to `0o600` using `std::fs::set_permissions`. Use an atomic write (write to temp file then `rename`) to avoid corruption on crash.

---

### [HIGH] H-02 — Login Timing Side-Channel Enables User Enumeration

**Property:** PROP-license-key-post-001  
**Location:** `backend/routes/auth.js:84-108`

`POST /auth/login` returns in ~1ms when the email is not found (early return before bcrypt) and ~100ms when the email exists but the password is wrong (bcrypt compare). An attacker sending requests from multiple IPs (bypassing per-IP rate limiting) can reliably enumerate registered email addresses by measuring response latency.

**Fix:** Always run `bcrypt.compare` against a dummy hash when the user is not found, equalizing timing for both branches.

---

### [MEDIUM] M-01 — `rank` Field Bypasses Input Validation (Prompt Injection)

**Property:** PROP-license-key-inv-020  
**Location:** `backend/routes/coaching.js:88-90, 149`

`agent`, `review`, and `selfAssessment` fields all have explicit type guards and length caps (lines 100–111). The `rank` field has only a falsy presence check and is then interpolated verbatim into the Anthropic user-turn prompt at line 149 with no length or type constraint. An attacker can inject instructions via a crafted `rank` value to manipulate the AI's coaching response.

**Fix:** Add `typeof rank === 'string' && rank.length <= MAX_RANK_LEN` validation, consistent with the other fields.

---

### [MEDIUM] M-02 — Ollama Request Has No Timeout (DoS)

**Property:** PROP-license-key-pre-004  
**Location:** `src-tauri/src/ai_provider.rs` — `call_ollama()`, `test_ollama_connection()`

`reqwest` HTTP requests to the Ollama server are sent with no timeout. A stalled or malicious local server that accepts the TCP connection but never responds will block the Tokio async task at `.send().await` or `.json().await` indefinitely, permanently starving the coaching worker and preventing further `ai_analyze` commands.

**Fix:** Add `.timeout(Duration::from_secs(60))` to the `reqwest::Client` builder or per-request.

---

### [MEDIUM] M-03 — Ollama URL DNS Rebinding Bypass

**Property:** PROP-license-key-pre-005  
**Location:** `src-tauri/src/ai_provider.rs` — `validate_ollama_url()`

The IP-based validation added in this audit cycle can be bypassed by a local attacker who modifies `/etc/hosts` to remap `localhost` to an internal network address before triggering an AI analysis. The validation checks the configured string at save time but the HTTP client resolves DNS at dispatch time.

**Fix:** Resolve the configured hostname to an IP at validation time (or at dispatch time) and reject any resolved IP that is not loopback or private range. Alternatively, always pass `127.0.0.1` directly and disallow hostname entries.

---

### [MEDIUM] M-04 — XSS → AI API Cost Amplification

**Property:** PROP-license-key-inv-017  
**Location:** `src-tauri/src/commands/ai.rs` — `ai_analyze`; CSP configuration

The Tauri webview's Content Security Policy permits `unsafe-inline` scripts. A webview-side XSS can invoke `ai_analyze` with arbitrarily large `review` or `selfAssessment` arrays; the oversized prompt is forwarded directly to the Claude/Ollama API endpoint, enabling API cost amplification at the owner's expense.

**Fix:** Remove `unsafe-inline` from the CSP and enforce nonce-based script loading; also add server-side total prompt size validation in `ai_analyze`.

---

### [MEDIUM] M-05 — Ollama SSRF via User-Configurable URL *(partially mitigated)*

**Property:** PROP-license-key-inv-014 (via INV-AI-002)  
**Location:** `src-tauri/src/ai_provider.rs` — `validate_ollama_url()`

**Status:** IP-based validation was added in this audit cycle (commit `307b401`). Requests to public IPs are now rejected. Residual risk: DNS rebinding (see M-03) and the absence of dispatch-time IP re-verification.

---

## Informational

25 properties were classified as `out-of-scope`, `no-finding`, or otherwise not actionable (invariants already satisfied in code). Notable confirmed-not-vulnerable items:

- Ed25519 signature verification mandatory in production builds (`license.rs:86-108`) ✅
- bcrypt with SALT_ROUNDS=12 for password hashing ✅
- JWT payload minimality (only `{id}` signed) ✅
- Rate limiting on auth routes (5 req / 15 min per IP) ✅
- CORS restricted to Tauri origins ✅
- SQL injection via prepared statements ✅

---

## Audit Pipeline Summary

| Phase | Description | Result |
|-------|-------------|--------|
| 01b | Subgraph Extraction | 25 subgraphs from 3 specs |
| 01e | Security Property Generation | 35 properties |
| 02c | Code Location Pre-resolution | 33/35 resolved (2 not found) |
| 03  | Audit Map Generation | 35/35 audited |
| 04  | False-Positive Review | 8 confirmed, 2 potential, 25 informational |
