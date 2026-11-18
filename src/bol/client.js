/**
 * HTTP client for the Retailer API.
 *
 * Responsibilities, in order:
 *   1. spend a rate-limit token before the request leaves
 *   2. set Accept / Content-Type for the right API version
 *   3. attach the bearer token
 *   4. read X-RateLimit-Remaining back into the bucket
 *   5. turn non-2xx into a typed BolApiError
 *   6. write a redacted line into sync_log
 */

import { BolApiError } from '../core/errors.js';
import { bucketFor } from './rateLimits.js';

/** @typedef {import('../core/limiter.js').TenantLimiter} TenantLimiter */
/** @typedef {'v10'|'v11'} ApiVersion */

/**
 * @param {ApiVersion} version
 * @returns {string} e.g. 'application/vnd.retailer.v11+json'
 */
export function mediaType(version) {
  return `application/vnd.retailer.${version}+json`;
}

/**
 * @param {Response} res
 * @returns {Promise<any>}
 */
async function safeJson(res) {
  const text = await res.text().catch(() => '');
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 1000) };
  }
}

export class BolClient {
  /**
   * @param {object} o
   * @param {string} o.tenantId
   * @param {string} o.baseUrl
   * @param {ApiVersion} o.version
   * @param {import('./auth.js').TokenManager} o.tokens
   * @param {TenantLimiter} o.limiter
   * @param {number} o.timeoutMs
   * @param {(entry: object) => void} [o.auditSink]  writes to sync_log
   * @param {typeof fetch} [o.fetchImpl]
   */
  constructor({ tenantId, baseUrl, version, tokens, limiter, timeoutMs, auditSink, fetchImpl = fetch }) {
    this.tenantId = tenantId;
    this.baseUrl = baseUrl;
    this.version = version;
    this.tokens = tokens;
    this.limiter = limiter;
    this.timeoutMs = timeoutMs;
    this.auditSink = auditSink;
    this.fetchImpl = fetchImpl;
    /** Set per call by the handler so the audit row points at a product. */
    this.context = { productId: null, jobId: null };
  }

  /**
   * One request, rate limited and classified.
   *
   * On 401: invalidate the token, retry exactly once. A second 401 means the
   * credentials or the account are the problem, not the token.
   * On 429: read Retry-After, penalise the bucket, throw. The queue decides when.
   *
   * @param {object} o
   * @param {string} o.method
   * @param {string} o.path            starts with '/'
   * @param {Record<string, any>} [o.query]
   * @param {any} [o.body]
   * @param {ApiVersion} [o.version]   override, e.g. process-status is always v10
   * @param {boolean} [o.expectBody]   false for 204 responses
   * @returns {Promise<{ status: number, headers: Headers, body: any }>}
   * @throws {BolApiError}
   */
  async request({ method, path, query, body, version, expectBody = true }) {
    const apiVersion = version ?? this.version;
    const bucket = bucketFor(method, path);
    const url = buildUrl(this.baseUrl, path, query);

    for (let attempt = 0; ; attempt += 1) {
      // The token is spent before the request leaves, never after. Asking
      // forgiveness from a 429 costs a Retry-After that can run into minutes.
      await this.limiter.acquire(bucket);
      const token = await this.tokens.getToken(this.tenantId);

      const started = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);

      /** @type {Response} */
      let res;
      try {
        res = await this.fetchImpl(url, {
          method,
          headers: {
            Accept: mediaType(apiVersion),
            Authorization: `Bearer ${token}`,
            ...(body === undefined ? {} : { 'Content-Type': mediaType(apiVersion) }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (err) {
        this.#audit({
          method, path, body, status: null, response: { error: String(err) },
          durationMs: Date.now() - started,
        });
        throw err; // network / timeout: classify() calls this TRANSIENT
      } finally {
        clearTimeout(timer);
      }

      const rate = readRateHeaders(res.headers);
      // bol's own counter beats ours whenever it is lower: another tool on the
      // same seller account spends from the same limit, and only bol sees both.
      this.limiter.bucket(bucket).syncFromHeader(rate.remaining);

      // A 204 has no body; an error always does, whatever the caller expected.
      const payload = res.status === 204 || (!expectBody && res.ok) ? null : await safeJson(res);

      this.#audit({
        method, path, body, status: res.status, response: payload,
        durationMs: Date.now() - started,
      });

      if (res.ok) return { status: res.status, headers: res.headers, body: payload };

      if (res.status === 401 && attempt === 0) {
        // The token was good when we cached it and is not now. One retry with a
        // fresh one; a second 401 is a credentials problem and must surface.
        this.tokens.invalidate(this.tenantId);
        continue;
      }

      if (res.status === 429) {
        this.limiter.bucket(bucket).penalise(rate.retryAfterSec ?? 1);
      }

      throw new BolApiError({
        status: res.status,
        method,
        path,
        body: payload,
        retryAfterSec: rate.retryAfterSec ?? undefined,
      });
    }
  }

