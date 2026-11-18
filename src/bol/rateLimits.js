/**
 * Rate limits taken from the live list on 2026-11-18:
 *   https://api.bol.com/retailer/public/ratelimits
 *
 * Limits are enforced per seller account, not per application.
 * Treat these as a ceiling and spend only `rateBudgetPct` of it.
 */

/** @typedef {'offers_write'|'offers_read'|'export'|'process_status'|'process_status_bulk'|'orders_read'|'token'} BucketName */

/**
 * @type {Record<BucketName, { capacity: number, windowSec: number, note: string }>}
 */
export const BUCKETS = {
  // GET, POST, PATCH, DELETE /retailer/offers/**
  offers_write: { capacity: 50, windowSec: 1, note: 'PATCH/POST/DELETE offers' },
  // GET /retailer/offers* (list endpoint is stricter than the item endpoints)
  offers_read: { capacity: 25, windowSec: 1, note: 'GET offers list' },
  // POST /retailer/offers/export and GET /retailer/offers/export/*
  export: { capacity: 9, windowSec: 3600, note: 'CSV export, initial import only' },
  // GET /shared/process-status/*
  process_status: { capacity: 100, windowSec: 1, note: 'v10 fallback only' },
  // GET/POST /shared/process-status  (up to 1000 ids per request)
  process_status_bulk: { capacity: 2, windowSec: 1, note: 'v10 fallback only' },
  // GET /retailer/orders
  orders_read: { capacity: 25, windowSec: 60, note: 'order polling' },
  // login.bol.com — undocumented and much tighter than the API. Never burn it.
  token: { capacity: 2, windowSec: 60, note: 'token endpoint, reuse the token instead' },
};

/**
 * Map a request to the bucket it spends from.
 *
 * @param {string} method HTTP method, upper case
 * @param {string} path   Path only, e.g. '/retailer/offers/abc-123'
 * @returns {BucketName}
 */
export function bucketFor(method, path) {
  if (path.startsWith('/shared/process-status/')) return 'process_status';
  if (path.startsWith('/shared/process-status')) return 'process_status_bulk';
  if (path.startsWith('/retailer/offers/export')) return 'export';
  if (path.startsWith('/retailer/offers')) {
    return method === 'GET' && !/\/retailer\/offers\/[^/]+$/.test(path)
      ? 'offers_read'
      : 'offers_write';
  }
  if (path.startsWith('/retailer/orders')) return 'orders_read';
  return 'offers_write';
}

/**
 * Refill rate after applying the tenant's budget.
 *
 * @param {BucketName} bucket
 * @param {number} budgetPct 1-100
 * @returns {{ capacity: number, refillPerSec: number }}
 */
export function budgeted(bucket, budgetPct) {
  const { capacity, windowSec } = BUCKETS[bucket];
  const scaled = Math.max(1, Math.floor((capacity * budgetPct) / 100));
  return { capacity: scaled, refillPerSec: scaled / windowSec };
}
