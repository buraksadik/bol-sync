import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Worker } from '../src/queue/worker.js';
import { CircuitBreaker } from '../src/core/circuitBreaker.js';
import { BolApiError, RuleViolation } from '../src/core/errors.js';

/** Records what the worker asked the queue to do. No database needed. */
class FakeJobsRepo {
  constructor() {
    this.calls = [];
    this.claimQueue = [];
    this.markDoneResult = 'done';
  }

  async claim() {
    return this.claimQueue.shift() ?? [];
  }

  async markDone(jobId) {
    this.calls.push(['markDone', jobId]);
    return this.markDoneResult;
  }

  async requeue(jobId, error, delayMs) {
    this.calls.push(['requeue', jobId, error, delayMs]);
  }

  async kill(job, reason, detail) {
    this.calls.push(['kill', job.id, reason, detail]);
  }

  async releaseStuck() {
    this.calls.push(['releaseStuck']);
    return 3;
  }

  last(kind) {
    return [...this.calls].reverse().find((c) => c[0] === kind);
  }
}

const WORKER_CONFIG = {
  id: 'test-worker',
  concurrency: 4,
  claimBatch: 10,
  pollIntervalMs: 5,
  maxAttempts: 6,
  backoffBaseMs: 1000,
  backoffMaxMs: 300000,
  stuckAfterMs: 120000,
};

/** @param {object} over */
function job(over = {}) {
  return {
    id: 1,
    tenantId: 't1',
    productId: 10,
    type: 'push_offer',
    dedupeKey: 't1:10:push_offer',
    payload: {},
    priority: 10,
    status: 'running',
    attempts: 1,
    maxAttempts: 6,
    runAfter: new Date(),
    ...over,
  };
}

/** @param {Record<string, Function>} handlers */
function makeWorker(handlers, repo = new FakeJobsRepo()) {
  const ctx = {
    pool: null,
    config: { worker: WORKER_CONFIG },
    clientFor: async () => ({}),
    log: null,
    repos: { jobs: repo },
  };
  const worker = new Worker({ ctx, handlers, circuit: new CircuitBreaker() });
  return { worker, repo };
}

test('a successful job is marked done', async () => {
  let ran = 0;
  const { worker, repo } = makeWorker({ push_offer: async () => { ran += 1; } });

  await worker.run(job());

  assert.equal(ran, 1);
  assert.deepEqual(repo.last('markDone'), ['markDone', 1]);
  assert.equal(worker.stats.done, 1);
});

test('a job that changed while running comes back as pending, not as an error', async () => {
  const { worker, repo } = makeWorker({ push_offer: async () => {} });
  repo.markDoneResult = 'pending';

  await worker.run(job());

  assert.equal(worker.stats.done, 1);
  assert.equal(worker.stats.killed, 0, 'a re-queued job is expected, not a failure');
});

test('an unknown job type is killed, not retried forever', async () => {
  const { worker, repo } = makeWorker({});

  await worker.run(job({ type: 'something_new' }));

  const killed = repo.last('kill');
  assert.equal(killed[2], 'NO_HANDLER');
  assert.equal(repo.last('requeue'), undefined, 'time does not fix a missing handler');
});

test('a permanent error goes straight to dead letters', async () => {
  const { worker, repo } = makeWorker({
    push_offer: async () => {
      throw new BolApiError({ status: 400, method: 'PATCH', path: '/retailer/offers/x' });
    },
  });

  await worker.run(job());

  const killed = repo.last('kill');
  assert.equal(killed[2], 'PERMANENT');
  assert.equal(killed[3].class, 'PERMANENT');
  assert.equal(worker.stats.killed, 1);
});

test('a permanent error does not count against the tenant circuit', async () => {
  const circuit = new CircuitBreaker({ threshold: 2 });
  const repo = new FakeJobsRepo();
  const ctx = {
    config: { worker: WORKER_CONFIG },
    log: null,
    repos: { jobs: repo },
  };
  const worker = new Worker({
    ctx,
    circuit,
    handlers: { push_offer: async () => { throw new RuleViolation('PRICE_OUT_OF_RANGE'); } },
  });

  await worker.run(job());
  await worker.run(job({ id: 2 }));
  await worker.run(job({ id: 3 }));

  assert.equal(circuit.isOpen('t1'), false, 'one bad SKU must not stall the tenant');
});

