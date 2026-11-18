/**
 * Feed -> source_state -> plan -> diff -> queue, against a real Postgres.
 *
 * This is the one test that proves the product works. Everything upstream of
 * the bol API is exercised here with no bol credentials: a fake source hands in
 * items, and at the other end real push_offer rows sit in sync_jobs with the
 * right priority.
 *
 * Skipped unless DATABASE_URL is set. See scripts/pg-dev.ps1.
 */

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

import { JobsRepo } from '../src/db/repositories/jobs.repo.js';
import { ProductsRepo } from '../src/db/repositories/products.repo.js';
import { RulesRepo, encryptSecret } from '../src/db/repositories/rules.repo.js';
import { pullSourceHandler } from '../src/queue/handlers/pullSource.handler.js';
import { PRIORITY } from '../src/sync/differ.js';
import { RuleViolation } from '../src/core/errors.js';

const url = process.env.DATABASE_URL;
const skip = url ? false : 'DATABASE_URL not set';

const ENC_KEY = randomBytes(32);

/** @type {import('pg').Pool} */
let pool;
let repos;
let tenantId;

/** Items the fake source will hand back on the next fetchAll(). */
let feed = [];

const source = {
  name: 'csv:test-feed',
  async fetchAll() {
    return feed;
  },
  async fetchBySku(skus) {
    const want = new Set(skus);
    return feed.filter((i) => want.has(i.sku));
  },
  parseWebhook() {
    throw new Error('not used');
  },
};

const config = {
  safety: {
    bufferAbs: 2,
    bufferPct: 0,
    minPublish: 1,
    maxPublish: 999,
    stockDeltaThreshold: 2,
    staleAfterMin: 30,
    bulkDropGuardPct: 20,
  },
  price: {
    markupPct: 0,
    floorPrice: null,
    ceilingPrice: null,
    rounding: 'cent',
    maxChangePct: 25,
  },
  worker: { maxAttempts: 6 },
};

/** @returns {any} */
function makeCtx() {
  return {
    pool,
    config,
    repos,
    log: null,
    sourceFor: async () => source,
    clientFor: async () => ({}),
  };
}

/** @param {object} over */
function pullJob(over = {}) {
  return {
    id: 1,
    tenantId,
    productId: null,
    type: 'pull_source',
    dedupeKey: `${tenantId}:pull_source`,
    payload: {},
    priority: PRIORITY.PULL_SOURCE,
    status: 'running',
    attempts: 1,
    maxAttempts: 3,
    runAfter: new Date(),
    ...over,
  };
}

/** @param {string} sku @param {number} stock @param {number} price */
function item(sku, stock, price, ean = null) {
  return { sku, ean, stock, price, observedAt: new Date() };
}

/** @type {() => Promise<void>} */
let dropSchema;

before(async () => {
  if (skip) return;
  const { createTestSchema } = await import('../test-support/db.mjs');
  ({ pool, drop: dropSchema } = await createTestSchema('pipeline'));

  repos = {
    jobs: new JobsRepo(pool),
    products: new ProductsRepo(pool),
    rules: new RulesRepo(pool, ENC_KEY),
  };
});

after(async () => {
  if (skip) return;
  await dropSchema();
});

beforeEach(async () => {
  if (skip) return;
  if (tenantId) await pool.query('DELETE FROM tenants WHERE id = $1', [tenantId]);
  const { rows } = await pool.query(
    `INSERT INTO tenants (name, bol_client_id, bol_client_secret_enc, managed_by_retailer)
     VALUES ('pipeline-test', 'cid', $1, true) RETURNING id`,
    [encryptSecret('super-secret', ENC_KEY)],
  );
  tenantId = rows[0].id;
  feed = [];
});

/** @returns {Promise<object[]>} */
async function queuedJobs() {
  const { rows } = await pool.query(
    `SELECT product_id, type, priority, payload, status FROM sync_jobs
      WHERE tenant_id = $1 AND type <> 'pull_source' ORDER BY priority, product_id`,
    [tenantId],
  );
  return rows;
}

