'use strict';

const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const KEY_HEX_LEN = 64; // 32 bytes = 64 hex chars
const IV_BYTES = 12;

function getKey() {
  const hex = process.env.RIOT_ENCRYPTION_KEY;
  if (!hex || hex.length !== KEY_HEX_LEN) {
    throw new Error('RIOT_ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes)');
  }
  return Buffer.from(hex, 'hex');
}

function encrypt(plaintext) {
  const key = getKey();
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${encrypted.toString('hex')}:${tag.toString('hex')}`;
}

function decrypt(blob) {
  const key = getKey();
  const parts = blob.split(':');
  if (parts.length !== 3) throw new Error('Invalid encrypted blob format');
  const [ivHex, ciphertextHex, tagHex] = parts;
  const iv = Buffer.from(ivHex, 'hex');
  const ciphertext = Buffer.from(ciphertextHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(ciphertext) + decipher.final('utf8');
}

function isEncryptionKeyConfigured() {
  const hex = process.env.RIOT_ENCRYPTION_KEY;
  return !!(hex && hex.length === KEY_HEX_LEN);
}

module.exports = { encrypt, decrypt, isEncryptionKeyConfigured };
