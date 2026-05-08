# Authentication & Authorization Specification — tauriAICoaching Backend

## Overview

The tauriAICoaching backend (Express.js) provides an HTTP API consumed exclusively by the local
Tauri desktop application. Authentication uses JSON Web Tokens (JWT) issued at login/registration
and presented as Bearer tokens on subsequent requests.

The server runs on `127.0.0.1` (loopback only), so the network attack surface is limited to the
local machine. However, because the Tauri webview origin is allowed by CORS, injection vulnerabilities
in the frontend could still target the API.

## Authentication Flow

1. Client calls `POST /auth/register` with `{ email, password }`.
2. Server validates inputs, hashes password with bcrypt (12 rounds), inserts user.
3. Server issues a JWT signed with `JWT_SECRET` (env var, ≥ 32 chars), expiry 7 days.
4. Client stores JWT and sends it as `Authorization: Bearer <token>` on every protected request.
5. Protected routes verify the token via middleware before processing the request.

## Invariants

### INV-AUTH-001: JWT Secret Minimum Entropy

`JWT_SECRET` MUST be at least 32 characters long. The server MUST abort startup (`process.exit(1)`)
if `JWT_SECRET` is absent or shorter than 32 characters. This check MUST run before any route is
registered to prevent a race where a request arrives before the check fires.

### INV-AUTH-002: Token Payload Minimality

JWT payloads MUST contain only an opaque user ID (`id`). Sensitive data (email, password hash,
tier, is_paid flag) MUST NOT be embedded in the token. All user attributes MUST be retrieved
from the database on each authenticated request.

### INV-AUTH-003: Password Hashing

Passwords MUST be hashed with bcrypt at a cost factor of at least 10. Plain-text passwords MUST
NOT be stored in the database or logged. Timing-safe comparison (`bcrypt.compare`) MUST be used
for login verification; direct string comparison is forbidden.

### INV-AUTH-004: Rate Limiting on Auth Endpoints

Both `/auth/login` and `/auth/register` MUST be protected by a rate-limiter that rejects
excessive requests from a single IP. The limiter MUST:
- Track attempts per IP within a sliding or fixed window.
- Return HTTP 429 when the limit is exceeded.
- Reset the counter after the window expires.

The rate limiter MUST count ALL requests to the endpoint (not only failed ones), to prevent
enumeration attacks that succeed on the first attempt.

### INV-AUTH-005: CORS Restriction

The CORS policy MUST allow only the listed Tauri origins:
- `tauri://localhost`
- `https://tauri.localhost`
- `http://localhost:1420`
- `http://localhost`

Any other origin MUST be rejected with an appropriate CORS error. The wildcard origin (`*`)
MUST NOT be permitted.

### INV-AUTH-006: Authentication Middleware Coverage

Every route that accesses user-specific data or performs privileged operations MUST be
protected by JWT authentication middleware. Unauthenticated requests to protected routes
MUST receive HTTP 401 before any database query or business logic executes.

### INV-AUTH-007: Email Validation

Registered emails MUST pass a basic structural validation (at minimum: contains exactly one `@`,
non-empty local and domain parts). This check prevents obviously malformed inputs from reaching
the database, but it is not a substitute for email verification.

### INV-AUTH-008: No User Enumeration via Login Timing

The login handler MUST return the same response body and status code (`401 Unauthorized`) for
both "user not found" and "wrong password" cases, with indistinguishable response timing.
User-distinguishing messages (e.g., "no such user" vs. "wrong password") MUST NOT be returned.

### INV-AUTH-009: No Sensitive Data in Logs

The server MUST NOT log JWT tokens, raw passwords, or full email addresses in production-visible
log output (`console.log`, `console.error`).

## Pre-conditions

- **Pre-AUTH-001:** `JWT_SECRET` is set in the environment before the process starts.
- **Pre-AUTH-002:** `bcryptjs` is used for password hashing (not MD5, SHA-1, or plain SHA-256).
- **Pre-AUTH-003:** The SQLite database (`db.js`) uses parameterized queries to prevent SQL injection.

## Post-conditions

- **Post-AUTH-001:** A successful `POST /auth/login` response contains a valid, signed JWT and a
  sanitized user object (id, email, isPaid). The password hash MUST NOT appear in the response.
- **Post-AUTH-002:** A successful `POST /auth/register` creates exactly one user record and returns
  HTTP 201 with the same shape as a login response.
- **Post-AUTH-003:** A JWT with an expired or invalid signature MUST cause the middleware to return
  HTTP 401 without executing any downstream handler.

## Threat Model

| Threat                          | Vector                                          | Mitigated By                            |
|---------------------------------|-------------------------------------------------|-----------------------------------------|
| Brute-force login               | Rapid credential guessing                       | IP-based rate limiting (5 / 15 min)     |
| Weak JWT secret                 | Offline token forgery                           | Minimum 32-char secret at startup       |
| Password database leak          | SQL injection / file exfiltration               | bcrypt hashing (12 rounds)              |
| Token forgery                   | Crafted JWT with arbitrary claims               | HS256 signature with strong secret      |
| Cross-origin request forgery    | Malicious page in system browser               | CORS restricted to Tauri origins        |
| SQL injection                   | Malicious email/password inputs                 | Parameterized prepared statements       |
| User enumeration                | Differential login responses                    | Uniform 401 for all auth failures       |
