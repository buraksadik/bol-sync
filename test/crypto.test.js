import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

import { encryptSecret, decryptSecret } from '../src/db/repositories/rules.repo.js';
import { redact } from '../src/db/repositories/logs.repo.js';

const KEY = randomBytes(32);

test('a client secret survives a round trip', () => {
  const secret = 'bol-client-secret-ZXCV1234!@#$';
  const blob = encryptSecret(secret, KEY);

  assert.ok(Buffer.isBuffer(blob));
  assert.equal(blob.includes(Buffer.from(secret, 'utf8')), false, 'the plaintext must not be in there');
  assert.equal(decryptSecret(blob, KEY), secret);
});

test('the same secret encrypts differently every time', () => {
  const a = encryptSecret('same', KEY);
  const b = encryptSecret('same', KEY);
  assert.notEqual(a.toString('hex'), b.toString('hex'), 'a fresh IV per write');
});

test('a tampered blob fails instead of returning garbage', () => {
  const blob = encryptSecret('bol-secret', KEY);
  blob[blob.length - 1] ^= 0xff;
  // GCM's auth tag is the point: without it this would decrypt to plausible
  // nonsense that we would then post to login.bol.com.
  assert.throws(() => decryptSecret(blob, KEY));
});

test('the wrong key fails', () => {
  const blob = encryptSecret('bol-secret', KEY);
  assert.throws(() => decryptSecret(blob, randomBytes(32)));
});

test('a truncated blob is rejected before the cipher sees it', () => {
  assert.throws(() => decryptSecret(Buffer.alloc(10), KEY), /CREDENTIAL_BLOB_MALFORMED/);
  assert.throws(() => decryptSecret(/** @type {any} */ ('not a buffer'), KEY), /CREDENTIAL_BLOB_MALFORMED/);
});

test('redact strips credentials at any depth', () => {
  const entry = {
    url: 'https://api.bol.com/retailer/offers',
    headers: { Authorization: 'Bearer eyJhbGciOi...', Accept: 'application/json' },
    body: { nested: { client_secret: 'hunter2', amount: 7 } },
  };

  const safe = /** @type {any} */ (redact(entry));

  assert.equal(safe.headers.Authorization, '[redacted]');
  assert.equal(safe.headers.Accept, 'application/json', 'harmless headers stay readable');
  assert.equal(safe.body.nested.client_secret, '[redacted]');
  assert.equal(safe.body.nested.amount, 7);
});

test('redact is case insensitive about key names', () => {
  const safe = /** @type {any} */ (redact({ ACCESS_TOKEN: 'a', Token: 'b', apiKey: 'c' }));
  assert.deepEqual(safe, { ACCESS_TOKEN: '[redacted]', Token: '[redacted]', apiKey: '[redacted]' });
});

test('redact clips long strings and deep structures', () => {
  const long = /** @type {any} */ (redact({ html: 'x'.repeat(5000) }));
  assert.ok(long.html.length <= 2001);

  let deep = { v: 1 };
  for (let i = 0; i < 12; i += 1) deep = { v: deep };
  assert.equal(JSON.stringify(redact(deep)).includes('[deep]'), true);
});

test('redact does not dump a buffer into the log', () => {
  const safe = /** @type {any} */ (redact({ blob: Buffer.from('secret bytes') }));
  assert.equal(safe.blob, '[buffer]');
});
