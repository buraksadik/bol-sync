/**
 * Boots the real service and talks to it over HTTP.
 *
 * Everything above this test exercises a layer. This one proves the layers are
 * actually wired to each other: config -> pool -> repos -> source -> queue ->
 * HTTP. It makes no outbound calls, so it needs no bol credentials.
 *
 * Runs against the public schema rather than a private one, because
 * createService builds its own pool from DATABASE_URL and would not inherit a
 * per-file search_path. It cleans up its own tenant afterwards.
 *
 * Skipped unless DATABASE_URL is set. See scripts/pg-dev.ps1.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const skip = process.env.DATABASE_URL ? false : 'DATABASE_URL not set';

const ENC_KEY = randomBytes(32);
const WEBHOOK_SECRET = 'test-webhook-secret';

/** @type {any} */
let service;
/** @type {import('pg').Pool} */
let pool;
let tenantId;
let baseUrl;

before(async () => {
  if (skip) return;

  const pg = (await import('pg')).default;
  pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));
  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  await pool.query(await readFile(new URL('../src/db/schema.sql', import.meta.url), 'utf8'));

  const { encryptSecret } = await import('../src/core/secrets.js');
  const { rows } = await pool.query(
    `INSERT INTO tenants (name, bol_client_id, bol_client_secret_enc)
     VALUES ('service-test', 'cid', $1) RETURNING id`,
    [encryptSecret('secret', ENC_KEY)],
  );
  tenantId = rows[0].id;

  Object.assign(process.env, {
    LOG_LEVEL: 'silent',
    HTTP_PORT: '0', // let the OS pick, so a busy 3000 cannot fail the test
    BOL_CRED_ENC_KEY: ENC_KEY.toString('base64'),
    SOURCE_TYPE: 'woocommerce',
    SOURCE_BASE_URL: 'https://shop.example.nl',
    SOURCE_API_KEY: 'ck',
    SOURCE_API_SECRET: 'cs',
    SOURCE_WEBHOOK_SECRET: WEBHOOK_SECRET,
  });

  const { createService } = await import('../src/index.js');
  service = await createService();
  baseUrl = `http://127.0.0.1:${service.server.port}`;
});

after(async () => {
  if (skip) return;
  await service?.stop();
  await pool.query('DELETE FROM tenants WHERE id = $1', [tenantId]);
  await pool.end();
});

/** @param {string} path */
async function get(path) {
  const res = await fetch(`${baseUrl}${path}`);
  return { status: res.status, body: await res.json().catch(() => null) };
}

/**
 * @param {string} path
 * @param {object} body
 * @param {string|null} signature
 */
async function post(path, body, signature) {
  const raw = JSON.stringify(body);
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(signature === null ? {} : { 'X-WC-Webhook-Signature': signature }),
    },
    body: raw,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

/** @param {object} body */
function sign(body) {
  return createHmac('sha256', WEBHOOK_SECRET).update(Buffer.from(JSON.stringify(body))).digest('base64');
}

test('the service answers a liveness probe', { skip }, async () => {
  const res = await get('/health');
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
});

test('queue health reports the age of the oldest pending job', { skip }, async () => {
  const res = await get(`/health/queue?tenant=${tenantId}`);
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.body).sort(), [
    'dead',
    'oldestPendingSec',
    'pending',
    'running',
  ]);
});

test('a health route without a tenant is refused, not guessed', { skip }, async () => {
  assert.equal((await get('/health/queue')).status, 400);
});

test('an unknown route is a 404, not a crash', { skip }, async () => {
  assert.equal((await get('/nope')).status, 404);
});

test('an unsigned webhook is rejected', { skip }, async () => {
  const res = await post(`/webhook/source/${tenantId}`, { sku: 'A1' }, null);
  assert.equal(res.status, 401);

  const { rows } = await pool.query('SELECT count(*) AS n FROM sync_jobs WHERE tenant_id = $1', [
    tenantId,
  ]);
  assert.equal(Number(rows[0].n), 0, 'nothing may reach the queue without a valid signature');
});

test('a webhook signed with the wrong secret is rejected', { skip }, async () => {
  const body = { sku: 'A1', stock_quantity: 3, price: '12.95', type: 'simple', meta_data: [] };
  const wrong = createHmac('sha256', 'not-the-secret')
    .update(Buffer.from(JSON.stringify(body)))
    .digest('base64');

  assert.equal((await post(`/webhook/source/${tenantId}`, body, wrong)).status, 401);
});

test('a signed webhook enqueues one pull job for the named sku', { skip }, async () => {
  const body = { sku: 'A1', stock_quantity: 3, price: '12.95', type: 'simple', meta_data: [] };

  const res = await post(`/webhook/source/${tenantId}`, body, sign(body));
  assert.equal(res.status, 202);
  assert.equal(res.body.accepted, 1);

  const { rows } = await pool.query(
    `SELECT type, payload, priority FROM sync_jobs WHERE tenant_id = $1 AND status = 'pending'`,
    [tenantId],
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].type, 'pull_source');
  assert.deepEqual(rows[0].payload.skus, ['A1']);
  assert.equal(rows[0].payload.trigger, 'webhook');
});

test('a webhook storm collapses onto one job', { skip }, async () => {
  const body = { sku: 'A2', stock_quantity: 1, price: '9.95', type: 'simple', meta_data: [] };
  const signature = sign(body);

  await Promise.all(
    Array.from({ length: 20 }, () => post(`/webhook/source/${tenantId}`, body, signature)),
  );

  const { rows } = await pool.query(
    `SELECT count(*) AS n FROM sync_jobs
      WHERE tenant_id = $1 AND type = 'pull_source' AND status IN ('pending','running')`,
    [tenantId],
  );
  // The dedupe index is what makes a busy Friday afternoon survivable.
  assert.equal(Number(rows[0].n), 1);
});

test('the scheduler enqueues the recurring work it owns', { skip }, async () => {
  await pool.query('DELETE FROM sync_jobs WHERE tenant_id = $1', [tenantId]);

  await service.scheduler.runNow('pull_source');
  await service.scheduler.runNow('reconcile_incremental');

  const { rows } = await pool.query(
    `SELECT type, dedupe_key FROM sync_jobs WHERE tenant_id = $1 ORDER BY type`,
    [tenantId],
  );
  assert.deepEqual(rows.map((r) => r.type), ['pull_source', 'reconcile']);
  assert.equal(rows[1].dedupe_key, `${tenantId}:reconcile:incremental`);
});

test('drift health reads both findings without a bol call', { skip }, async () => {
  const res = await get(`/health/drift?tenant=${tenantId}`);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { drift: [], invisible: [] });
});

test('every job type has a handler registered', { skip }, async () => {
  // A missing handler is a dead letter that no amount of retrying fixes, so it
  // is worth catching at boot rather than at 3am.
  assert.deepEqual(Object.keys(service.worker.handlers).sort(), [
    'pull_source',
    'push_offer',
    'reconcile',
    'resolve_offer_id',
  ]);
});
