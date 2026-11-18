/**
 * RateBucketStore against a real Postgres.
 *
 * The point of this table is that two worker processes cannot both spend the
 * last token. That is a race, and a race is only proven against a real database
 * with real row locks — a mock would happily agree with whatever we wrote.
 *
 * Skipped unless DATABASE_URL is set. See scripts/pg-dev.ps1.
 */

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

import { RateBucketStore } from '../src/core/limiter.js';
import { budgeted } from '../src/bol/rateLimits.js';

const skip = process.env.DATABASE_URL ? false : 'DATABASE_URL not set';

/** @type {import('pg').Pool} */
let pool;
/** @type {() => Promise<void>} */
let dropSchema;
/** @type {RateBucketStore} */
let store;
let tenantId;

before(async () => {
  if (skip) return;
  const { createTestSchema } = await import('../test-support/db.mjs');
  ({ pool, drop: dropSchema } = await createTestSchema('buckets'));
  store = new RateBucketStore(pool, 100);
});

after(async () => {
  if (skip) return;
  await dropSchema();
});

beforeEach(async () => {
  if (skip) return;
  if (tenantId) await pool.query('DELETE FROM tenants WHERE id = $1', [tenantId]);
  const { rows } = await pool.query(
    `INSERT INTO tenants (name, bol_client_id, bol_client_secret_enc)
     VALUES ('buckets', 'cid', $1) RETURNING id`,
    [randomBytes(16)],
  );
  tenantId = rows[0].id;
});

/** @returns {Promise<{tokens:number, capacity:number, blocked:Date|null}>} */
async function readBucket(bucket) {
  const { rows } = await pool.query(
    'SELECT tokens, capacity, blocked_until FROM rate_buckets WHERE tenant_id = $1 AND bucket = $2',
    [tenantId, bucket],
  );
  return {
    tokens: Number(rows[0].tokens),
    capacity: Number(rows[0].capacity),
    blocked: rows[0].blocked_until,
  };
}

test('the first take creates the bucket from the published limit', { skip }, async () => {
  const result = await store.tryTake(tenantId, 'export');

  assert.equal(result.granted, true);
  const b = await readBucket('export');
  assert.equal(b.capacity, budgeted('export', 100).capacity, '9 exports per hour');
  assert.equal(b.tokens, 8, 'one spent');
});

test('an exhausted bucket refuses and says how long to wait', { skip }, async () => {
  // The export bucket refills at 0.0025/s, so nothing comes back during a test.
  for (let i = 0; i < 9; i += 1) {
    assert.equal((await store.tryTake(tenantId, 'export')).granted, true, `take ${i + 1}`);
  }

  const denied = await store.tryTake(tenantId, 'export');
  assert.equal(denied.granted, false);
  // One token at 9/hour is 400 seconds.
  assert.ok(denied.retryAfterMs > 300_000, `expected a long wait, got ${denied.retryAfterMs}ms`);
});

test('tokens come back as time passes', { skip }, async () => {
  for (let i = 0; i < 9; i += 1) await store.tryTake(tenantId, 'export');
  assert.equal((await store.tryTake(tenantId, 'export')).granted, false);

  // 20 minutes at 9/hour is three tokens.
  await pool.query(
    `UPDATE rate_buckets SET updated_at = now() - interval '20 minutes'
      WHERE tenant_id = $1 AND bucket = 'export'`,
    [tenantId],
  );

  assert.equal((await store.tryTake(tenantId, 'export')).granted, true);
  const b = await readBucket('export');
  assert.ok(b.tokens >= 1 && b.tokens < 3, `refilled to ${b.tokens}`);
});

test('refill never exceeds the capacity', { skip }, async () => {
  await store.tryTake(tenantId, 'export');
  await pool.query(
    `UPDATE rate_buckets SET updated_at = now() - interval '30 days'
      WHERE tenant_id = $1 AND bucket = 'export'`,
    [tenantId],
  );

  await store.tryTake(tenantId, 'export');
  const b = await readBucket('export');
  assert.equal(b.tokens, b.capacity - 1, 'a month of idling is still only one full bucket');
});

