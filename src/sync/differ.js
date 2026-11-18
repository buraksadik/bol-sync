/**
 * Differ: desired vs pushed -> queue jobs.
 *
 * This is where the rate limit is actually saved. Most planning runs produce
 * almost no work, because almost nothing moved.
 */

import { shouldSendStock, DEFAULT_RULE } from './safetyStock.js';
import { shouldSendPrice, buildPricing } from './pricing.js';
import { RuleViolation } from '../core/errors.js';

/** Job priorities. Lower runs first. */
export const PRIORITY = {
  STOCK_DECREASE: 10,
  PRICE_CHANGE: 50,
  RESOLVE_OFFER_ID: 60,
  STOCK_INCREASE: 80,
  PULL_SOURCE: 90,
  RECONCILE: 120,
};

/**
 * @typedef {object} DiffInput
 * @property {number} productId
 * @property {string|null} offerId
 * @property {number|null} desiredStock
 * @property {number|null} desiredPrice
 * @property {number|null} pushedStock
 * @property {number|null} pushedPrice
 * @property {import('./safetyStock.js').SafetyRule} safetyRule
 */

/**
 * @typedef {object} PushJob
 * @property {number} productId
 * @property {'push_offer'|'resolve_offer_id'} type
 * @property {number} priority
 * @property {{ stock?: { amount: number, managedByRetailer: boolean },
 *              pricing?: { bundlePrices: Array<{ quantity: number, unitPrice: number }> } }} patch
 * @property {string[]} reasons
 */

/**
 * Decide what to enqueue for one product.
 *
 * Returns null when nothing should be sent. An offer without an offerId becomes
 * a resolve job instead, never a blind create: creating a duplicate offer for an
 * EAN the seller already lists is hard to undo.
 *
 * @param {DiffInput} input
 * @param {{ managedByRetailer: boolean }} tenant
 * @returns {PushJob|null}
 */
export function diffProduct(input, tenant) {
  const {
    productId,
    offerId,
    desiredStock,
    desiredPrice,
    pushedStock,
    pushedPrice,
    safetyRule = DEFAULT_RULE,
  } = input;

  // Last gate before the queue. The planner already validates, but a number
  // that is not a number must never reach a JSON body: NaN serialises to null,
  // and a null price on Bol is not a rejected request, it is a changed offer.
  const stockUsable = desiredStock != null && Number.isInteger(desiredStock);
  const priceUsable = desiredPrice != null && Number.isFinite(desiredPrice);

  // Nothing was planned for this product, or nothing survived the gate.
  if (!stockUsable && !priceUsable) return null;

  if (!offerId) {
    return {
      productId,
      type: 'resolve_offer_id',
      priority: PRIORITY.RESOLVE_OFFER_ID,
      patch: {},
      reasons: ['NO_OFFER_ID'],
    };
  }

  /** @type {PushJob['patch']} */
  const patch = {};
  /** @type {string[]} */
  const reasons = [];
  let priority = null;

  if (stockUsable) {
    const verdict = shouldSendStock({ pushedStock, desiredStock, rule: safetyRule });
    if (verdict.send) {
      patch.stock = {
        amount: desiredStock,
        managedByRetailer: tenant.managedByRetailer,
      };
      reasons.push(`STOCK_${verdict.reason}`);
      priority = verdict.urgent ? PRIORITY.STOCK_DECREASE : PRIORITY.STOCK_INCREASE;
    }
  }

  if (priceUsable && shouldSendPrice(pushedPrice, desiredPrice)) {
    // One tier is the normal case. Volume tiers arrive through the price rule
    // later; buildPricing validates the shape either way.
    patch.pricing = buildPricing([{ quantity: 1, unitPrice: desiredPrice }]);
    reasons.push('PRICE_CHANGED');
    priority = priority == null ? PRIORITY.PRICE_CHANGE : Math.min(priority, PRIORITY.PRICE_CHANGE);
  }

  if (reasons.length === 0) return null;

  return { productId, type: 'push_offer', priority, patch, reasons };
}

/**
 * @param {DiffInput[]} inputs
 * @param {{ managedByRetailer: boolean }} tenant
 * @returns {PushJob[]}
 */
export function diffBatch(inputs, tenant) {
  /** @type {PushJob[]} */
  const jobs = [];
  for (const input of inputs) {
    let job;
    try {
      job = diffProduct(input, tenant);
    } catch (err) {
      // A malformed price tier is this product's problem, not the batch's.
      if (err instanceof RuleViolation) continue;
      throw err;
    }
    if (job) jobs.push(job);
  }
  // Urgent work first. The claim query orders by priority too, but sorting here
  // means a truncated batch still loses the least important jobs.
  return jobs.sort((a, b) => a.priority - b.priority || a.productId - b.productId);
}

/**
 * Deduplication key, so a product that changes fifty times a minute still has
 * exactly one open job carrying the newest target.
 *
 * @param {string} tenantId
 * @param {number} productId
 * @param {string} type
 * @returns {string}
 */
export function dedupeKey(tenantId, productId, type) {
  return `${tenantId}:${productId}:${type}`;
}

export { shouldSendStock, shouldSendPrice };