test('a transient error is requeued with backoff and counts against the circuit', async () => {
  const circuit = new CircuitBreaker({ threshold: 2 });
  const repo = new FakeJobsRepo();
  const worker = new Worker({
    ctx: { config: { worker: WORKER_CONFIG }, log: null, repos: { jobs: repo } },
    circuit,
    handlers: {
      push_offer: async () => {
        throw new BolApiError({ status: 503, method: 'PATCH', path: '/retailer/offers/x' });
      },
    },
  });

  await worker.run(job());
  const [, , , delayMs] = repo.last('requeue');
  // base 1000ms on attempt 1, +/- 20% jitter
  assert.ok(delayMs >= 800 && delayMs <= 1200, `unexpected backoff: ${delayMs}`);

  await worker.run(job({ id: 2 }));
  assert.equal(circuit.isOpen('t1'), true, 'two transient failures trip a threshold of two');
});

test('a 429 uses Retry-After exactly instead of guessing', async () => {
  const { worker, repo } = makeWorker({
    push_offer: async () => {
      throw new BolApiError({
        status: 429,
        method: 'PATCH',
        path: '/retailer/offers/x',
        retryAfterSec: 37,
      });
    },
  });

  await worker.run(job());

  assert.equal(repo.last('requeue')[3], 37000);
});

test('the last attempt is killed, not requeued', async () => {
  const { worker, repo } = makeWorker({
    push_offer: async () => {
      throw new BolApiError({ status: 503, method: 'PATCH', path: '/x' });
    },
  });

  await worker.run(job({ attempts: 6, maxAttempts: 6 }));

  assert.equal(repo.last('kill')[2], 'MAX_ATTEMPTS');
  assert.equal(repo.last('requeue'), undefined);
});

test('an open circuit requeues without touching the handler', async () => {
  const circuit = new CircuitBreaker({ threshold: 1, cooldownMs: 60000 });
  circuit.recordFailure('t1');

  let ran = 0;
  const repo = new FakeJobsRepo();
  const worker = new Worker({
    ctx: { config: { worker: WORKER_CONFIG }, log: null, repos: { jobs: repo } },
    circuit,
    handlers: { push_offer: async () => { ran += 1; } },
  });

  await worker.run(job());

  assert.equal(ran, 0, 'no bol call while the circuit is open');
  const [, , reason, delayMs] = repo.last('requeue');
  assert.equal(reason, 'CIRCUIT_OPEN');
  assert.ok(delayMs > 0, 'it must wait for the cooldown, not spin');
});

test('violations from bol are carried into the dead letter', async () => {
  const { worker, repo } = makeWorker({
    push_offer: async () => {
      throw new BolApiError({
        status: 400,
        method: 'PATCH',
        path: '/x',
        body: { violations: [{ name: 'stock.amount', reason: 'must be at most 999' }] },
      });
    },
  });

  await worker.run(job());

  assert.deepEqual(repo.last('kill')[3].violations, ['stock.amount: must be at most 999']);
});

test('the loop drains a batch, then stops cleanly', async () => {
  const done = [];
  const { worker, repo } = makeWorker({
    push_offer: async (j) => { done.push(j.id); },
  });
  repo.claimQueue.push([job({ id: 1 }), job({ id: 2 }), job({ id: 3 })]);

  const loop = worker.start();
  // Give the loop enough turns to drain the batch and hit the empty poll.
  await new Promise((r) => setTimeout(r, 40));
  await worker.stop();
  await loop;

  assert.deepEqual(done.sort(), [1, 2, 3]);
  assert.equal(worker.stats.claimed, 3);
  assert.equal(worker.inFlight.size, 0);
});

test('a failing claim does not kill the loop', async () => {
  const repo = new FakeJobsRepo();
  let first = true;
  repo.claim = async () => {
    if (first) {
      first = false;
      throw new Error('connection terminated');
    }
    return [];
  };

  const worker = new Worker({
    ctx: { config: { worker: WORKER_CONFIG }, log: null, repos: { jobs: repo } },
    handlers: {},
    circuit: new CircuitBreaker(),
  });

  const loop = worker.start();
  await new Promise((r) => setTimeout(r, 30));
  await worker.stop();
  await loop;

  assert.equal(first, false, 'the loop survived the database error and polled again');
});
