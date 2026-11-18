/**
 * OAuth2 client credentials against https://login.bol.com/token
 *
 * The token lives 299 seconds. bol's own documentation warns that requesting a
 * token per API call overloads the auth service and gets the IP banned, and the
 * auth service's limits are far tighter than the API's. So: one token per
 * tenant, cached, refreshed early, and refreshed by at most one caller at a time.
 */

import { BolApiError } from '../core/errors.js';
import { encryptSecret, decryptSecret } from '../core/secrets.js';

/**
 * @typedef {object} TokenSet
 * @property {string} accessToken
 * @property {number} expiresAt  epoch ms
 * @property {string} scope
 */

/**
 * Parse a response body without throwing on an empty or non-JSON one.
 *
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

export class TokenManager {
  /**
   * @param {object} o
   * @param {string} o.tokenUrl
   * @param {number} o.refreshMarginSec  refresh this many seconds before expiry
   * @param {(tenantId: string) => Promise<{ clientId: string, clientSecret: string }>} o.credentialsLoader
   * @param {typeof fetch} [o.fetchImpl]
   * @param {() => number} [o.now]
   */
  constructor({ tokenUrl, refreshMarginSec, credentialsLoader, fetchImpl = fetch, now = Date.now }) {
    this.tokenUrl = tokenUrl;
    this.refreshMarginSec = refreshMarginSec;
    this.credentialsLoader = credentialsLoader;
    this.fetchImpl = fetchImpl;
    this.now = now;
    /** @type {Map<string, TokenSet>} */
    this.cache = new Map();
    /** @type {Map<string, Promise<TokenSet>>} single-flight guard */
    this.inFlight = new Map();
    this.stats = { requests: 0, hits: 0 };
  }

  /**
   * Cached token, refreshed when inside the margin.
   * Concurrent callers for the same tenant share one request.
   *
   * The single-flight map is the part that matters. Eight worker lanes starting
   * at once on a cold cache would otherwise fire eight token requests at an
   * endpoint whose limits are undocumented and tight — the exact behaviour
   * bol's own documentation says gets an IP banned.
   *
   * @param {string} tenantId
   * @returns {Promise<string>} the bearer value, without the "Bearer " prefix
   */
  async getToken(tenantId) {
    const cached = this.cache.get(tenantId);
    if (cached && this.now() < cached.expiresAt - this.refreshMarginSec * 1000) {
      this.stats.hits += 1;
      return cached.accessToken;
    }

    let flight = this.inFlight.get(tenantId);
    if (!flight) {
      flight = this.#request(tenantId);
      this.inFlight.set(tenantId, flight);
      // Clear the slot whether it resolved or threw, so a failure does not
      // pin every later caller to the same rejected promise.
      //
      // The trailing catch is not decoration. `.finally()` returns a NEW
      // promise that rejects with the same error, and nobody awaits that one —
      // which makes a failed token request an unhandledRejection, and Node
      // kills the process on those by default. The real error still reaches the
      // caller through `await flight` below.
      flight
        .finally(() => {
          if (this.inFlight.get(tenantId) === flight) this.inFlight.delete(tenantId);
        })
        .catch(() => {});
    }

    const set = await flight;
    return set.accessToken;
  }

  /**
   * Drop the cached token. Called once after a 401 before retrying the request.
   *
   * @param {string} tenantId
   * @returns {void}
   */
  invalidate(tenantId) {
    this.cache.delete(tenantId);
  }

  /**
   * POST grant_type=client_credentials with Basic auth.
   * Headers: Content-Type application/x-www-form-urlencoded, Accept application/json.
   * The auth service only supports Accept: application/json.
   *
   * @param {string} tenantId
   * @returns {Promise<TokenSet>}
   */
  async #request(tenantId) {
    const { clientId, clientSecret } = await this.credentialsLoader(tenantId);
    const basic = Buffer.from(`${clientId}:${clientSecret}`, 'utf8').toString('base64');

    this.stats.requests += 1;
    const res = await this.fetchImpl(this.tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        Authorization: `Basic ${basic}`,
      },
      body: 'grant_type=client_credentials',
    });

    const body = await safeJson(res);
    if (!res.ok) {
      throw new BolApiError({
        status: res.status,
        method: 'POST',
        path: '/token',
        body,
        retryAfterSec: Number(res.headers?.get?.('Retry-After')) || undefined,
      });
    }
    if (!body?.access_token) {
      throw new BolApiError({
        status: res.status,
        method: 'POST',
        path: '/token',
        body: { detail: 'token response has no access_token' },
      });
    }

    // expires_in is seconds and bol sends 299. If it ever stops sending one,
    // assume the documented lifetime rather than treating the token as eternal.
    const lifetimeSec = Number(body.expires_in) > 0 ? Number(body.expires_in) : 299;

    /** @type {TokenSet} */
    const set = {
      accessToken: body.access_token,
      expiresAt: this.now() + lifetimeSec * 1000,
      scope: body.scope ?? '',
    };
    this.cache.set(tenantId, set);
    return set;
  }
}

// The crypto lives in core/secrets.js; re-exported here because this is where
// callers expect to find it.
export { encryptSecret, decryptSecret };
