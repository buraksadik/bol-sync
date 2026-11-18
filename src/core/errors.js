/**
 * Error classification.
 *
 * Mapping follows bol's own "Retryable" column in the conventions page
 * (403 is retryable there, 400 is not), plus the behaviour we want per case.
 */

/** @typedef {'PERMANENT'|'TRANSIENT'|'TOKEN'|'RATE_LIMIT'|'CONFLICT'|'MISSING'} ErrorClass */

export class BolApiError extends Error {
  /**
   * @param {object} o
   * @param {number} o.status
   * @param {string} o.method
   * @param {string} o.path
   * @param {any} [o.body]        parsed Problem response
   * @param {number} [o.retryAfterSec]
   */
  constructor({ status, method, path, body, retryAfterSec }) {
    super(`${method} ${path} -> ${status}${body?.detail ? `: ${body.detail}` : ''}`);
    this.name = 'BolApiError';
    this.status = status;
    this.method = method;
    this.path = path;
    this.body = body;
    this.retryAfterSec = retryAfterSec ?? null;
    /** @type {string[]} */
    this.violations = body?.violations?.map((v) => `${v.name}: ${v.reason}`) ?? [];
  }
}

export class SourceError extends Error {}
export class RuleViolation extends Error {
  /** @param {string} reason @param {object} [detail] */
  constructor(reason, detail) {
    super(reason);
    this.name = 'RuleViolation';
    this.detail = detail ?? {};
  }
}

/**
 * @param {unknown} err
 * @returns {ErrorClass}
 */
export function classify(err) {
  if (err instanceof RuleViolation) return 'PERMANENT';
  if (err instanceof BolApiError) {
    switch (err.status) {
      case 400:
      case 405:
      case 422:
        return 'PERMANENT';
      case 401:
        return 'TOKEN';
      case 403:
        return 'TRANSIENT'; // bol marks this retryable
      case 404:
        return 'MISSING';
      case 409:
        return 'CONFLICT';
      case 429:
        return 'RATE_LIMIT';
      default:
        return err.status >= 500 ? 'TRANSIENT' : 'PERMANENT';
    }
  }
  // Network failures, aborts, timeouts.
  return 'TRANSIENT';
}

/**
 * @param {unknown} err
 * @returns {boolean}
 */
export function isRetryable(err) {
  const c = classify(err);
  return c === 'TRANSIENT' || c === 'RATE_LIMIT' || c === 'TOKEN' || c === 'CONFLICT';
}