  /**
   * @param {object} entry
   * @returns {void}
   */
  #audit(entry) {
    if (!this.auditSink) return;
    try {
      this.auditSink({
        tenantId: this.tenantId,
        productId: this.context.productId,
        jobId: this.context.jobId,
        action: `${entry.method} ${entry.path}`,
        httpStatus: entry.status,
        request: entry.body === undefined ? null : redact(entry.body),
        response: entry.response === null ? null : redact(entry.response),
        durationMs: entry.durationMs,
      });
    } catch {
      // An audit that throws must never fail the call it was describing.
    }
  }

  /** @param {string} path @param {Record<string, any>} [query] */
  get(path, query) {
    return this.request({ method: 'GET', path, query });
  }

  /** @param {string} path @param {any} body */
  post(path, body) {
    return this.request({ method: 'POST', path, body });
  }

  /** @param {string} path @param {any} body */
  patch(path, body) {
    return this.request({ method: 'PATCH', path, body, expectBody: false });
  }

  /** @param {string} path @param {any} body */
  put(path, body) {
    return this.request({ method: 'PUT', path, body });
  }

  /** @param {string} path */
  delete(path) {
    return this.request({ method: 'DELETE', path, expectBody: false });
  }
}

/**
 * Array filters repeat the key — `eans=a&eans=b` — which is the OpenAPI default
 * (form style, explode true) and what the v11 spec leaves unspecified. A
 * comma-joined list would be read as one very long EAN.
 *
 * @param {string} baseUrl
 * @param {string} path
 * @param {Record<string, any>} [query]
 * @returns {string}
 */
export function buildUrl(baseUrl, path, query) {
  const url = new URL(path, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      for (const v of value) url.searchParams.append(key, String(v));
    } else {
      url.searchParams.append(key, String(value));
    }
  }
  return url.toString();
}

/**
 * Pull the rate-limit headers out of a response.
 *
 * @param {Headers} headers
 * @returns {{ limit: number|null, remaining: number|null, resetSec: number|null, retryAfterSec: number|null }}
 */
export function readRateHeaders(headers) {
  const num = (v) => {
    if (v == null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  return {
    limit: num(headers.get('X-RateLimit-Limit')),
    remaining: num(headers.get('X-RateLimit-Remaining')),
    resetSec: num(headers.get('X-RateLimit-Reset')),
    retryAfterSec: num(headers.get('Retry-After')),
  };
}

/**
 * Never let a secret reach the log table.
 *
 * @param {object} payload
 * @returns {object}
 */
export function redact(payload) {
  const SENSITIVE = /secret|authorization|token|password/i;
  const walk = (v) => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      return Object.fromEntries(
        Object.entries(v).map(([k, val]) => [k, SENSITIVE.test(k) ? '[redacted]' : walk(val)]),
      );
    }
    return v;
  };
  return walk(payload);
}

export { bucketFor, BolApiError };
