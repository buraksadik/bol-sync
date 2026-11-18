/**
 * Planner: source_state + rules -> offer_state.desired_*
 *
 * The planner never calls bol. It only decides what the right numbers are.
 * Deciding whether to send them is the differ's job.
 */

import {
  computePublishableStock,
  bulkDropGuard,
  isStale,
  DEFAULT_RULE,
} from './safetyStock.js';
import { computePrice, validatePrice, DEFAULT_PRICE_RULE } from './pricing.js';
import { RuleViolation } from '../core/errors.js';

/** @typedef {import('./safetyStock.js').SafetyRule} SafetyRule */
/** @typedef {import('./pricing.js').PriceRule} PriceRule */

/**
 * @typedef {object} PlanInput
 * @property {number} productId
 * @property {string} sku
 * @property {number} sourceStock
 * @property {number} sourcePrice
 * @property {Date} observedAt
 * @property {number|null} pushedStock
 * @property {number|null} pushedPrice
 * @property {SafetyRule} safetyRule
 * @property {PriceRule} priceRule
 */

/**
 * @typedef {object} PlanResult
 * @property {number} productId
 * @property {number|null} desiredStock
 * @property {number|null} desiredPrice
 * @property {boolean} skipped
 * @property {string} [skipReason]   STALE_SOURCE | PRICE_OUT_OF_RANGE | ...
 * @property {object} [skipDetail]
 *
 * `skipped` means nothing at all may be sent for this product.
 *
 * A price that fails its guard rails does NOT skip the product: `skipped` stays
 * false, `desiredPrice` becomes null, and `skipReason` carries the price reason.
 * That asymmetry is deliberate. A bad price must never block a stock drop from
 * going out, because the stock drop is the one that prevents overselling.
 */

/**
 * Plan one product.
 *
 * Order matters: the staleness check runs first, because a stale source makes
 * every other number meaningless.
 *
 * @param {PlanInput} input
 * @param {{ staleAfterMin: number, now?: Date }} opts
 * @returns {PlanResult}
 */
export function planProduct(input, opts) {
  const now = opts.now ?? new Date();
  const {
    productId,
    sourceStock,
    sourcePrice,
    observedAt,
    pushedPrice,
    safetyRule = DEFAULT_RULE,
    priceRule = DEFAULT_PRICE_RULE,
  } = input;

  const skip = (reason, detail) => ({
    productId,
    desiredStock: null,
    desiredPrice: null,
    skipped: true,
    skipReason: reason,
    skipDetail: detail,
  });

  if (!(observedAt instanceof Date) || Number.isNaN(observedAt.getTime())) {
    return skip('SOURCE_OBSERVED_AT_INVALID', { observedAt });
  }
  if (isStale(observedAt, opts.staleAfterMin, now)) {
    return skip('STALE_SOURCE', {
      observedAt: observedAt.toISOString(),
      ageMin: Math.round((now.getTime() - observedAt.getTime()) / 60000),
      staleAfterMin: opts.staleAfterMin,
    });
  }

  let desiredStock;
  try {
    desiredStock = computePublishableStock(sourceStock, safetyRule);
  } catch (err) {
    if (err instanceof RuleViolation) return skip(err.message, err.detail);
    throw err;
  }

  // From here the stock is publishable. A price problem only drops the price.
  let desiredPrice = null;
  let priceSkip = null;
  try {
    const candidate = computePrice(sourcePrice, priceRule);
    const verdict = validatePrice({ price: candidate, pushedPrice, rule: priceRule });
    if (verdict.ok) {
      desiredPrice = candidate;
    } else {
      priceSkip = { reason: verdict.reason, detail: verdict.detail };
    }
  } catch (err) {
    if (err instanceof RuleViolation) {
      priceSkip = { reason: err.message, detail: err.detail };
    } else {
      throw err;
    }
  }

  return {
    productId,
    desiredStock,
    desiredPrice,
    skipped: false,
    ...(priceSkip ? { skipReason: priceSkip.reason, skipDetail: priceSkip.detail } : {}),
  };
}

/**
 * Plan a whole batch and apply the catalogue-wide bulk-drop guard.
 *
 * When the guard trips nothing is returned for sending — the whole batch is
 * held and a review row is written. Partial application would be worse than
 * none: half a catalogue offline is still a catalogue offline.
 *
 * Only real drops count towards the guard: a product that was already at zero,
 * or that we have never pushed, is not evidence of a broken feed.
 *
 * @param {PlanInput[]} inputs
 * @param {{ staleAfterMin: number, bulkDropGuardPct: number, now?: Date }} opts
 * @returns {{ plans: PlanResult[], guard: { tripped: boolean, share: number } }}
 */
export function planBatch(inputs, opts) {
  const plans = inputs.map((input) => planProduct(input, opts));
  const byId = new Map(inputs.map((i) => [i.productId, i]));

  const live = plans.filter((p) => !p.skipped && p.desiredStock !== null);
  const goingToZero = live.filter((p) => {
    if (p.desiredStock !== 0) return false;
    const pushed = byId.get(p.productId)?.pushedStock;
    return pushed != null && pushed > 0;
  }).length;

  const guard = bulkDropGuard({
    goingToZero,
    totalPlanned: live.length,
    guardPct: opts.bulkDropGuardPct,
  });

  if (!guard.tripped) return { plans, guard };

  const detail = {
    goingToZero,
    totalPlanned: live.length,
    share: guard.share,
    guardPct: opts.bulkDropGuardPct,
  };
  return {
    plans: plans.map((p) => ({
      ...p,
      desiredStock: null,
      desiredPrice: null,
      skipped: true,
      skipReason: 'BULK_DROP_GUARD',
      skipDetail: detail,
    })),
    guard,
  };
}
