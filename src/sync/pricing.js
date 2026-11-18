/**
 * Price rules. Pure functions.
 *
 * Bol's constraints (Offers API v11, `Pricing.bundlePrices`):
 *   - at least one element with quantity 1
 *   - at most 4 elements
 *   - unitPrice includes VAT, minimum 1, maximum 9999, two decimals
 *   - quantity strictly increasing, unitPrice strictly decreasing
 */

import { RuleViolation } from '../core/errors.js';

export const PRICE_MIN = 1;
export const PRICE_MAX = 9999;
export const MAX_BUNDLE_PRICES = 4;

/**
 * @typedef {object} PriceRule
 * @property {number} markupPct
 * @property {number|null} floorPrice
 * @property {number|null} ceilingPrice
 * @property {'none'|'cent'|'psychological_99'} rounding
 * @property {number} maxChangePct
 */

/** @type {PriceRule} */
export const DEFAULT_PRICE_RULE = {
  markupPct: 0,
  floorPrice: null,
  ceilingPrice: null,
  rounding: 'cent',
  maxChangePct: 25,
};

/**
 * @param {number} value
 * @param {PriceRule['rounding']} mode
 * @returns {number}
 */
export function roundPrice(value, mode) {
  switch (mode) {
    case 'none':
      return value;
    case 'psychological_99': {
      // 12.34 -> 12.99 ; 12.00 -> 11.99 (never round a whole euro upward)
      const floor = Math.floor(value);
      const candidate = Number((floor + 0.99).toFixed(2));
      return candidate <= value ? candidate : Number((floor - 1 + 0.99).toFixed(2));
    }
    case 'cent':
    default:
      return Number(value.toFixed(2));
  }
}

/**
 * Apply markup, floor, ceiling and rounding.
 *
 * @param {number} basePrice VAT included
 * @param {PriceRule} rule
 * @returns {number}
 */
export function computePrice(basePrice, rule = DEFAULT_PRICE_RULE) {
  if (!Number.isFinite(basePrice) || basePrice <= 0) {
    throw new RuleViolation('SOURCE_PRICE_INVALID', { basePrice });
  }
  let p = basePrice * (1 + rule.markupPct / 100);
  if (rule.floorPrice != null) p = Math.max(p, rule.floorPrice);
  if (rule.ceilingPrice != null) p = Math.min(p, rule.ceilingPrice);
  return roundPrice(p, rule.rounding);
}

/**
 * Guard rails before anything leaves the process.
 *
 * The max-change check is the one that catches a source feed suddenly reporting
 * cents instead of euros. Without it that becomes a catalogue priced at 1% and
 * a very bad afternoon.
 *
 * @param {object} o
 * @param {number} o.price
 * @param {number|null} o.pushedPrice
 * @param {PriceRule} [o.rule]
 * @returns {{ ok: true } | { ok: false, reason: string, detail: object }}
 */
export function validatePrice({ price, pushedPrice, rule = DEFAULT_PRICE_RULE }) {
  if (!Number.isFinite(price)) {
    return { ok: false, reason: 'PRICE_NOT_A_NUMBER', detail: { price } };
  }
  if (price < PRICE_MIN || price > PRICE_MAX) {
    return {
      ok: false,
      reason: 'PRICE_OUT_OF_RANGE',
      detail: { price, min: PRICE_MIN, max: PRICE_MAX },
    };
  }
  if (Number(price.toFixed(2)) !== price) {
    return { ok: false, reason: 'PRICE_TOO_MANY_DECIMALS', detail: { price } };
  }
  if (pushedPrice != null && pushedPrice > 0) {
    const changePct = (Math.abs(price - pushedPrice) / pushedPrice) * 100;
    if (changePct > rule.maxChangePct) {
      return {
        ok: false,
        reason: 'PRICE_CHANGE_TOO_LARGE',
        detail: { from: pushedPrice, to: price, changePct, limit: rule.maxChangePct },
      };
    }
  }
  return { ok: true };
}

/**
 * Build the `pricing` block for the API.
 *
 * @param {Array<{ quantity: number, unitPrice: number }>} tiers
 * @returns {{ bundlePrices: Array<{ quantity: number, unitPrice: number }> }}
 */
export function buildPricing(tiers) {
  if (!tiers.length) throw new RuleViolation('PRICING_EMPTY');
  if (tiers.length > MAX_BUNDLE_PRICES) {
    throw new RuleViolation('PRICING_TOO_MANY_TIERS', { count: tiers.length });
  }
  for (const t of tiers) {
    // NaN and Infinity both serialise to null in JSON, which bol reads as a
    // changed field rather than a rejected request. Stop them here.
    if (!Number.isFinite(t.unitPrice) || !Number.isInteger(t.quantity)) {
      throw new RuleViolation('PRICING_TIER_NOT_A_NUMBER', { tier: t });
    }
  }
  const sorted = [...tiers].sort((a, b) => a.quantity - b.quantity);
  if (sorted[0].quantity !== 1) {
    throw new RuleViolation('PRICING_MISSING_QUANTITY_ONE');
  }
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i].quantity <= sorted[i - 1].quantity) {
      throw new RuleViolation('PRICING_QUANTITY_NOT_INCREASING', { tiers: sorted });
    }
    if (sorted[i].unitPrice >= sorted[i - 1].unitPrice) {
      throw new RuleViolation('PRICING_UNIT_PRICE_NOT_DECREASING', { tiers: sorted });
    }
  }
  return { bundlePrices: sorted };
}

/**
 * @param {number|null} pushedPrice
 * @param {number} desiredPrice
 * @returns {boolean}
 */
export function shouldSendPrice(pushedPrice, desiredPrice) {
  return pushedPrice == null || Number(pushedPrice) !== Number(desiredPrice);
}
