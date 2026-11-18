import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildSchedules, dailyDue, Scheduler } from '../src/queue/scheduler.js';
import { PRIORITY } from '../src/sync/differ.js';

const CONFIG = {
  schedule: {
    pullSourceIntervalMin: 10,
    reconcileIntervalMin: 15,
    reconcileFullAt: '03:30',
  },
  worker: { stuckAfterMs: 120000 },
};

class FakeJobsRepo {
  constructor() {
    this.enqueued = [];
    this.released = 0;
    this.deadLetters = [];
  }

  async enqueueMany(jobs) {
    this.enqueued.push(...jobs);
    return jobs.length;
  }

  async releaseStuck() {
    this.released += 1;
    return 2;
  }

  async openDeadLetters() {
    return this.deadLetters;
  }
}

function makeCtx(tenants = [{ id: 't1' }, { id: 't2' }]) {
  const repo = new FakeJobsRepo();
  return {
    ctx: {
      config: CONFIG,
      log: null,
      repos: { jobs: repo },
      listActiveTenants: async () => tenants,
    },
    repo,
  };
}

test('dailyDue fires once past the hour and not again that day', () => {
  const at0329 = new Date('2026-11-18T03:29:00');
  const at0331 = new Date('2026-11-18T03:31:00');

  assert.equal(dailyDue('03:30', null, at0329).due, false);

  const first = dailyDue('03:30', null, at0331);
  assert.equal(first.due, true);
  assert.equal(first.day, '2026-11-18');

  // same day again -> not due
  assert.equal(dailyDue('03:30', first.day, at0331).due, false);
  // next day -> due again
  assert.equal(dailyDue('03:30', first.day, new Date('2026-11-19T03:31:00')).due, true);
});

test('pull_source enqueues one deduped job per tenant', async () => {
  const { ctx, repo } = makeCtx();
  const schedules = buildSchedules(CONFIG);
  const pull = schedules.find((s) => s.name === 'pull_source');

  assert.equal(pull.intervalMs, 10 * 60000);
  await pull.tick(ctx);

  assert.equal(repo.enqueued.length, 2);
  assert.deepEqual(repo.enqueued.map((j) => j.dedupeKey), [
    't1:pull_source',
    't2:pull_source',
  ]);
  assert.equal(repo.enqueued[0].priority, PRIORITY.PULL_SOURCE);
});

test('a second tick reuses the same dedupe key, so the queue cannot pile up', async () => {
  const { ctx, repo } = makeCtx();
  const pull = buildSchedules(CONFIG).find((s) => s.name === 'pull_source');

  await pull.tick(ctx);
  await pull.tick(ctx);

  const keys = new Set(repo.enqueued.map((j) => j.dedupeKey));
  assert.equal(keys.size, 2, 'four enqueues, two keys: the unique index collapses them');
});

test('incremental and full reconcile use different dedupe keys', async () => {
  const { ctx, repo } = makeCtx([{ id: 't1' }]);
  const schedules = buildSchedules(CONFIG);

  await schedules.find((s) => s.name === 'reconcile_incremental').tick(ctx);
  assert.equal(repo.enqueued[0].dedupeKey, 't1:reconcile:incremental');
  assert.equal(repo.enqueued[0].payload.mode, 'incremental');

  // A full reconcile must never collapse into a pending incremental one.
  assert.notEqual(repo.enqueued[0].dedupeKey, 't1:reconcile:full');
});

test('release_stuck runs every minute and does not need tenants', async () => {
  const { ctx, repo } = makeCtx([]);
  const release = buildSchedules(CONFIG).find((s) => s.name === 'release_stuck');

  assert.equal(release.intervalMs, 60000);
  await release.tick(ctx);
  assert.equal(repo.released, 1);
});

test('no tenants means no jobs, not an empty insert', async () => {
  const { ctx, repo } = makeCtx([]);
  for (const s of buildSchedules(CONFIG)) {
    if (s.name !== 'release_stuck') await s.tick(ctx);
  }
  assert.equal(repo.enqueued.length, 0);
});

test('a failing tick does not take the scheduler down', async () => {
  const { ctx } = makeCtx();
  const errors = [];
  ctx.log = { error: (o) => errors.push(o), warn() {}, info() {}, debug() {} };

  const scheduler = new Scheduler({
    ctx,
    schedules: [
      {
        name: 'boom',
        intervalMs: 5,
        tick: async () => {
          throw new Error('postgres is down');
        },
      },
    ],
  });

  scheduler.start();
  await new Promise((r) => setTimeout(r, 30));
  scheduler.stop();

  assert.ok(errors.length >= 1);
  assert.equal(errors[0].schedule, 'boom');
});

test('a slow tick does not stack up behind itself', async () => {
  const { ctx } = makeCtx();
  let started = 0;
  const scheduler = new Scheduler({
    ctx,
    schedules: [
      {
        name: 'slow',
        intervalMs: 5,
        tick: async () => {
          started += 1;
          await new Promise((r) => setTimeout(r, 60));
        },
      },
    ],
  });

  scheduler.start();
  await new Promise((r) => setTimeout(r, 45));
  scheduler.stop();

  assert.equal(started, 1, 'the timer fired many times but only one tick ran');
});

test('runNow refuses an unknown schedule instead of doing nothing', async () => {
  const { ctx } = makeCtx();
  const scheduler = new Scheduler({ ctx, schedules: buildSchedules(CONFIG) });
  await assert.rejects(() => scheduler.runNow('nope'), /unknown schedule/);
});
