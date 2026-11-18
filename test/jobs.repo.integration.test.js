/**
 * JobsRepo against a real Postgres.
 *
 * Skipped unless DATABASE_URL is set, so `npm test` stays green on a laptop
 * with no database. The SQL here is the part unit tests cannot reach: the
 * partial unique index, FOR UPDATE SKIP LOCKED, the claim order, and the
 * "changed while running" race.
 *
 * It earns its keep. The first run against a real database found that
 * `UPDATE ... RETURNING` hands rows back in an undefined order, so a
 * priority-10 job was being returned behind a priority-80 one.
 *
 * Run it before any deploy. Windows, no Docker, no admin rights:
 *
 *   .\scripts\pg-dev.ps1 start
 *   $env:DATABASE_URL = .\scripts\pg-dev.ps1 url
 *   npm run migrate
 *   npm test
 *
 * Or with Docker:
 *
 *   docker run --rm -d -p 5433:5432 -e POSTGRES_PASSWORD=dev --name bolpg postgres:16
 *   DATABASE_URL=postgres://postgres:dev@localhost:5433/postgres npm run migrate && npm test
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { JobsRepo } from '../src/db/repositories/jobs.repo.js';

const url = process.env.DATABASE_URL;
const skip = url ? false : 'DATABASE_URL not set';

// The database helper is imported inside before(), not at the top. A static
// import would pull in `pg` and make this whole file fail to load on a machine
// with no node_modules — and a skipped test must not need what it skips.
/** @type {import('pg').Pool} */
let pool;
/** @type {() => Promise<void>} */
let dropSchema;
/** @type {JobsRepo} */
let repo;
/** @type {string} */
let tenantId;

before(async () => {
  if (skip) return;
  const { createTestSchema } = await import('../test-support/db.mjs');
  ({ pool, drop: dropSchema } = await createTestSchema('jobs'));
  repo = new JobsRepo(pool);

  const { rows } = await pool.query(
    `INSERT INTO tenants (name, bol_client_id, bol_client_secret_enc)
     VALUES ('test', 'cid', $1) RETURNING id`,
    [Buffer.from('x')],
  );
  tenantId = rows[0].id;
});

after(async () => {
  if (skip) return;
  await dropSchema();
});

/** @param {object} over */
function spec(over = {}) {
  return {
    tenantId,
    productId: null,
    type: 'push_offer',
    dedupeKey: null,
    payload: {},
    priority: 100,
    maxAttempts: 6,
    runAfter: new Date(),
    ...over,
  };
}

test('enqueue collapses onto the open job with the same dedupe key', { skip }, async () => {
  const key = `k-${Date.now()}`;
  const a = await repo.enqueue(spec({ dedupeKey: key, priority: 80, payload: { v: 1 } }));
  const b = await repo.enqueue(spec({ dedupeKey: key, priority: 10, payload: { v: 2 } }));

  assert.equal(a, b, 'the second enqueue must update the first row, not add one');

  const { rows } = await pool.query('SELECT payload, priority FROM sync_jobs WHERE id = $1', [a]);
  assert.deepEqual(rows[0].payload, { v: 2 }, 'the newest target wins');
  assert.equal(Number(rows[0].priority), 10, 'the stronger priority wins');
});

test('a null dedupe key never collides', { skip }, async () => {
  const a = await repo.enqueue(spec({ type: 'reconcile' }));
  const b = await repo.enqueue(spec({ type: 'reconcile' }));
  assert.notEqual(a, b);
});

test('claim takes the lowest priority first and increments attempts', { skip }, async () => {
  await pool.query('DELETE FROM sync_jobs WHERE tenant_id = $1', [tenantId]);
  await repo.enqueue(spec({ priority: 80, payload: { tag: 'low' } }));
  await repo.enqueue(spec({ priority: 10, payload: { tag: 'urgent' } }));

  const claimed = await repo.claim('w1', 10);

  assert.equal(claimed.length, 2);
  assert.equal(claimed[0].payload.tag, 'urgent');
  assert.equal(claimed[0].attempts, 1, 'attempts increments at claim, not at failure');
  assert.equal(claimed[0].status, 'running');
});

