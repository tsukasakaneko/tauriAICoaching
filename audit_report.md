# tauriAICoaching Security Audit Report

**Target:** tsukasakaneko/tauriAICoaching  
**Branch:** claude/investigate-speca-repo-o3ZU2  
**Methodology:** SPECA (Specification-Driven Property Extraction and Code Audit)  
**Date:** 2026-05-06  
**Total Cost:** ~$5.16 USD

> **Audit Note:** The initial SPECA run did not clone the target repository into
> `target_workspace/`, so Phase 03 fell back to analyzing SPECA's own CLI code
> instead of tauriAICoaching. The Medium CSRF finding in the original report was
> therefore invalid (it described a SPECA-internal vendored module). This
> corrected report reflects manual code review of the actual tauriAICoaching
> sources alongside the SPECA-generated property checklist.

---

## Executive Summary

Three specification files were audited (license key validation, authentication/authorization, API security), producing 35 security properties across 25 subgraphs. Manual code verification of the actual sources against these properties found:

| Severity | Count |
|----------|-------|
| Medium   | 1     |
| Informational | 2 |
| Not a Vulnerability | 2 |

---

## Findings

### [MEDIUM] M-01 — Missing SSRF Validation on User-Configurable Ollama URL

**Property ID:** INV-AI-002  
**Location:** `src-tauri/src/ai_provider.rs` — `call_ollama()` line 172, `test_ollama_connection()` line 256  
**Related command:** `src-tauri/src/commands/ai.rs` — `set_ai_config()` / `test_ollama()`

**Description**

`AiConfig.ollama_url` is a plain `String` that users can set freely through the settings UI. It is used without any host or scheme validation:

```rust
// ai_provider.rs:172
let url = format!("{}/api/chat", base_url);

// ai_provider.rs:256
let tags_url = format!("{}/api/tags", url.trim_end_matches('/'));
```

Because `set_ai_config` stores any URL the frontend sends and `test_ollama` fires a request to any URL passed in, an attacker who can write to the settings store (e.g. via a malicious extension, XSS in the Tauri webview, or local access) can redirect Ollama requests to arbitrary internal services.

**Impact**

Server-Side Request Forgery (SSRF): internal services that are not exposed externally (metadata endpoints, other localhost services) can be probed or interacted with using the Tauri process's network privileges.

**Recommendation**

Validate `ollama_url` before saving and before use: only allow `http`/`https` scheme with a host that is loopback (`127.0.0.0/8`, `::1`, `localhost`) or RFC-1918 private range (`10/8`, `172.16/12`, `192.168/16`).

---

## Informational Notes

### I-01 — PROP-license-key-inv-014 & inv-015 (Not a Vulnerability)

Properties relate to license key expiry checks and tier-code validation. Manual review of `src-tauri/src/license.rs` confirms the implementation matches the specification with no exploitable deviation.

### I-02 — 32 Properties Unverified Due to Missing `target_workspace/` Clone

The SPECA pipeline's `target_workspace/` was never populated, so 32 of 35 properties could not be verified automatically. Manual review confirmed the following invariants hold in code:

- All 9 auth invariants (`backend/routes/auth.js`, `backend/server.js`) ✅
- All 6 license invariants (`src-tauri/src/license.rs`) ✅
- 9 of 10 API security invariants — **INV-AI-002 (Ollama URL validation) is unimplemented** ❌

**Action:** Re-run SPECA with `target_workspace/` cloned to get automated coverage for the remaining properties.

---

## Audit Pipeline Summary

| Phase | Description | Result |
|-------|-------------|--------|
| 01b | Subgraph Extraction | 25 subgraphs from 3 specs |
| 01e | Security Property Generation | 35 properties |
| 02c | Code Location Pre-resolution | 35 properties resolved |
| 03  | Audit Map Generation | 35 items audited (wrong workspace) |
| 04  | False-Positive Review | Manual review substituted |
