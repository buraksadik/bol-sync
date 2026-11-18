/**
 * Backoff for queued jobs.
 *
 * Jitter is not decoration. Without it every job that failed in the same 429
 * wave wakes at the same millisecond and produces the next 429 wave.
 */

import { BolApiError, classify } from './errors.js';

/**
 * @param {object} o
 * @param {number} o.attempt     1-based attempt that just failed
 * @param {number} [o.baseMs]
 * @param {number} [o.maxMs]
 * @param {number} [o.jitterPct] +/- percentage
 * @param {() => number} [o.random]
 * @returns {number} delay in ms
 */
export function backoffMs({
  attempt,
  baseMs = 1000,
  maxMs = 300000,
  jitterPct = 20,
  random = Math.random,
}) {
  const raw = Math.min(baseMs * 2 ** Math.max(0, attempt - 1), maxMs);
  const spread = (raw * jitterPct) / 100;
  const delta = (random() * 2 - 1) * spread;
  return Math.max(0, Math.round(raw + delta));
}

/**
 * Delay before this job may run again, or null when it must not.
 *
 * @param {unknown} err
 * @param {object} o
 * @param {number} o.attempt
 * @param {number} o.maxAttempts
 * @param {number} [o.baseMs]
 * @param {number} [o.maxMs]
 * @returns {{ requeue: false, reason: string } | { requeue: true, delayMs: number }}
 */
export function nextAttempt(err, { attempt, maxAttempts, baseMs, maxMs }) {
  const cls = classify(err);

  if (cls === 'PERMANENT') return { requeue: false, reason: 'PERMANENT' };
  if (attempt >= maxAttempts) return { requeue: false, reason: 'MAX_ATTEMPTS' };

  // 429 carries an exact answer. Use it, do not guess.
  if (cls === 'RATE_LIMIT' && err instanceof BolApiError && err.retryAfterSec != null) {
    return { requeue: true, delayMs: err.retryAfterSec * 1000 };
  }
  // A token refresh is instant; no point waiting.
  if (cls === 'TOKEN') return { requeue: true, delayMs: 0 };
  // A conflict means our view is stale. Re-read, then try once more soon.
  if (cls === 'CONFLICT') return { requeue: true, delayMs: 2000 };

  return { requeue: true, delayMs: backoffMs({ attempt, baseMs, maxMs }) };
}
