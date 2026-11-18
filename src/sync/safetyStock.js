/**
 * Safety stock rules. Pure functions, no I/O, directly testable.
 *
 * Bol sells from `correctedStock`, which is our `amount` minus open orders.
 * Everything here decides what `amount` to send.
 */

import { RuleViolation } from '../core/errors.js';

/** Hard cap from the v10 spec (`stock.amount` maximum: 999). Kept for v11 too. */
export const BOL_MAX_STOCK = 999;

/**
 * @typedef {object} SafetyRule
 * @property {number} bufferAbs            fixed units held back
 * @property {number} bufferPct            percentage held back (0-100)
 * @property {number} minPublish           below this, publish 0 instead
 * @property {number} maxPublish           cap we are willing to advertise
 * @property {number} stockDeltaThreshold  ignore increases smaller than this
 */

/** @type {SafetyRule} */
export const DEFAULT_RULE = {
  bufferAbs: 2,
  bufferPct: 0,
  minPublish: 1,
  maxPublish: BOL_MAX_STOCK,
  stockDeltaThreshold: 2,
};

/**
 * Turn the source stock into the number to advertise on Bol.
 *
 * @param {number} sourceStock
 * @param {SafetyRule} rule
 * @returns {number} 0..999
 */
export function computePublishableStock(sourceStock, rule = DEFAULT_RULE) {
  if (!Number.isFinite(sourceStock)) {
    throw new RuleViolation('SOURCE_STOCK_NOT_A_NUMBER', { sourceStock });
  }
  const raw = Math.max(0, Math.floor(sourceStock));
  const buffer = Math.max(rule.bufferAbs, Math.ceil((raw * rule.bufferPct) / 100));
  const candidate = raw - buffer;

  if (candidate < rule.minPublish) return 0;
  return Math.min(candidate, rule.maxPublish, BOL_MAX_STOCK);
}

/**
 * Should this stock value be sent at all?
 *
 * Asymmetric on purpose. A drop goes out immediately because overselling costs
 * cancellations and seller rating. A rise can wait for a meaningful delta, which
 * keeps a product that oscillates between 7 and 8 from burning the rate limit.
 *
 * @param {object} o
 * @param {number|null} o.pushedStock  last value we actually sent, null if never
 * @param {number} o.desiredStock
 * @param {SafetyRule} [o.rule]
 * @returns {{ send: boolean, urgent: boolean, reason: string }}
 */
export function shouldSendStock({ pushedStock, desiredStock, rule = DEFAULT_RULE }) {
  if (pushedStock === null || pushedStock === undefined) {
    return { send: true, urgent: desiredStock === 0, reason: 'FIRST_PUSH' };
  }
  if (desiredStock === pushedStock) {
    return { send: false, urgent: false, reason: 'UNCHANGED' };
  }
  // Going offline is never debounced.
  if (desiredStock === 0) {
    return { send: true, urgent: true, reason: 'GOING_TO_ZERO' };
  }
  if (desiredStock < pushedStock) {
    return { send: true, urgent: true, reason: 'DECREASE' };
  }
  if (desiredStock - pushedStock < rule.stockDeltaThreshold) {
    return { send: false, urgent: false, reason: 'INCREASE_BELOW_THRESHOLD' };
  }
  return { send: true, urgent: false, reason: 'INCREASE' };
}

/**
 * Pick the most specific rule. SKU scope beats tenant scope; ties go to the
 * lower `priority` number.
 *
 * @param {Array<SafetyRule & { scope: 'tenant'|'sku', sku?: string, priority: number }>} rules
 * @param {string} sku
 * @returns {SafetyRule}
 */
export function resolveRule(rules, sku) {
  const applicable = rules
    .filter((r) => r.scope === 'tenant' || r.sku === sku)
    .sort((a, b) => {
      if (a.scope !== b.scope) return a.scope === 'sku' ? -1 : 1;
      return a.priority - b.priority;
    });
  return applicable[0] ?? DEFAULT_RULE;
}

/**
 * Catalogue-wide guard. More than `guardPct` of the catalogue dropping to zero
 * in one pass is almost always a broken source feed, not real life.
 *
 * @param {object} o
 * @param {number} o.goingToZero
 * @param {number} o.totalPlanned
 * @param {number} o.guardPct
 * @returns {{ tripped: boolean, share: number }}
 */
export function bulkDropGuard({ goingToZero, totalPlanned, guardPct }) {
  if (totalPlanned === 0) return { tripped: false, share: 0 };
  const share = (goingToZero / totalPlanned) * 100;
  return { tripped: share > guardPct, share };
}

/**
 * Source data older than `staleAfterMin` must not drive a plan.
 *
 * @param {Date} observedAt
 * @param {number} staleAfterMin
 * @param {Date} [now]
 * @returns {boolean}
 */
export function isStale(observedAt, staleAfterMin, now = new Date()) {
  return now.getTime() - observedAt.getTime() > staleAfterMin * 60000;
}
