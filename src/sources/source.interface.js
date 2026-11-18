/**
 * Source contract.
 *
 * A source is whatever holds the truth about stock and price: WooCommerce,
 * Shopify, a supplier CSV/XML feed, an ERP export. Adding a new one means
 * implementing this interface and nothing else.
 */

import { createHash } from 'node:crypto';
import { SourceError } from '../core/errors.js';
import { createCsvSource } from './csv.source.js';
import { createWooCommerceSource } from './woocommerce.source.js';

/**
 * @typedef {object} SourceItem
 * @property {string} sku
 * @property {string|null} ean
 * @property {number} stock
 * @property {number} price      VAT included, in EUR
 * @property {Date} observedAt
 */

/**
 * @typedef {object} Source
 * @property {string} name
 * @property {() => Promise<SourceItem[]>} fetchAll
 *   Full snapshot. Used by the scheduled pull and by the first import.
 * @property {(skus: string[]) => Promise<SourceItem[]>} fetchBySku
 *   Partial read, used after a webhook names specific products.
 * @property {(raw: unknown, signature: string|null) => SourceItem[]} parseWebhook
 *   Turn a webhook body into items. Must verify the signature and throw on
 *   mismatch — an unauthenticated webhook can set a whole catalogue to zero.
 */

/** Source types this build can actually construct. */
export const SUPPORTED_SOURCES = ['csv', 'woocommerce'];

/**
 * @param {string} type  woocommerce | shopify | csv
 * @param {object} config
 * @returns {Source}
 */
export function createSource(type, config) {
  switch (type) {
    case 'csv':
    case 'xml':
      return createCsvSource({ format: type === 'xml' ? 'xml' : 'csv', ...config });
    case 'woocommerce':
      return createWooCommerceSource(config);
    default:
      throw new SourceError(
        `UNKNOWN_SOURCE_TYPE: ${type} (supported: ${SUPPORTED_SOURCES.join(', ')})`,
      );
  }
}

/**
 * Stable hash of an item, stored as source_state.payload_hash.
 * Equal hash means no work; this is the cheapest filter in the pipeline.
 *
 * `observedAt` is deliberately excluded. It changes on every poll, so including
 * it would make every hash unique and turn this filter into dead weight.
 *
 * @param {SourceItem} item
 * @returns {string}
 */
export function hashItem(item) {
  const canonical = [
    item.sku,
    item.ean ?? '',
    Math.trunc(item.stock),
    Number(item.price).toFixed(2),
  ].join('|');
  return createHash('sha1').update(canonical).digest('hex');
}

/**
 * Shape check for anything a source hands back. A source that returns a string
 * where a number belongs is a bug that must stop at the edge, not three layers
 * later inside a price calculation.
 *
 * @param {unknown} item
 * @returns {SourceItem}
 */
export function assertSourceItem(item) {
  const i = /** @type {any} */ (item);
  if (!i || typeof i.sku !== 'string' || i.sku.length === 0) {
    throw new SourceError(`SOURCE_ITEM_SKU_MISSING: ${JSON.stringify(item)}`);
  }
  if (!Number.isFinite(i.stock)) {
    throw new SourceError(`SOURCE_ITEM_STOCK_NOT_A_NUMBER: ${i.sku}`);
  }
  if (!Number.isFinite(i.price)) {
    throw new SourceError(`SOURCE_ITEM_PRICE_NOT_A_NUMBER: ${i.sku}`);
  }
  if (!(i.observedAt instanceof Date) || Number.isNaN(i.observedAt.getTime())) {
    throw new SourceError(`SOURCE_ITEM_OBSERVED_AT_INVALID: ${i.sku}`);
  }
  return i;
}
