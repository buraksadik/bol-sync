/**
 * Token bucket with two sources of truth.
 *
 * Local accounting keeps us under the published limit. Bol's own
 * `X-RateLimit-Remaining` header overrides it whenever it is stricter — the
 * client's other tools spend from the same account-level bucket, so our count
 * is always optimistic.
 */

import { budgeted } from '../bol/rateLimits.js';

/** @typedef {import('../bol/rateLimits.js').BucketName} BucketName */

export class TokenBucket {
  /**
   * @param {{ capacity: number, refillPerSec: number, now?: () => number }} opts
   */
  constructor({ capacity, refillPerSec, now = Date.now }) {
    this.capacity = capacity;
    this.refillPerSec = refillPerSec;
    this.tokens = capacity;
    this.now = now;
    this.updatedAt = now();
    /** @type {number} epoch ms; set from Retry-After */
    this.blockedUntil = 0;
  }

  #refill() {
    const t = this.now();
    const elapsed = (t - this.updatedAt) / 1000;
    if (elapsed > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerSec);
      this.updatedAt = t;
    }
  }

  /**
   * Milliseconds to wait before a token is available. 0 means go now.
   * @returns {number}
   */
  delayMs() {
    this.#refill();
    const blocked = Math.max(0, this.blockedUntil - this.now());
    if (this.tokens >= 1) return blocked;
    const need = (1 - this.tokens) / this.refillPerSec;
    return Math.max(blocked, Math.ceil(need * 1000));
  }

  /** Spend one token. Call only after waiting out `delayMs()`. */
  take() {
    this.#refill();
    this.tokens = Math.max(0, this.tokens - 1);
  }

  /**
   * Trust bol's header over our own count when it is lower.
   * @param {number|null} remaining value of X-RateLimit-Remaining
   */
  syncFromHeader(remaining) {
    if (remaining == null || Number.isNaN(remaining)) return;
    this.tokens = Math.min(this.tokens, remaining);
  }

  /**
   * Handle a 429. Empty the bucket and hold until Retry-After passes.
   * @param {number} retryAfterSec
   */
  penalise(retryAfterSec) {
    this.tokens = 0;
    this.blockedUntil = this.now() + Math.max(1, retryAfterSec) * 1000;
  }
}

/**
 * One bucket set per tenant. Workers in the same process share it.
 * Across processes, persist to `rate_buckets` (see RateBucketStore below).
 */
export class TenantLimiter {
  /**
   * @param {{ tenantId: string, budgetPct: number }} opts
   */
  constructor({ tenantId, budgetPct }) {
    this.tenantId = tenantId;
    this.budgetPct = budgetPct;
    /** @type {Map<BucketName, TokenBucket>} */
    this.buckets = new Map();
  }

  /**
   * @param {BucketName} name
   * @returns {TokenBucket}
   */
  bucket(name) {
    let b = this.buckets.get(name);
    if (!b) {
      b = new TokenBucket(budgeted(name, this.budgetPct));
      this.buckets.set(name, b);
    }
    return b;
  }

  /**
   * Block until a token is free, then spend it.
   * @param {BucketName} name
   * @param {AbortSignal} [signal]
   * @returns {Promise<void>}
   */
  async acquire(name, signal) {
    const b = this.bucket(name);
    for (;;) {
      const wait = b.delayMs();
      if (wait === 0) {
        b.take();
        return;
      }
      await sleep(wait, signal);
    }
  }
}

/**
 * @param {number} ms
 * @param {AbortSignal} [signal]
 * @returns {Promise<void>}
 */
export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new Error('aborted'));
      },
      { once: true },
    );
  });
}

/**
 * Persistence for multi-process deployments. Backed by `rate_buckets`.
 * Single-process installs can skip it entirely.
 */
export class RateBucketStore {
  /**
   * @param {import('pg').Pool} pool
   * @param {number} [budgetPct] used when a bucket row has to be created
   */
  constructor(pool, budgetPct = 60) {
    this.pool = pool;
    this.budgetPct = budgetPct;
  }

