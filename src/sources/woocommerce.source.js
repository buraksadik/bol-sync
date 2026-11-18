/**
 * WooCommerce source.
 *
 * WooCommerce is on about half of the Dutch webshops, so this is the adapter
 * that gets used most.
 *
 * REST v3: GET /wp-json/wc/v3/products?per_page=100&page=N
 * Auth: consumer key/secret as Basic auth over HTTPS.
 *
 * Two traps worth knowing:
 *   - variable products carry stock on the variation, not the parent. A parent
 *     with manage_stock=false and children that each have their own stock will
 *     report null at the top level.
 *   - `stock_quantity` is null when stock management is off. Null is not zero;
 *     treat it as "unknown" and skip the product rather than publishing 0.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { SourceError } from '../core/errors.js';

/** @typedef {import('./source.interface.js').Source} Source */
/** @typedef {import('./source.interface.js').SourceItem} SourceItem */

const PER_PAGE = 100;

/**
 * @param {object} config
 * @param {string} config.baseUrl
 * @param {string} config.consumerKey
 * @param {string} config.consumerSecret
 * @param {string} [config.eanMetaKey]   meta field holding the EAN, e.g. '_ean'
 * @param {string} [config.webhookSecret]
 * @param {typeof fetch} [config.fetchImpl]
 * @param {number} [config.timeoutMs]
 * @returns {Source}
 */
export function createWooCommerceSource(config) {
  if (!config?.baseUrl) throw new SourceError('WOO_BASE_URL_MISSING');
  if (!config.consumerKey || !config.consumerSecret) throw new SourceError('WOO_CREDENTIALS_MISSING');
  if (!/^https:/i.test(config.baseUrl)) {
    // Basic auth over plain HTTP hands the shop's keys to anyone on the path.
    throw new SourceError('WOO_BASE_URL_MUST_BE_HTTPS');
  }

  return {
    name: `woocommerce:${new URL(config.baseUrl).hostname}`,

    fetchAll: () => fetchAll(config),

    fetchBySku: (skus) => fetchBySku(config, skus),

    parseWebhook(raw, signature) {
      const rawBody = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw), 'utf8');
      if (!verifyWebhookSignature(rawBody, signature, config.webhookSecret ?? '')) {
        // An unauthenticated webhook can set a whole catalogue to zero, which
        // makes this the most dangerous input the service accepts.
        throw new SourceError('WEBHOOK_SIGNATURE_INVALID');
      }
      const body = JSON.parse(rawBody.toString('utf8'));
      return toItems([body], config);
    },
  };
}

/**
 * @param {object} config
 * @param {string} path
 * @param {Record<string, any>} query
 * @returns {Promise<{ items: any[], totalPages: number }>}
 */