test('a 429 holds every worker, not just the one that got it', { skip }, async () => {
  await store.tryTake(tenantId, 'offers_write');
  await store.penalise(tenantId, 'offers_write', 120);

  const afterPenalty = await readBucket('offers_write');
  assert.equal(afterPenalty.tokens, 0, 'the bucket is emptied, not just blocked');
  assert.ok(afterPenalty.blocked > new Date());

  const denied = await store.tryTake(tenantId, 'offers_write');
  assert.equal(denied.granted, false);
  assert.ok(denied.retryAfterMs > 100_000, `expected ~120s, got ${denied.retryAfterMs}ms`);
});

test('the block expires by itself', { skip }, async () => {
  await store.tryTake(tenantId, 'offers_write');
  await store.penalise(tenantId, 'offers_write', 5);

  // Let the block lapse. updated_at moves with it, because tokens accrue over
  // the same seconds — a bucket that is unblocked but still empty would only
  // say "wait another 20ms", which is not what this test is about.
  await pool.query(
    `UPDATE rate_buckets
        SET blocked_until = now() - interval '1 second',
            updated_at    = now() - interval '1 second'
      WHERE tenant_id = $1 AND bucket = 'offers_write'`,
    [tenantId],
  );

  assert.equal((await store.tryTake(tenantId, 'offers_write')).granted, true);
});

test('two workers cannot both spend the last token', { skip }, async () => {
  await store.tryTake(tenantId, 'export');
  await pool.query(
    `UPDATE rate_buckets SET tokens = 1, updated_at = now()
      WHERE tenant_id = $1 AND bucket = 'export'`,
    [tenantId],
  );

  // Both start before either finishes. Without FOR UPDATE both would read
  // "1 token left", both would say yes, and bol would see two requests.
  const [a, b] = await Promise.all([
    store.tryTake(tenantId, 'export'),
    store.tryTake(tenantId, 'export'),
  ]);

  assert.equal([a.granted, b.granted].filter(Boolean).length, 1, 'exactly one winner');
  const bucket = await readBucket('export');
  assert.ok(bucket.tokens < 1, `tokens went negative or stayed high: ${bucket.tokens}`);
});

test('concurrent takes spend exactly one token each', { skip }, async () => {
  // The export bucket is used here precisely because it refills at 0.0025/s:
  // nothing accrues during the test, so the arithmetic is exact. offers_write
  // refills at 50/s and would hand tokens back mid-assertion.
  await store.tryTake(tenantId, 'export'); // seed
  const { capacity } = await (async () => {
    await pool.query(
      `UPDATE rate_buckets SET tokens = capacity, updated_at = now()
        WHERE tenant_id = $1 AND bucket = 'export'`,
      [tenantId],
    );
    return readBucket('export');
  })();

  const take = capacity - 3;
  const results = await Promise.all(
    Array.from({ length: take }, () => store.tryTake(tenantId, 'export')),
  );
  assert.equal(results.every((r) => r.granted), true, `all ${take} should fit under ${capacity}`);

  const b = await readBucket('export');
  assert.ok(b.tokens >= 3 && b.tokens < 3.1, `expected 3 left, found ${b.tokens}`);
});

test('a bucket never holds more than its capacity', { skip }, async () => {
  await store.tryTake(tenantId, 'export');
  // Someone sets the counter too high by hand, or an old row survives a limit
  // change. The refill clamp has to win, or the next burst outruns bol's limit.
  await pool.query(
    `UPDATE rate_buckets SET tokens = 500, updated_at = now()
      WHERE tenant_id = $1 AND bucket = 'export'`,
    [tenantId],
  );

  await store.tryTake(tenantId, 'export');
  const b = await readBucket('export');
  assert.equal(b.tokens, b.capacity - 1, 'clamped to capacity, then one spent');
});

test('buckets are independent of each other', { skip }, async () => {
  for (let i = 0; i < 9; i += 1) await store.tryTake(tenantId, 'export');
  assert.equal((await store.tryTake(tenantId, 'export')).granted, false);

  assert.equal(
    (await store.tryTake(tenantId, 'offers_write')).granted,
    true,
    'a spent export budget must not stop a stock push',
  );
});
