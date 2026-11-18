/**
 * AES-256-GCM for tenants.bol_client_secret_enc.
 * Key comes from BOL_CRED_ENC_KEY, 32 bytes base64.
 *
 * Stored layout: iv (12) || authTag (16) || ciphertext.
 *
 * GCM, not CBC: the auth tag means a secret that was tampered with fails to
 * decrypt instead of returning plausible garbage that we would then post to
 * login.bol.com — where a wrong secret looks like a credentials problem and
 * costs an afternoon.
 *
 * This lives in core/ because two layers need it and neither should import the
 * other: the repository writes and reads the column, the bol client needs the
 * plaintext to build a Basic auth header.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

/**
 * @param {Buffer} key
 * @returns {void}
 */
function assertKey(key) {
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) {
    throw new Error('CRED_ENC_KEY_INVALID: expected 32 bytes');
  }
}

/**
 * @param {string} plaintext
 * @param {Buffer} key  32 bytes
 * @returns {Buffer} iv | authTag | ciphertext
 */
export function encryptSecret(plaintext, key) {
  assertKey(key);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]);
}

/**
 * @param {Buffer} blob
 * @param {Buffer} key  32 bytes
 * @returns {string}
 */
export function decryptSecret(blob, key) {
  assertKey(key);
  if (!Buffer.isBuffer(blob) || blob.length <= IV_BYTES + TAG_BYTES) {
    throw new Error('CREDENTIAL_BLOB_MALFORMED');
  }
  const iv = blob.subarray(0, IV_BYTES);
  const tag = blob.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const body = blob.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
}
