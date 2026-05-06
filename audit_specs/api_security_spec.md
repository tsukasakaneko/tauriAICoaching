# API Security Specification — tauriAICoaching

## Overview

This document specifies the security requirements for the tauriAICoaching API surface, covering
the AI provider integration (Rust/Tauri layer), the backend coaching routes, and the auto-record
subsystem.

## AI Provider Security (Rust)

The AI provider module (`ai_provider.rs`) dispatches coaching requests to either Anthropic Claude
(cloud mode) or a local Ollama instance. Both dispatch paths handle user-supplied configuration
values and must not introduce server-side request forgery (SSRF), key leakage, or injection risks.

### INV-AI-001: API Key Confidentiality

The Claude API key (`claude_api_key` in `AiConfig`) MUST NOT be:
- Logged in plain text to any log output.
- Returned to the frontend in any API response.
- Included in error messages that propagate to the user interface.

The key is stored in the Tauri store (encrypted by the OS keychain or Tauri's secure storage)
and passed directly to the `x-api-key` header of outbound Anthropic API requests. It MUST NOT
be serialized into any file or IPC response that the frontend JavaScript can inspect.

### INV-AI-002: Ollama URL Validation

The `ollama_url` in `AiConfig` is provided by the user via the settings UI. Before constructing
and sending an HTTP request to `{ollama_url}/api/chat` or `{ollama_url}/api/tags`, the URL MUST
be validated to prevent SSRF:
- The scheme MUST be `http` or `https`.
- The host MUST resolve to `127.0.0.1` or `::1` (loopback), or to a private-range address
  within RFC 1918 / RFC 4193 if the user explicitly configures a LAN Ollama server.
- Requests to non-loopback, non-private addresses that were not explicitly configured MUST be
  rejected with an error before the request is sent.

### INV-AI-003: Claude API Error Isolation

HTTP error responses from the Claude API (status ≥ 400) MUST NOT be forwarded verbatim to the
frontend. At a minimum:
- The raw response body from a 4xx/5xx Anthropic API error SHOULD be logged server-side only.
- The frontend MUST receive a sanitized, user-readable error message.
- API keys MUST NOT appear in error message strings, even if Anthropic includes them in error
  responses (they should not, but defensive stripping is required).

### INV-AI-004: Response JSON Validation

The JSON response from both Claude and Ollama MUST be validated against the expected
`CoachingReport` schema before being returned to the frontend. Unexpected fields MUST be
dropped; missing required fields MUST cause a structured error return, not a panic or
unstructured crash.

## Backend Coaching Routes

### INV-COACH-001: Authentication Required

All coaching endpoints (`POST /analyze`, etc.) MUST require a valid JWT from the authenticated
user. Unauthenticated requests MUST receive HTTP 401 before any AI call or file processing
occurs. AI API costs MUST NOT be incurred for unauthenticated requests.

### INV-COACH-002: Request Size Limiting

Incoming request bodies MUST be limited in size (default: 1 MB via `express.json({ limit: "1mb" })`).
Video file uploads, if supported, MUST enforce a separate, explicit file-size limit via middleware
before the file is written to disk or memory. Exceeding the limit MUST return HTTP 413.

### INV-COACH-003: Input Sanitization for AI Prompts

User-supplied fields (rank, agent name, self-assessment text, map name) that are interpolated into
AI prompts MUST be treated as untrusted content. While prompt injection cannot be fully prevented,
the following mitigations MUST be applied:
- Maximum length limits per field (e.g., free-text ≤ 1000 characters).
- Any structural delimiters used to build the prompt MUST NOT be injectable by user input
  (i.e., use a templating layer that escapes or segregates user content).

## Auto-Record Subsystem

### INV-AR-001: File Path Validation

File paths derived from user configuration (recording output directory, video file paths) MUST
be validated before use:
- Paths MUST be resolved to absolute form and checked against an allowlist of safe parent
  directories (e.g., user's home directory, configured output directory).
- Path traversal sequences (`../`, `..\\`) MUST be rejected or canonicalized away.
- The application MUST NOT write recording files to system-critical directories
  (e.g., `/etc`, `C:\Windows`).

### INV-AR-002: Process Execution Safety (FFmpeg)

When launching FFmpeg or other subprocesses:
- Command-line arguments MUST NOT be constructed by concatenating user-supplied strings.
- Arguments MUST be passed as a list (array of strings), not as a shell command string, to
  prevent shell injection.
- If a shell is used (`exec` with string), user-supplied values MUST be escaped.

### INV-AR-003: Resource Limits

Long-running recording processes MUST be bounded:
- Maximum recording duration MUST be enforced to prevent disk exhaustion.
- Temporary files created during analysis MUST be cleaned up (deleted) after processing,
  regardless of whether the analysis succeeded or failed.

## Threat Model

| Threat                         | Vector                                        | Mitigated By                            |
|-------------------------------|-----------------------------------------------|-----------------------------------------|
| API key exfiltration          | Frontend JS reads IPC response                | Key excluded from all responses         |
| SSRF via Ollama URL           | Attacker sets ollama_url to internal service  | URL host validation                     |
| Prompt injection              | Malicious user-supplied coaching text         | Length limits + content segregation     |
| Path traversal                | Recording output path with `../`              | Path canonicalization + allowlist       |
| Shell injection in FFmpeg     | Malicious filename or config value            | Argument arrays, no shell concatenation |
| Unauthenticated AI calls      | Direct API requests without token            | JWT middleware on all coaching routes   |
| Request body bomb             | Huge JSON payload                             | 1 MB body limit                         |
