'use strict';

// [BLOCKED] Requires RIOT_CLIENT_ID and RIOT_CLIENT_SECRET from Riot Developer Portal.
// Skeleton is complete — fill in no additional code once credentials are available.

const RIOT_AUTH_BASE = 'https://auth.riotgames.com';
const RIOT_TOKEN_URL = `${RIOT_AUTH_BASE}/token`;
const RIOT_REVOKE_URL = `${RIOT_AUTH_BASE}/token/revoke`;

// Must match the redirect_uri registered in the Riot Developer Portal
const REDIRECT_URI = 'http://127.0.0.1:3001/auth/riot/callback';

function buildAuthUrl(state) {
  if (!process.env.RIOT_CLIENT_ID) {
    throw new Error('RIOT_CLIENT_ID is not configured');
  }
  const params = new URLSearchParams({
    client_id: process.env.RIOT_CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: 'openid offline_access',
    state,
  });
  return `${RIOT_AUTH_BASE}/authorize?${params.toString()}`;
}

async function exchangeCode(code) {
  if (!process.env.RIOT_CLIENT_ID || !process.env.RIOT_CLIENT_SECRET) {
    throw new Error('Riot OAuth credentials are not configured');
  }
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
    client_id: process.env.RIOT_CLIENT_ID,
    client_secret: process.env.RIOT_CLIENT_SECRET,
  });
  const res = await fetch(RIOT_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Riot token exchange failed: ${res.status} ${text}`);
  }
  // Returns: { access_token, refresh_token, expires_in, token_type, scope }
  return res.json();
}

async function refreshToken(token) {
  if (!process.env.RIOT_CLIENT_ID || !process.env.RIOT_CLIENT_SECRET) {
    throw new Error('Riot OAuth credentials are not configured');
  }
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: token,
    client_id: process.env.RIOT_CLIENT_ID,
    client_secret: process.env.RIOT_CLIENT_SECRET,
  });
  const res = await fetch(RIOT_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Riot token refresh failed: ${res.status} ${text}`);
  }
  return res.json(); // { access_token, expires_in, token_type } — refresh_token may rotate
}

async function revokeToken(token) {
  if (!process.env.RIOT_CLIENT_ID || !process.env.RIOT_CLIENT_SECRET) {
    return; // no-op if not configured
  }
  const body = new URLSearchParams({
    token,
    client_id: process.env.RIOT_CLIENT_ID,
    client_secret: process.env.RIOT_CLIENT_SECRET,
  });
  try {
    await fetch(RIOT_REVOKE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
  } catch {
    // revocation failure is non-fatal — DB is cleared regardless
  }
}

module.exports = { buildAuthUrl, exchangeCode, refreshToken, revokeToken, REDIRECT_URI };