test('a first pull creates products, state and push jobs', { skip }, async () => {
  feed = [item('A1', 50, 12.95, '8712345678901'), item('A2', 3, 9.95)];

  await pullSourceHandler(pullJob(), makeCtx());

  const { rows: products } = await pool.query(
    'SELECT sku, ean FROM products WHERE tenant_id = $1 ORDER BY sku',
    [tenantId],
  );
  assert.deepEqual(products.map((p) => p.sku), ['A1', 'A2']);
  assert.equal(products[0].ean, '8712345678901');

  const { rows: state } = await pool.query(
    `SELECT o.desired_stock, o.desired_price FROM offer_state o
       JOIN products p ON p.id = o.product_id
      WHERE p.tenant_id = $1 ORDER BY p.sku`,
    [tenantId],
  );
  assert.equal(state[0].desired_stock, 48, '50 minus the buffer of 2');
  assert.equal(state[0].desired_price, 12.95);
  assert.equal(state[1].desired_stock, 1, '3 minus 2');

  // No offer id yet, so the queue asks for one instead of blindly creating an offer.
  const jobs = await queuedJobs();
  assert.equal(jobs.length, 2);
  assert.deepEqual([...new Set(jobs.map((j) => j.type))], ['resolve_offer_id']);
});

test('an unchanged feed enqueues nothing the second time', { skip }, async () => {
  feed = [item('A1', 50, 12.95)];
  await pullSourceHandler(pullJob(), makeCtx());
  await pool.query('DELETE FROM sync_jobs WHERE tenant_id = $1', [tenantId]);

  await pullSourceHandler(pullJob(), makeCtx());

  assert.equal((await queuedJobs()).length, 0, 'the payload hash must stop the work');
});

test('an unchanged feed still refreshes observed_at', { skip }, async () => {
  feed = [item('A1', 50, 12.95)];
  await pullSourceHandler(pullJob(), makeCtx());

  await pool.query(
    `UPDATE source_state SET observed_at = now() - interval '2 hours'
      WHERE product_id IN (SELECT id FROM products WHERE tenant_id = $1)`,
    [tenantId],
  );

  feed = [item('A1', 50, 12.95)]; // same numbers, new observation
  await pullSourceHandler(pullJob(), makeCtx());

  const { rows } = await pool.query(
    `SELECT EXTRACT(EPOCH FROM (now() - s.observed_at)) AS age
       FROM source_state s JOIN products p ON p.id = s.product_id
      WHERE p.tenant_id = $1`,
    [tenantId],
  );
  // Identical data is not stale data. If we skipped this write, the staleness
  // guard would eventually refuse to plan a perfectly healthy product.
  assert.ok(Number(rows[0].age) < 60, `observed_at was not refreshed (age ${rows[0].age}s)`);
});

test('a stock drop becomes an urgent job once the offer is known', { skip }, async () => {
  feed = [item('A1', 50, 12.95)];
  await pullSourceHandler(pullJob(), makeCtx());

  // Pretend the resolve job ran and the push succeeded.
  const { rows } = await pool.query(
    'SELECT id FROM products WHERE tenant_id = $1 AND sku = $2',
    [tenantId, 'A1'],
  );
  const productId = Number(rows[0].id);
  await pool.query('UPDATE products SET offer_id = gen_random_uuid() WHERE id = $1', [productId]);
  await repos.products.markPushed(productId, { stock: 48, price: 12.95 });
  await pool.query('DELETE FROM sync_jobs WHERE tenant_id = $1', [tenantId]);

  feed = [item('A1', 5, 12.95)];
  await pullSourceHandler(pullJob(), makeCtx());

  const jobs = await queuedJobs();
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].type, 'push_offer');
  assert.equal(jobs[0].priority, PRIORITY.STOCK_DECREASE);
  assert.equal(jobs[0].payload.patch.stock.amount, 3);
  assert.equal(
    jobs[0].payload.patch.stock.managedByRetailer,
    true,
    'the flag comes from the tenant row',
  );
  assert.deepEqual(jobs[0].payload.reasons, ['STOCK_DECREASE']);
});

test('a small stock rise is not worth a request', { skip }, async () => {
  feed = [item('A1', 50, 12.95)];
  await pullSourceHandler(pullJob(), makeCtx());

  const { rows } = await pool.query(
    'SELECT id FROM products WHERE tenant_id = $1',
    [tenantId],
  );
  const productId = Number(rows[0].id);
  await pool.query('UPDATE products SET offer_id = gen_random_uuid() WHERE id = $1', [productId]);
  await repos.products.markPushed(productId, { stock: 48, price: 12.95 });
  await pool.query('DELETE FROM sync_jobs WHERE tenant_id = $1', [tenantId]);

  feed = [item('A1', 51, 12.95)]; // 49 after the buffer: +1
  await pullSourceHandler(pullJob(), makeCtx());

  assert.equal((await queuedJobs()).length, 0);
});

