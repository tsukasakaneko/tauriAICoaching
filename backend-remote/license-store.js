'use strict';

const crypto = require('crypto');
const db = require('./db');

// PKCS8 DER prefix for a raw 32-byte Ed25519 private key seed (server.js と同じ)
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

// tier code(キー payload 先頭バイト)→ tier 名・付与クレジット・許可プレフィックス
const TIER_BY_CODE = {
  0x01: { tier: 'pro',          credits: 0,   prefix: 'VCOACH'  },
  0x02: { tier: 'cloud',        credits: 50,  prefix: 'VCLOUD'  },
  0x03: { tier: 'credit10',     credits: 10,  prefix: 'VCREDIT' },
  0x04: { tier: 'credit30',     credits: 30,  prefix: 'VCREDIT' },
  0x05: { tier: 'credit80',     credits: 80,  prefix: 'VCREDIT' },
  0x06: { tier: 'cloud_yearly', credits: 600, prefix: 'VCLOUD'  },
};

const FIRST_PAYMENT_BONUS = 10;
// 初回購入ボーナス対象 tier(ローカル実装ではクレジットキーは対象外だった)
const BONUS_TIERS = new Set(['pro', 'cloud', 'cloud_yearly']);

// license.rs の normalize_key_prefix と同じ正規化: プレフィックスのみ大文字化
function normalizeKey(key) {
  const trimmed = String(key).trim();
  const pos = trimmed.indexOf('-');
  if (pos === -1) return trimmed.toUpperCase();
  return trimmed.slice(0, pos).toUpperCase() + trimmed.slice(pos);
}

function keyHash(key) {
  return crypto.createHash('sha256').update(normalizeKey(key)).digest('hex');
}

function publicKeyFromEnv() {
  const privateKeyB64 = process.env.LICENSE_PRIVATE_KEY;
  if (!privateKeyB64) throw new Error('LICENSE_PRIVATE_KEY is not set');
  const seed = Buffer.from(privateKeyB64, 'base64url');
  if (seed.length !== 32) throw new Error('LICENSE_PRIVATE_KEY must be 32 bytes');
  const pkcs8Der = Buffer.concat([ED25519_PKCS8_PREFIX, seed]);
  const privateKey = crypto.createPrivateKey({ key: pkcs8Der, format: 'der', type: 'pkcs8' });
  return crypto.createPublicKey(privateKey);
}

/** "YYYY-MM" 形式。0xFF は無期限 → null */
function expiryString(yearSince2020, month) {
  if (yearSince2020 === 0xff || month === 0xff) return null;
  return `${2020 + yearSince2020}-${String(month).padStart(2, '0')}`;
}

function currentMonthString() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * キーの Ed25519 署名・形式・期限を検証し、tier 情報を返す。
 * 不正な場合は { error } を返す。
 */
function verifyKey(key) {
  const normalized = normalizeKey(key);
  const pos = normalized.indexOf('-');
  if (pos === -1) return { error: 'キーの形式が正しくありません' };

  const prefix = normalized.slice(0, pos);
  let decoded;
  try {
    decoded = Buffer.from(normalized.slice(pos + 1), 'base64url');
  } catch {
    return { error: 'キーに無効な文字が含まれています' };
  }
  if (decoded.length !== 68) return { error: 'キーの長さが正しくありません' };

  const payload = decoded.subarray(0, 4);
  const signature = decoded.subarray(4);

  let valid = false;
  try {
    valid = crypto.verify(null, payload, publicKeyFromEnv(), signature);
  } catch (err) {
    console.error('[license] signature verification error:', err.message);
    return { error: 'キーの検証に失敗しました' };
  }
  if (!valid) return { error: 'キーが無効です' };

  const cfg = TIER_BY_CODE[payload[0]];
  if (!cfg || cfg.prefix !== prefix) return { error: 'キーの形式が正しくありません' };

  const expiresAt = expiryString(payload[1], payload[2]);
  if (expiresAt && expiresAt < currentMonthString()) {
    return { error: 'このキーは有効期限切れです' };
  }

  return { normalized, tier: cfg.tier, credits: cfg.credits, expiresAt };
}

