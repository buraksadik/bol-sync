/**
 * Queue worker.
 *
 * Claims jobs with FOR UPDATE SKIP LOCKED, so several workers can run against
 * the same database without a lock server.
 */

import { nextAttempt } from '../core/retry.js';
import { classify } from '../core/errors.js';
import { breaker } from '../core/circuitBreaker.js';
import { sleep } from '../core/limiter.js';

/** @typedef {import('../db/repositories/jobs.repo.js').Job} Job */
/** @typedef {import('../db/repositories/jobs.repo.js').JobsRepo} JobsRepo */

/**
 * @typedef {(job: Job, ctx: WorkerContext) => Promise<void>} JobHandler
 */

/**
 * @typedef {object} WorkerContext
 * @property {import('pg').Pool} pool
 * @property {import('../config.js').Config} config
 * @property {(tenantId: string) => Promise<import('../bol/client.js').BolClient>} clientFor
 * @property {import('pino').Logger} log
 * @property {{ jobs: JobsRepo }} repos
 */

/** Failure classes that say something about the tenant, not about the job. */
const TENANT_FAULTS = new Set(['TRANSIENT', 'TOKEN', 'RATE_LIMIT']);

export class Worker {
  /**
   * @param {object} o
   * @param {WorkerContext} o.ctx
   * @param {Record<string, JobHandler>} o.handlers  keyed by job type
   * @param {import('../core/circuitBreaker.js').CircuitBreaker} [o.circuit]
   */
  constructor({ ctx, handlers, circuit = breaker }) {
    this.ctx = ctx;
    this.handlers = handlers;
    this.circuit = circuit;
    this.running = false;
    /** @type {AbortController} */
    this.abort = new AbortController();
    /** @type {Set<Promise<void>>} */
    this.inFlight = new Set();
    this.stats = { claimed: 0, done: 0, requeued: 0, killed: 0 };
  }

  /**
   * Poll loop. Claims up to WORKER_CLAIM_BATCH jobs and runs at most
   * WORKER_CONCURRENCY of them at a time.
   *
   * @returns {Promise<void>}
   */
  async start() {
    if (this.running) return;
    this.running = true;
    const { pollIntervalMs } = this.ctx.config.worker;

    while (this.running) {
      /** @type {Job[]} */
      let jobs = [];
      try {
        jobs = await this.claim();
      } catch (err) {
        // A database hiccup must not kill the loop; the next tick retries.
        this.ctx.log?.error({ err }, 'claim failed');
      }

      if (jobs.length === 0) {
        await sleep(pollIntervalMs, this.abort.signal).catch(() => {});
        continue;
      }

      this.stats.claimed += jobs.length;
      await this.#runAll(jobs);
    }
  }

  /**
   * Run a batch at most `concurrency` at a time.
   *
   * @param {Job[]} jobs
   * @returns {Promise<void>}
   */
  async #runAll(jobs) {
    const { concurrency } = this.ctx.config.worker;
    const queue = [...jobs];