test('a catalogue-wide collapse is refused, not applied', { skip }, async () => {
  feed = Array.from({ length: 10 }, (_, i) => item(`A${i}`, 50, 12.95));
  await pullSourceHandler(pullJob(), makeCtx());

  await pool.query(
    `UPDATE offer_state SET pushed_stock = 48
      WHERE product_id IN (SELECT id FROM products WHERE tenant_id = $1)`,
    [tenantId],
  );
  await pool.query('DELETE FROM sync_jobs WHERE tenant_id = $1', [tenantId]);

  // Five of ten drop to zero: 50% against a 20% guard.
  feed = Array.from({ length: 10 }, (_, i) => item(`A${i}`, i < 5 ? 1 : 50, 12.95));

  await assert.rejects(() => pullSourceHandler(pullJob(), makeCtx()), RuleViolation);

  assert.equal((await queuedJobs()).length, 0, 'half a catalogue offline is still offline');

  const { rows } = await pool.query(
    `SELECT o.desired_stock FROM offer_state o JOIN products p ON p.id = o.product_id
      WHERE p.tenant_id = $1 AND p.sku = 'A0'`,
    [tenantId],
  );
  assert.equal(rows[0].desired_stock, 48, 'the old plan is untouched');
});

test('a stale feed plans nothing and says why', { skip }, async () => {
  const old = new Date(Date.now() - 3 * 3600 * 1000);
  feed = [{ sku: 'A1', ean: null, stock: 50, price: 12.95, observedAt: old }];

  await pullSourceHandler(pullJob(), makeCtx());

  assert.equal((await queuedJobs()).length, 0);
  const { rows } = await pool.query(
    `SELECT o.needs_manual_review, o.review_reason, o.desired_stock
       FROM offer_state o JOIN products p ON p.id = o.product_id
      WHERE p.tenant_id = $1`,
    [tenantId],
  );
  assert.equal(rows[0].needs_manual_review, true);
  assert.equal(rows[0].review_reason, 'STALE_SOURCE');
  assert.equal(rows[0].desired_stock, null);
});

test('a SKU rule beats the tenant rule', { skip }, async () => {
  await pool.query(
    `INSERT INTO safety_stock_rules (tenant_id, scope, buffer_abs) VALUES ($1, 'tenant', 2)`,
    [tenantId],
  );
  await pool.query(
    `INSERT INTO safety_stock_rules (tenant_id, scope, sku, buffer_abs)
     VALUES ($1, 'sku', 'A1', 20)`,
    [tenantId],
  );

  feed = [item('A1', 50, 12.95), item('A2', 50, 12.95)];
  await pullSourceHandler(pullJob(), makeCtx());

  const { rows } = await pool.query(
    `SELECT p.sku, o.desired_stock FROM offer_state o JOIN products p ON p.id = o.product_id
      WHERE p.tenant_id = $1 ORDER BY p.sku`,
    [tenantId],
  );
  assert.equal(rows[0].desired_stock, 30, 'A1 uses its own buffer of 20');
  assert.equal(rows[1].desired_stock, 48, 'A2 falls back to the tenant buffer of 2');
});

test('a webhook pull reads only the named SKUs', { skip }, async () => {
  feed = [item('A1', 50, 12.95), item('A2', 50, 12.95)];
  await pullSourceHandler(pullJob({ payload: { skus: ['A2'] } }), makeCtx());

  const { rows } = await pool.query(
    'SELECT sku FROM products WHERE tenant_id = $1',
    [tenantId],
  );
  assert.deepEqual(rows.map((r) => r.sku), ['A2']);
});

test('an empty read changes nothing', { skip }, async () => {
  feed = [item('A1', 50, 12.95)];
  await pullSourceHandler(pullJob(), makeCtx());
  await pool.query('DELETE FROM sync_jobs WHERE tenant_id = $1', [tenantId]);

  feed = [];
  await pullSourceHandler(pullJob(), makeCtx());

  const { rows } = await pool.query(
    `SELECT s.stock FROM source_state s JOIN products p ON p.id = s.product_id
      WHERE p.tenant_id = $1`,
    [tenantId],
  );
  assert.equal(rows[0].stock, 50, 'an empty feed is not a statement that stock is zero');
  assert.equal((await queuedJobs()).length, 0);
});

