import { test } from 'node:test';
import assert from 'node:assert/strict';

import { diffProduct, diffBatch, dedupeKey, PRIORITY } from '../src/sync/differ.js';
import { DEFAULT_RULE } from '../src/sync/safetyStock.js';

const TENANT = { managedByRetailer: true };

/** @param {object} over */
function input(over = {}) {
  return {
    productId: 1,
    offerId: 'offer-1',
    desiredStock: 48,
    desiredPrice: 12.95,
    pushedStock: 48,
    pushedPrice: 12.95,
    safetyRule: DEFAULT_RULE,
    ...over,
  };
}

test('nothing moved means no job at all', () => {
  assert.equal(diffProduct(input(), TENANT), null);
});

test('a product without an offer id becomes a resolve job, never a create', () => {
  const job = diffProduct(input({ offerId: null, pushedStock: null }), TENANT);
  assert.equal(job.type, 'resolve_offer_id');
  assert.equal(job.priority, PRIORITY.RESOLVE_OFFER_ID);
  assert.deepEqual(job.patch, {});
});

test('a stock drop is urgent', () => {
  const job = diffProduct(input({ desiredStock: 10 }), TENANT);
  assert.equal(job.type, 'push_offer');
  assert.equal(job.priority, PRIORITY.STOCK_DECREASE);
  assert.deepEqual(job.patch.stock, { amount: 10, managedByRetailer: true });
  assert.deepEqual(job.reasons, ['STOCK_DECREASE']);
});

test('going to zero is urgent even from a low number', () => {
  const job = diffProduct(input({ pushedStock: 1, desiredStock: 0 }), TENANT);
  assert.equal(job.priority, PRIORITY.STOCK_DECREASE);
  assert.deepEqual(job.reasons, ['STOCK_GOING_TO_ZERO']);
});

test('a small increase is suppressed to save the rate limit', () => {
  // threshold is 2, so +1 does not travel
  assert.equal(diffProduct(input({ desiredStock: 49 }), TENANT), null);
});

test('a meaningful increase travels, but not urgently', () => {
  const job = diffProduct(input({ desiredStock: 60 }), TENANT);
  assert.equal(job.priority, PRIORITY.STOCK_INCREASE);
  assert.deepEqual(job.reasons, ['STOCK_INCREASE']);
});

test('managedByRetailer comes from the tenant, not from a default', () => {
  const job = diffProduct(input({ desiredStock: 10 }), { managedByRetailer: false });
  assert.equal(job.patch.stock.managedByRetailer, false);
});

test('a price change alone is a normal priority job', () => {
  const job = diffProduct(input({ desiredPrice: 11.95 }), TENANT);
  assert.equal(job.priority, PRIORITY.PRICE_CHANGE);
  assert.deepEqual(job.patch.pricing, { bundlePrices: [{ quantity: 1, unitPrice: 11.95 }] });
  assert.deepEqual(job.reasons, ['PRICE_CHANGED']);
});

test('stock and price travel in one patch, at the more urgent priority', () => {
  const job = diffProduct(input({ desiredStock: 10, desiredPrice: 11.95 }), TENANT);
  assert.equal(job.priority, PRIORITY.STOCK_DECREASE);
  assert.equal(job.patch.stock.amount, 10);
  assert.equal(job.patch.pricing.bundlePrices[0].unitPrice, 11.95);
  assert.deepEqual(job.reasons, ['STOCK_DECREASE', 'PRICE_CHANGED']);
});

test('a price change makes a lazy stock increase travel sooner', () => {
  const job = diffProduct(input({ desiredStock: 60, desiredPrice: 11.95 }), TENANT);
  assert.equal(job.priority, PRIORITY.PRICE_CHANGE);
});

test('a product the planner skipped produces nothing', () => {
  assert.equal(diffProduct(input({ desiredStock: null, desiredPrice: null }), TENANT), null);
});

test('the first push always travels', () => {
  const job = diffProduct(input({ pushedStock: null, pushedPrice: null }), TENANT);
  assert.deepEqual(job.reasons, ['STOCK_FIRST_PUSH', 'PRICE_CHANGED']);
});

test('diffBatch drops the idle products and sorts urgent work first', () => {
  const jobs = diffBatch(
    [
      input({ productId: 1, desiredStock: 60 }), // increase, 80
      input({ productId: 2 }), // unchanged -> gone
      input({ productId: 3, desiredStock: 0 }), // to zero, 10
      input({ productId: 4, desiredPrice: 11.95 }), // price, 50
    ],
    TENANT,
  );

  assert.deepEqual(jobs.map((j) => j.productId), [3, 4, 1]);
  assert.deepEqual(jobs.map((j) => j.priority), [10, 50, 80]);
});

test('one malformed product does not take the batch down', () => {
  const jobs = diffBatch(
    [
      input({ productId: 1, desiredStock: 0 }),
      input({ productId: 2, desiredPrice: Number.NaN, desiredStock: null }),
      input({ productId: 3, desiredStock: 10 }),
    ],
    TENANT,
  );
  assert.deepEqual(jobs.map((j) => j.productId), [1, 3]);
});

test('dedupeKey collapses repeated changes to one open job', () => {
  assert.equal(dedupeKey('t1', 42, 'push_offer'), 't1:42:push_offer');
  assert.notEqual(dedupeKey('t1', 42, 'push_offer'), dedupeKey('t2', 42, 'push_offer'));
});