/** Stripe webhook からの発行時登録。既存行(リトライ等)は無視する。 */
function registerIssuedKey({ key, email, tier, credits, expiresAt }) {
  db.prepare(`
    INSERT OR IGNORE INTO licenses (key_hash, email, tier, credits_granted, expires_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(keyHash(key), email, tier, credits, expiresAt);
}

const selectLicenseByHash = () => db.prepare('SELECT * FROM licenses WHERE key_hash = ?');

function licenseBalance(licenseId) {
  const row = db.prepare(
    'SELECT COALESCE(SUM(delta), 0) AS bal FROM credit_ledger WHERE license_id = ?'
  ).get(licenseId);
  return row.bal;
}

/** 端末に紐付く有効期限内ライセンス全体の残高 */
function balanceForDevice(deviceHash) {
  const row = db.prepare(`
    SELECT COALESCE(SUM(cl.delta), 0) AS bal
    FROM credit_ledger cl
    JOIN licenses l ON l.id = cl.license_id
    WHERE l.device_hash = ?
      AND (l.expires_at IS NULL OR l.expires_at >= ?)
  `).get(deviceHash, currentMonthString());
  return row.bal;
}

/** 端末の表示用ステータス。tier は pro > cloud > free の優先順。 */
function statusForDevice(deviceHash) {
  const nowMonth = currentMonthString();
  const rows = db.prepare(`
    SELECT tier, expires_at FROM licenses
    WHERE device_hash = ?
      AND (expires_at IS NULL OR expires_at >= ?)
  `).all(deviceHash, nowMonth);

  let tier = 'free';
  let expiresAt = null;
  for (const r of rows) {
    if (r.tier === 'pro') {
      tier = 'pro';
    } else if (tier !== 'pro') {
      tier = 'cloud';
      if (r.tier === 'cloud' || r.tier === 'cloud_yearly') {
        if (!expiresAt || (r.expires_at && r.expires_at > expiresAt)) {
          expiresAt = r.expires_at;
        }
      }
    }
  }
  return { tier, credits: balanceForDevice(deviceHash), expiresAt };
}

/**
 * アクティベート。成功時は { license, granted, firstPaymentBonus } を返し、
 * 失敗時は { error, statusCode } を返す。
 */
const activate = db.transaction((key, deviceHash) => {
  const verified = verifyKey(key);
  if (verified.error) return { error: verified.error, statusCode: 400 };

  const hash = keyHash(key);
  let license = selectLicenseByHash().get(hash);

  if (!license) {
    // DB 導入前に発行されたレガシーキー: 署名検証済みなのでここで登録する
    db.prepare(`
      INSERT INTO licenses (key_hash, email, tier, credits_granted, expires_at)
      VALUES (?, NULL, ?, ?, ?)
    `).run(hash, verified.tier, verified.credits, verified.expiresAt);
    license = selectLicenseByHash().get(hash);
  }

  if (license.device_hash && license.device_hash !== deviceHash) {
    return {
      error: 'このキーは既に別の端末でアクティベート済みです。キーは1台の端末でのみ使用できます。',
      statusCode: 403,
    };
  }

  let granted = 0;
  let firstPaymentBonus = 0;

  if (!license.device_hash) {
    if (license.activation_count >= license.max_activations) {
      return { error: 'このキーはアクティベート回数の上限に達しています。', statusCode: 403 };
    }

    // この端末で初めてのアクティベートなら初回購入ボーナス(対象 tier のみ)
    const priorCount = db.prepare(
      'SELECT COUNT(*) AS c FROM licenses WHERE device_hash = ? AND id != ?'
    ).get(deviceHash, license.id).c;

    db.prepare(`
      UPDATE licenses
      SET device_hash = ?, activation_count = activation_count + 1,
          activated_at = datetime('now')
      WHERE id = ?
    `).run(deviceHash, license.id);

    if (license.credits_granted > 0) {
      db.prepare(
        'INSERT INTO credit_ledger (license_id, delta, reason) VALUES (?, ?, ?)'
      ).run(license.id, license.credits_granted, 'activate');
      granted = license.credits_granted;
    }

    if (priorCount === 0 && BONUS_TIERS.has(license.tier)) {
      db.prepare(
        'INSERT INTO credit_ledger (license_id, delta, reason) VALUES (?, ?, ?)'
      ).run(license.id, FIRST_PAYMENT_BONUS, 'first_payment_bonus');
      firstPaymentBonus = FIRST_PAYMENT_BONUS;
    }

    license = selectLicenseByHash().get(hash);
  }
  // 同一端末での再アクティベート(再インストール)は付与なしで成功扱い

  return { license, granted, firstPaymentBonus };
});

/**
 * クレジットを1消費する。期限が近いライセンスから消費(FIFO)。
 * 残高不足なら { error } を返す。
 */
const consume = db.transaction((deviceHash) => {
  const nowMonth = currentMonthString();
  const candidates = db.prepare(`
    SELECT id FROM licenses
    WHERE device_hash = ?
      AND (expires_at IS NULL OR expires_at >= ?)
    ORDER BY (expires_at IS NULL), expires_at ASC, id ASC
  `).all(deviceHash, nowMonth);

  for (const { id } of candidates) {
    if (licenseBalance(id) > 0) {
      db.prepare(
        'INSERT INTO credit_ledger (license_id, delta, reason) VALUES (?, -1, ?)'
      ).run(id, 'consume');
      return { credits: balanceForDevice(deviceHash) };
    }
  }
  return { error: 'クラウドAIのクレジットが不足しています。VCREDITキーを入力してクレジットを追加してください。' };
});

module.exports = {
  keyHash,
  verifyKey,
  registerIssuedKey,
  activate,
  consume,
  balanceForDevice,
  statusForDevice,
};