  /**
   * Atomically refill and spend one token in SQL, so two workers cannot both
   * believe they had the last token.
   *
   * The whole thing is one statement. Reading the row, deciding, and writing it
   * back as three statements is the classic way to blow a rate limit: both
   * workers read "1 token left", both decide yes, and bol sees two requests.
   * `FOR UPDATE` serialises them, and the refill is computed from the row's own
   * `updated_at` so no clock but Postgres's is involved.
   *
   * @param {string} tenantId
   * @param {BucketName} bucket
   * @param {number} [budgetPct]
   * @returns {Promise<{ granted: boolean, retryAfterMs: number }>}
   */
  async tryTake(tenantId, bucket, budgetPct = this.budgetPct) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const { rows } = await this.pool.query(
        `WITH cur AS (
           SELECT tokens, capacity, refill_per_sec, blocked_until, updated_at
             FROM rate_buckets
            WHERE tenant_id = $1 AND bucket = $2
            FOR UPDATE
         ),
         calc AS (
           SELECT LEAST(
                    capacity,
                    tokens + EXTRACT(EPOCH FROM (now() - updated_at)) * refill_per_sec
                  ) AS refilled,
                  refill_per_sec,
                  blocked_until,
                  (blocked_until IS NULL OR blocked_until <= now()) AS unblocked
             FROM cur
         )
         UPDATE rate_buckets b
            SET tokens = CASE WHEN calc.unblocked AND calc.refilled >= 1
                              THEN calc.refilled - 1
                              ELSE calc.refilled END,
                updated_at = now()
           FROM calc
          WHERE b.tenant_id = $1 AND b.bucket = $2
          RETURNING calc.unblocked, calc.refilled, calc.refill_per_sec,
                    EXTRACT(EPOCH FROM (calc.blocked_until - now())) AS blocked_for_sec`,
        [tenantId, bucket],
      );

      if (rows.length === 0) {
        await this.#seed(tenantId, bucket, budgetPct);
        continue;
      }

      const r = rows[0];
      const refilled = Number(r.refilled);
      const refillPerSec = Number(r.refill_per_sec);

      if (r.unblocked && refilled >= 1) return { granted: true, retryAfterMs: 0 };

      const blockedMs = Math.max(0, Math.ceil(Number(r.blocked_for_sec ?? 0) * 1000));
      const refillMs = refillPerSec > 0 ? Math.ceil(((1 - refilled) / refillPerSec) * 1000) : 1000;
      return { granted: false, retryAfterMs: Math.max(blockedMs, refillMs, 1) };
    }
    // Two seeds in a row failing means the tenant row is gone. Back off rather
    // than spin: the scheduler will stop enqueueing for it shortly anyway.
    return { granted: false, retryAfterMs: 1000 };
  }

  /**
   * @param {string} tenantId
   * @param {BucketName} bucket
   * @param {number} budgetPct
   * @returns {Promise<void>}
   */
  async #seed(tenantId, bucket, budgetPct) {
    const { capacity, refillPerSec } = budgeted(bucket, budgetPct);
    await this.pool.query(
      `INSERT INTO rate_buckets (tenant_id, bucket, tokens, capacity, refill_per_sec)
       VALUES ($1, $2, $3, $3, $4)
       ON CONFLICT (tenant_id, bucket) DO NOTHING`,
      [tenantId, bucket, capacity, refillPerSec],
    );
  }

  /**
   * A 429 is bol telling us exactly how long to wait. Empty the bucket and hold
   * it, so every worker in every process stops at the same moment.
   *
   * @param {string} tenantId
   * @param {BucketName} bucket
   * @param {number} retryAfterSec
   * @returns {Promise<void>}
   */
  async penalise(tenantId, bucket, retryAfterSec) {
    await this.pool.query(
      `UPDATE rate_buckets
          SET tokens = 0,
              blocked_until = now() + make_interval(secs => $3),
              updated_at = now()
        WHERE tenant_id = $1 AND bucket = $2`,
      [tenantId, bucket, Math.max(1, retryAfterSec)],
    );
  }
}

/** @type {Map<string, TenantLimiter>} */
const registry = new Map();

/**
 * @param {string} tenantId
 * @param {number} budgetPct
 * @returns {TenantLimiter}
 */
export function limiterFor(tenantId, budgetPct) {
  let l = registry.get(tenantId);
  if (!l) {
    l = new TenantLimiter({ tenantId, budgetPct });
    registry.set(tenantId, l);
  }
  return l;
}
