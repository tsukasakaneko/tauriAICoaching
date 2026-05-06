# tauriAICoaching Security Audit Report

**Target:** tsukasakaneko/tauriAICoaching  
**Branch:** claude/investigate-speca-repo-o3ZU2  
**Methodology:** SPECA (Specification-Driven Property Extraction and Code Audit)  
**Date:** 2026-05-06  
**Total Cost:** ~$5.16 USD

---

## Executive Summary

SPECA analyzed 3 specification files (license key validation, authentication/authorization, API security) and generated 35 security properties across 25 subgraphs. After code audit and false-positive review:

| Severity | Count |
|----------|-------|
| Medium   | 1     |
| Informational | 34 |

---

## Findings

### [MEDIUM] M-01 — Optional `expectedState` Allows Silent CSRF Bypass in OAuth Exchange

**Property ID:** PROP-license-key-inv-013  
**Location:** `cli/src/auth/auth.ts` — `exchange()` — Lines 168–188  
**Classification:** CONFIRMED_POTENTIAL  

**Description**

The `exchange` function declares its fourth parameter as `expectedState?: string` (optional). The CSRF guard on line 181 reads:

```typescript
if (expectedState && callback.state !== expectedState) {
  throw new Error("State mismatch");
}
```

When `expectedState` is omitted, the short-circuit evaluation silently skips the check, accepting any OAuth callback state unconditionally.

**Impact**

A caller that invokes `exchange(pasted, verifier, redirectUri)` without supplying `expectedState` would complete an OAuth login regardless of state mismatch. An attacker who tricks the user into pasting an attacker-initiated authorization code (e.g., via a phishing page that mimics the OAuth callback) would bind the session to the attacker's identity rather than the user's.

**Current Exposure**

The sole audited production caller (`cli/src/commands/auth/login.tsx:110`) passes `authn.state` correctly, so no active exploit path exists in the audited code. However, the login.tsx implementation comment explicitly acknowledges additional callers in the "M2" Ink TUI / `speca init` flow outside this codebase, and the exported optional-parameter contract provides no compile-time guarantee that future callers supply state.

**Recommendation**

Make `expectedState` a required parameter, or rename it to `requiredState` and remove the truthiness short-circuit:

```typescript
// Before (unsafe)
if (expectedState && callback.state !== expectedState) { ... }

// After (safe)
if (callback.state !== expectedState) { ... }
```

Alternatively, enforce CSRF validation unconditionally inside `exchange` using the stored nonce, and remove the parameter entirely.

---

## Informational Notes

### I-01 — PROP-license-key-inv-014 & inv-015 (Not a Vulnerability)

Phase 03 classified these as `not-a-vulnerability`. The properties relate to license key expiry checks and tier-code validation; the implementation matches the specification with no exploitable deviation.

### I-02 — 32 out-of-scope Properties

32 of 35 properties could not be verified because the Tauri desktop-app backend (Rust source files in `src-tauri/`) and several TypeScript modules were not present in the cloned workspace at the time of the audit. These include:

- `verify_signature` (Ed25519 — `INV-LIC-001`)
- `activate_license`, `get_cloud_expiry`, `is_expired` (license lifecycle)
- API rate-limiting and token refresh flows

**Action:** Re-run the audit with the full repository workspace cloned into `target_workspace/` to cover these properties.

---

## Audit Pipeline Summary

| Phase | Description | Result |
|-------|-------------|--------|
| 01b | Subgraph Extraction | 25 subgraphs from 3 specs |
| 01e | Security Property Generation | 35 properties |
| 02c | Code Location Pre-resolution | 35 properties resolved |
| 03  | Audit Map Generation | 35 items audited |
| 04  | False-Positive Review | 1 confirmed, 34 informational |