async function wooGet(config, path, query) {
  const url = new URL(`/wp-json/wc/v3${path}`, config.baseUrl);
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs ?? 30_000);
  try {
    const res = await (config.fetchImpl ?? fetch)(url.toString(), {
      headers: {
        Accept: 'application/json',
        Authorization: `Basic ${Buffer.from(
          `${config.consumerKey}:${config.consumerSecret}`,
          'utf8',
        ).toString('base64')}`,
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      // Never an empty list: the caller must keep the previous snapshot rather
      // than read a 500 as "everything is out of stock".
      throw new SourceError(`WOO_HTTP_${res.status}: ${path}`);
    }
    return {
      items: await res.json(),
      totalPages: Number(res.headers.get('X-WP-TotalPages') ?? 1) || 1,
    };
  } catch (err) {
    if (err instanceof SourceError) throw err;
    throw new SourceError(`WOO_FETCH_FAILED: ${path} (${/** @type {Error} */ (err).message})`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Walk products and variations into a flat list.
 *
 * @param {object} config
 * @returns {Promise<SourceItem[]>}
 */
export async function fetchAll(config) {
  /** @type {any[]} */
  const raw = [];

  for (let page = 1; ; page += 1) {
    const { items, totalPages } = await wooGet(config, '/products', {
      per_page: PER_PAGE,
      page,
      status: 'publish',
    });
    raw.push(...items);

    // A variable product keeps its stock on the children, so the parent alone
    // would report null and the whole product would be skipped.
    for (const product of items) {
      if (product.type === 'variable') {
        const { items: variations } = await wooGet(config, `/products/${product.id}/variations`, {
          per_page: PER_PAGE,
        });
        raw.push(...variations.map((v) => ({ ...v, _parentSku: product.sku })));
      }
    }

    if (page >= totalPages || items.length === 0) break;
    if (page > 500) throw new SourceError('WOO_PAGINATION_DID_NOT_TERMINATE');
  }

  return toItems(raw, config);
}

/**
 * @param {object} config
 * @param {string[]} skus
 * @returns {Promise<SourceItem[]>}
 */
export async function fetchBySku(config, skus) {
  /** @type {any[]} */
  const raw = [];
  // The `sku` filter takes one value per call, so a webhook naming twenty SKUs
  // costs twenty small reads — still far less than re-reading the catalogue.
  for (const sku of skus) {
    const { items } = await wooGet(config, '/products', { sku, per_page: PER_PAGE });
    raw.push(...items);
    for (const product of items) {
      if (product.type === 'variable') {
        const { items: variations } = await wooGet(config, `/products/${product.id}/variations`, {
          per_page: PER_PAGE,
        });
        raw.push(...variations.map((v) => ({ ...v, _parentSku: product.sku })));
      }
    }
  }
  return toItems(raw, config);
}

/**
 * @param {any[]} raw
 * @param {object} config
 * @returns {SourceItem[]}
 */
export function toItems(raw, config) {
  const observedAt = new Date();
  /** @type {SourceItem[]} */
  const out = [];

  for (const p of raw) {
    // A variable parent is a container, not a sellable thing.
    if (p.type === 'variable') continue;

    const sku = String(p.sku ?? '').trim();
    if (!sku) continue;

    // null means stock management is off, which is "unknown", not "none".
    // Publishing 0 here would take the product off the shelf for no reason.
    if (p.stock_quantity === null || p.stock_quantity === undefined) continue;

    const price = Number(p.price ?? p.regular_price);
    if (!Number.isFinite(price) || price <= 0) continue;

    out.push({
      sku,
      ean: readEan(p, config.eanMetaKey),
      stock: Math.max(0, Math.trunc(Number(p.stock_quantity))),
      price,
      observedAt,
    });
  }
  return out;
}

/**
 * WooCommerce has no EAN field of its own; every shop puts it in a different
 * meta key. The configured key wins, then the usual suspects.
 *
 * @param {any} product
 * @param {string} [metaKey]
 * @returns {string|null}
 */
export function readEan(product, metaKey) {
  const keys = [metaKey, '_ean', 'ean', '_gtin', 'gtin', '_barcode', 'barcode'].filter(Boolean);
  for (const key of keys) {
    const hit = (product.meta_data ?? []).find((m) => m.key === key);
    const value = String(hit?.value ?? '').trim();
    if (value) return value;
  }
  return null;
}

/**
 * Verify the X-WC-Webhook-Signature header (base64 HMAC-SHA256 of the raw body)
 * before trusting anything in it.
 *
 * @param {Buffer} rawBody
 * @param {string|null} signature
 * @param {string} secret
 * @returns {boolean}
 */
export function verifyWebhookSignature(rawBody, signature, secret) {
  if (!secret || !signature) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  let given;
  try {
    given = Buffer.from(signature, 'base64');
  } catch {
    return false;
  }
  // Length has to match before timingSafeEqual, and the comparison stays
  // constant time so the signature cannot be guessed byte by byte.
  if (given.length !== expected.length) return false;
  return timingSafeEqual(given, expected);
}