test('credentials round-trip through the database', { skip }, async () => {
  const creds = await repos.rules.getCredentials(tenantId);
  assert.equal(creds.clientId, 'cid');
  assert.equal(creds.clientSecret, 'super-secret');

  const { rows } = await pool.query(
    'SELECT bol_client_secret_enc FROM tenants WHERE id = $1',
    [tenantId],
  );
  assert.equal(
    rows[0].bol_client_secret_enc.includes(Buffer.from('super-secret')),
    false,
    'the plaintext must never be in the column',
  );
});

test('a paused tenant drops out of the scheduler, then comes back', { skip }, async () => {
  assert.equal((await repos.rules.activeTenants()).some((t) => t.id === tenantId), true);

  await repos.rules.pauseTenant(tenantId, new Date(Date.now() + 3600_000), 'bad credentials');
  assert.equal((await repos.rules.activeTenants()).some((t) => t.id === tenantId), false);

  await pool.query(`UPDATE tenants SET paused_until = now() - interval '1 minute' WHERE id = $1`, [
    tenantId,
  ]);
  assert.equal(
    (await repos.rules.activeTenants()).some((t) => t.id === tenantId),
    true,
    'a pause must expire by itself, with no manual step to forget',
  );
});

test('drift and invisible offers are found from what bol reports', { skip }, async () => {
  feed = [item('A1', 50, 12.95), item('A2', 50, 12.95)];
  await pullSourceHandler(pullJob(), makeCtx());

  const { rows } = await pool.query(
    'SELECT id, sku FROM products WHERE tenant_id = $1 ORDER BY sku',
    [tenantId],
  );
  const offerIds = [];
  for (const r of rows) {
    const { rows: o } = await pool.query(
      'UPDATE products SET offer_id = gen_random_uuid() WHERE id = $1 RETURNING offer_id',
      [r.id],
    );
    offerIds.push(o[0].offer_id);
    await repos.products.markPushed(Number(r.id), { stock: 48, price: 12.95 });
  }

  await repos.products.saveRemoteState(tenantId, [
    // agrees with us, but the shelf is empty because of open orders
    {
      offerId: offerIds[0],
      stock: { amount: 48, correctedStock: 0 },
      pricing: { bundlePrices: [{ quantity: 1, unitPrice: 12.95 }] },
      lastModifiedDateTime: new Date().toISOString(),
    },
    // bol has a different number than we sent
    {
      offerId: offerIds[1],
      stock: { amount: 12, correctedStock: 12 },
      pricing: { bundlePrices: [{ quantity: 1, unitPrice: 12.95 }] },
      lastModifiedDateTime: new Date().toISOString(),
    },
  ]);

  const { rows: drift } = await pool.query(
    `SELECT p.sku FROM offer_state o JOIN products p ON p.id = o.product_id
      WHERE p.tenant_id = $1 AND o.drift_detected_at IS NOT NULL`,
    [tenantId],
  );
  assert.deepEqual(drift.map((d) => d.sku), ['A2']);

  const invisible = await repos.products.findInvisibleOffers(tenantId);
  assert.equal(invisible.length, 1);
  assert.equal(invisible[0].sku, 'A1', 'live, no drift, no error — and selling nothing');
});

test('one EAN listed twice attaches once instead of failing the batch', { skip }, async () => {
  feed = [item('A1', 50, 12.95, '8712345678901'), item('A2', 50, 12.95, '8712345678901')];
  await pullSourceHandler(pullJob(), makeCtx());

  const offerId = '11111111-2222-3333-4444-555555555555';
  const attached = await repos.products.attachOfferIds(
    new Map([['8712345678901', offerId]]),
    tenantId,
  );

  assert.equal(attached, 1, 'the unique index on (tenant_id, offer_id) allows exactly one');
  const { rows } = await pool.query(
    'SELECT count(*) AS n FROM products WHERE tenant_id = $1 AND offer_id IS NOT NULL',
    [tenantId],
  );
  assert.equal(Number(rows[0].n), 1);
});