    const lane = async () => {
      while (queue.length > 0) {
        const job = queue.shift();
        if (!job) return;
        const p = this.run(job).finally(() => this.inFlight.delete(p));
        this.inFlight.add(p);
        await p;
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(concurrency, jobs.length) }, () => lane()),
    );
  }

  /** Finish in-flight jobs, then stop. @returns {Promise<void>} */
  async stop() {
    this.running = false;
    this.abort.abort(); // wakes the poll sleep immediately
    await Promise.allSettled([...this.inFlight]);
  }

  /**
   * Claim a batch:
   *
   *   UPDATE sync_jobs SET status='running', locked_by=$1, locked_at=now()
   *   WHERE id IN (
   *     SELECT id FROM sync_jobs
   *     WHERE status='pending' AND run_after <= now()
   *     ORDER BY priority ASC, run_after ASC
   *     FOR UPDATE SKIP LOCKED LIMIT $2
   *   ) RETURNING *;
   *
   * @returns {Promise<Job[]>}
   */
  async claim() {
    const { id, claimBatch } = this.ctx.config.worker;
    return this.ctx.repos.jobs.claim(id, claimBatch);
  }

  /**
   * Run one job and settle it.
   *
   * Failure path, in order:
   *   1. classify the error
   *   2. ask retry.nextAttempt whether and when to requeue
   *   3. PERMANENT or MAX_ATTEMPTS -> dead_letters, status 'dead'
   *   4. record the failure against the tenant's circuit breaker
   *
   * @param {Job} job
   * @returns {Promise<void>}
   */
  async run(job) {
    const { jobs } = this.ctx.repos;

    // One tenant's broken credentials must not burn every other tenant's
    // attempts. Put the job back without touching the handler.
    if (this.circuit.isOpen(job.tenantId)) {
      const delayMs = this.circuit.retryAfterMs(job.tenantId);
      await jobs.requeue(job.id, 'CIRCUIT_OPEN', delayMs);
      this.stats.requeued += 1;
      return;
    }

    const handler = this.handlers[job.type];
    if (!handler) {
      // Not retryable by definition: a redeploy is what fixes it, not time.
      await jobs.kill(job, 'NO_HANDLER', { type: job.type });
      this.stats.killed += 1;
      this.ctx.log?.error({ jobId: job.id, type: job.type }, 'no handler for job type');
      return;
    }

    try {
      await handler(job, this.ctx);
      const status = await jobs.markDone(job.id);
      this.circuit.recordSuccess(job.tenantId);
      this.stats.done += 1;
      if (status === 'pending') {
        // The product changed again while we were pushing. Expected, not an error.
        this.ctx.log?.debug({ jobId: job.id }, 'job re-queued: changed while running');
      }
    } catch (err) {
      await this.#fail(job, err);
    }
  }

  /**
   * @param {Job} job
   * @param {unknown} err
   * @returns {Promise<void>}
   */
  async #fail(job, err) {
    const { jobs } = this.ctx.repos;
    const { maxAttempts, backoffBaseMs, backoffMaxMs } = this.ctx.config.worker;
    const cls = classify(err);
    const message = err instanceof Error ? err.message : String(err);

    // Only a tenant-shaped failure counts against the tenant. A malformed SKU
    // is this job's problem; tripping the breaker on it would stall the others.
    if (TENANT_FAULTS.has(cls)) {
      const opened = this.circuit.recordFailure(job.tenantId);
      if (opened) {
        this.ctx.log?.warn({ tenantId: job.tenantId, cls }, 'circuit opened');
      }
    }

    const verdict = nextAttempt(err, {
      attempt: job.attempts,
      maxAttempts: job.maxAttempts ?? maxAttempts,
      baseMs: backoffBaseMs,
      maxMs: backoffMaxMs,
    });

    if (verdict.requeue) {
      await jobs.requeue(job.id, message, verdict.delayMs);
      this.stats.requeued += 1;
      this.ctx.log?.debug(
        { jobId: job.id, cls, attempt: job.attempts, delayMs: verdict.delayMs },
        'job requeued',
      );
      return;
    }

    await jobs.kill(job, verdict.reason, {
      class: cls,
      message,
      attempts: job.attempts,
      type: job.type,
      ...(/** @type {any} */ (err)?.violations?.length
        ? { violations: /** @type {any} */ (err).violations }
        : {}),
    });
    this.stats.killed += 1;
    this.ctx.log?.error({ jobId: job.id, cls, reason: verdict.reason }, 'job dead');
  }

  /**
   * Jobs whose worker died keep status 'running' forever. Anything locked longer
   * than JOB_STUCK_AFTER_MS goes back to 'pending'.
   *
   * @returns {Promise<number>} rows released
   */
  async releaseStuck() {
    const released = await this.ctx.repos.jobs.releaseStuck(this.ctx.config.worker.stuckAfterMs);
    if (released > 0) this.ctx.log?.warn({ released }, 'released stuck jobs');
    return released;
  }
}

export { nextAttempt, classify, breaker };
