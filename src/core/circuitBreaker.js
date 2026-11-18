/**
 * Per-tenant circuit breaker.
 *
 * One client's broken credentials or blocked account must not stall the queue
 * for everyone else.
 */

export class CircuitBreaker {
  /**
   * @param {object} [o]
   * @param {number} [o.windowMs]    rolling window
   * @param {number} [o.threshold]   transient failures in the window before opening
   * @param {number} [o.cooldownMs]  how long the circuit stays open
   * @param {() => number} [o.now]
   */
  constructor({ windowMs = 60000, threshold = 10, cooldownMs = 300000, now = Date.now } = {}) {
    this.windowMs = windowMs;
    this.threshold = threshold;
    this.cooldownMs = cooldownMs;
    this.now = now;
    /** @type {Map<string, number[]>} tenantId -> failure timestamps */
    this.failures = new Map();
    /** @type {Map<string, number>} tenantId -> open until (epoch ms) */
    this.openUntil = new Map();
  }

  /** @param {string} tenantId @returns {boolean} */
  isOpen(tenantId) {
    const until = this.openUntil.get(tenantId);
    if (!until) return false;
    if (this.now() >= until) {
      this.openUntil.delete(tenantId);
      this.failures.delete(tenantId);
      return false;
    }
    return true;
  }

  /** @param {string} tenantId @returns {number} ms until the circuit closes */
  retryAfterMs(tenantId) {
    return Math.max(0, (this.openUntil.get(tenantId) ?? 0) - this.now());
  }

  /** @param {string} tenantId */
  recordSuccess(tenantId) {
    this.failures.delete(tenantId);
  }

  /**
   * @param {string} tenantId
   * @returns {boolean} true when this failure opened the circuit
   */
  recordFailure(tenantId) {
    const t = this.now();
    const list = (this.failures.get(tenantId) ?? []).filter((ts) => t - ts < this.windowMs);
    list.push(t);
    this.failures.set(tenantId, list);
    if (list.length >= this.threshold) {
      this.openUntil.set(tenantId, t + this.cooldownMs);
      return true;
    }
    return false;
  }
}

export const breaker = new CircuitBreaker();
