import { test } from 'node:test';
import assert from 'node:assert/strict';

import { planProduct, planBatch } from '../src/sync/planner.js';
import { DEFAULT_RULE } from '../src/sync/safetyStock.js';
import { DEFAULT_PRICE_RULE } from '../src/sync/pricing.js';

const NOW = new Date('2026-11-18T10:00:00Z');

/** @param {object} over */
function input(over = {}) {
  return {
    productId: 1,
    sku: 'A1',
    sourceStock: 50,
    sourcePrice: 12.95,
    observedAt: new Date('2026-11-18T09:55:00Z'),
    pushedStock: null,
    pushedPrice: null,
    safetyRule: DEFAULT_RULE,
    priceRule: DEFAULT_PRICE_RULE,
    ...over,
  };
}

const OPTS = { staleAfterMin: 30, now: NOW };

test('applies the safety buffer', () => {
  const plan = planProduct(input(), OPTS);
  assert.equal(plan.skipped, false);
  assert.equal(plan.desiredStock, 48); // 50 - bufferAbs 2
  assert.equal(plan.desiredPrice, 12.95);
});

test('publishes zero rather than a number below minPublish', () => {
  const plan = planProduct(input({ sourceStock: 2 }), OPTS);
  assert.equal(plan.desiredStock, 0);
});

test('refuses to plan from a stale source', () => {
  const plan = planProduct(
    input({ observedAt: new Date('2026-11-18T09:00:00Z') }), // 60 min old
    OPTS,
  );
  assert.equal(plan.skipped, true);
  assert.equal(plan.skipReason, 'STALE_SOURCE');
  assert.equal(plan.desiredStock, null);
  assert.equal(plan.skipDetail.ageMin, 60);
});

test('a bad price does not block the stock', () => {
  // A 61% drop is far past the 25% guard rail: a feed glitch, not a sale.
  const plan = planProduct(input({ sourcePrice: 5, pushedPrice: 12.95 }), OPTS);

  assert.equal(plan.skipped, false, 'the product must still be sendable');
  assert.equal(plan.desiredStock, 48, 'the stock drop must survive a price problem');
  assert.equal(plan.desiredPrice, null);
  assert.equal(plan.skipReason, 'PRICE_CHANGE_TOO_LARGE');
});

test('a price below the bol minimum is dropped, not clamped', () => {
  const plan = planProduct(input({ sourcePrice: 0.5 }), OPTS);
  assert.equal(plan.desiredPrice, null);
  assert.equal(plan.skipReason, 'PRICE_OUT_OF_RANGE');
  assert.equal(plan.desiredStock, 48);
});

test('an invalid source stock skips the whole product', () => {
  const plan = planProduct(input({ sourceStock: Number.NaN }), OPTS);
  assert.equal(plan.skipped, true);
  assert.equal(plan.skipReason, 'SOURCE_STOCK_NOT_A_NUMBER');
});

test('bulk drop guard holds the entire batch', () => {
  // 10 products, 3 of them dropping from a real stock to zero = 30% > 20%
  const inputs = [];
  for (let i = 1; i <= 10; i += 1) {
    inputs.push(
      input({
        productId: i,
        sourceStock: i <= 3 ? 1 : 50, // 1 - buffer 2 -> 0
        pushedStock: 40,
      }),
    );
  }

  const { plans, guard } = planBatch(inputs, { ...OPTS, bulkDropGuardPct: 20 });

  assert.equal(guard.tripped, true);
  assert.equal(guard.share, 30);
  assert.equal(
    plans.every((p) => p.skipped && p.skipReason === 'BULK_DROP_GUARD'),
    true,
    'a partially applied catalogue is worse than none',
  );
});

test('bulk drop guard ignores products that were already at zero', () => {
  const inputs = [];
  for (let i = 1; i <= 10; i += 1) {
    inputs.push(
      input({
        productId: i,
        sourceStock: i <= 3 ? 1 : 50,
        pushedStock: i <= 3 ? 0 : 40, // already offline, not a new drop
      }),
    );
  }

  const { guard, plans } = planBatch(inputs, { ...OPTS, bulkDropGuardPct: 20 });
  assert.equal(guard.tripped, false);
  assert.equal(plans.filter((p) => p.skipped).length, 0);
});

test('a stale product does not count towards the guard denominator', () => {
  const fresh = [1, 2, 3, 4].map((i) =>
    input({ productId: i, sourceStock: 1, pushedStock: 40 }),
  );
  const stale = [5, 6, 7, 8].map((i) =>
    input({
      productId: i,
      sourceStock: 50,
      pushedStock: 40,
      observedAt: new Date('2026-11-18T08:00:00Z'),
    }),
  );

  const { guard } = planBatch([...fresh, ...stale], { ...OPTS, bulkDropGuardPct: 20 });
  // 4 of 4 live plans go to zero, not 4 of 8.
  assert.equal(guard.share, 100);
  assert.equal(guard.tripped, true);
});