test('a second worker skips rows the first one holds', { skip }, async () => {
  await pool.query('DELETE FROM sync_jobs WHERE tenant_id = $1', [tenantId]);
  await repo.enqueue(spec());
  await repo.enqueue(spec());

  const first = await repo.claim('w1', 1);
  const second = await repo.claim('w2', 10);

  assert.equal(first.length, 1);
  assert.equal(second.length, 1);
  assert.notEqual(first[0].id, second[0].id);
});

test('a job that changed while running goes back to pending', { skip }, async () => {
  await pool.query('DELETE FROM sync_jobs WHERE tenant_id = $1', [tenantId]);
  const key = `race-${Date.now()}`;
  const id = await repo.enqueue(spec({ dedupeKey: key, payload: { stock: 10 } }));

  const [claimed] = await repo.claim('w1', 1);
  assert.equal(claimed.id, id);

  // A webhook lands while the push is in flight.
  await repo.enqueue(spec({ dedupeKey: key, payload: { stock: 0 } }));

  const status = await repo.markDone(id);
  assert.equal(status, 'pending', 'marking this done would silently drop a stock change');

  const again = await repo.claim('w1', 1);
  assert.deepEqual(again[0].payload, { stock: 0 });
});

test('an untouched job is simply done', { skip }, async () => {
  await pool.query('DELETE FROM sync_jobs WHERE tenant_id = $1', [tenantId]);
  const id = await repo.enqueue(spec({ dedupeKey: `ok-${Date.now()}` }));
  await repo.claim('w1', 1);
  assert.equal(await repo.markDone(id), 'done');
});

test('kill writes the job and the dead letter in one transaction', { skip }, async () => {
  await pool.query('DELETE FROM sync_jobs WHERE tenant_id = $1', [tenantId]);
  const id = await repo.enqueue(spec());
  const [claimed] = await repo.claim('w1', 1);

  await repo.kill(claimed, 'PERMANENT', { message: 'bad request' });

  const { rows } = await pool.query('SELECT status FROM sync_jobs WHERE id = $1', [id]);
  assert.equal(rows[0].status, 'dead');

  const open = await repo.openDeadLetters(tenantId, 10);
  assert.equal(open[0].jobId, id);
  assert.equal(open[0].reason, 'PERMANENT');
});

test('releaseStuck only takes jobs older than the threshold', { skip }, async () => {
  await pool.query('DELETE FROM sync_jobs WHERE tenant_id = $1', [tenantId]);
  const id = await repo.enqueue(spec());
  await repo.claim('w1', 1);

  assert.equal(await repo.releaseStuck(120000), 0, 'a job claimed a second ago is not stuck');

  await pool.query(`UPDATE sync_jobs SET locked_at = now() - interval '10 minutes' WHERE id = $1`, [id]);
  assert.equal(await repo.releaseStuck(120000), 1);

  const { rows } = await pool.query('SELECT status FROM sync_jobs WHERE id = $1', [id]);
  assert.equal(rows[0].status, 'pending');
});

test('requeue pushes run_after into the future', { skip }, async () => {
  await pool.query('DELETE FROM sync_jobs WHERE tenant_id = $1', [tenantId]);
  const id = await repo.enqueue(spec());
  await repo.claim('w1', 1);

  await repo.requeue(id, 'service unavailable', 60000);

  const claimedNow = await repo.claim('w1', 10);
  assert.equal(claimedNow.length, 0, 'a backed-off job must not be claimable yet');
});

test('stats reports the oldest pending age, not just a count', { skip }, async () => {
  await pool.query('DELETE FROM sync_jobs WHERE tenant_id = $1', [tenantId]);
  const id = await repo.enqueue(spec());
  await pool.query(`UPDATE sync_jobs SET run_after = now() - interval '5 minutes' WHERE id = $1`, [id]);

  const s = await repo.stats(tenantId);
  assert.equal(s.pending, 1);
  assert.ok(s.oldestPendingSec >= 299, `expected ~300s, got ${s.oldestPendingSec}`);
});

test('enqueueMany writes a batch in one statement', { skip }, async () => {
  await pool.query('DELETE FROM sync_jobs WHERE tenant_id = $1', [tenantId]);
  const written = await repo.enqueueMany([
    spec({ dedupeKey: `b1-${Date.now()}` }),
    spec({ dedupeKey: `b2-${Date.now()}` }),
    spec({ dedupeKey: `b3-${Date.now()}` }),
  ]);
  assert.equal(written, 3);
  assert.equal(await repo.enqueueMany([]), 0);
});
