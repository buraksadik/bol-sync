import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

import {
  toItems,
  readEan,
  verifyWebhookSignature,
  createWooCommerceSource,
} from '../src/sources/woocommerce.source.js';
import { compareOffer } from '../src/sync/reconciler.js';
import { parseOfferExport } from '../src/bol/offers.v10.js';
import { SourceError } from '../src/core/errors.js';

// ---------------------------------------------------------------- woocommerce

const woo = (over = {}) => ({
  id: 1,
  sku: 'A1',
  type: 'simple',
  price: '12.95',
  stock_quantity: 7,
  meta_data: [],
  ...over,
});

test('null stock means unknown, not zero', () => {
  // Stock management is off for this product. Publishing 0 would take it off
  // the shelf for no reason at all.
  const items = toItems([woo({ stock_quantity: null })], {});
  assert.equal(items.length, 0);
});

test('zero stock is a real number and travels', () => {
  const items = toItems([woo({ stock_quantity: 0 })], {});
  assert.equal(items.length, 1);
  assert.equal(items[0].stock, 0);
});

test('a variable parent is skipped, its variations are not', () => {
  const items = toItems(
    [
      woo({ id: 1, sku: 'PARENT', type: 'variable', stock_quantity: null }),
      woo({ id: 2, sku: 'PARENT-M', type: 'variation', stock_quantity: 4 }),
      woo({ id: 3, sku: 'PARENT-L', type: 'variation', stock_quantity: 9 }),
    ],
    {},
  );
  assert.deepEqual(items.map((i) => i.sku), ['PARENT-M', 'PARENT-L']);
});

test('a product with no sku or no price is left out', () => {
  const items = toItems(
    [woo({ sku: '' }), woo({ sku: 'B', price: '0' }), woo({ sku: 'C' })],
    {},
  );
  assert.deepEqual(items.map((i) => i.sku), ['C']);
});

test('the EAN comes from the configured meta key first', () => {
  const product = woo({
    meta_data: [
      { key: '_ean', value: '111' },
      { key: 'custom_gtin', value: '222' },
    ],
  });
  assert.equal(readEan(product, 'custom_gtin'), '222');
  assert.equal(readEan(product, undefined), '111', 'falls back to the usual suspects');
  assert.equal(readEan(woo(), undefined), null);
});

test('a webhook signature is verified before the body is trusted', () => {
  const secret = 'shhh';
  const body = Buffer.from('{"sku":"A1"}');
  const good = createHmac('sha256', secret).update(body).digest('base64');

  assert.equal(verifyWebhookSignature(body, good, secret), true);
  assert.equal(verifyWebhookSignature(body, good, 'wrong-secret'), false);
  assert.equal(verifyWebhookSignature(Buffer.from('{"sku":"B2"}'), good, secret), false);
  assert.equal(verifyWebhookSignature(body, null, secret), false);
  assert.equal(verifyWebhookSignature(body, good, ''), false, 'no secret configured means no trust');
  assert.equal(verifyWebhookSignature(body, 'short', secret), false);
});

test('the woocommerce source refuses plain http', () => {
  // Basic auth over http hands the shop's keys to anyone on the path.
  assert.throws(
    () =>
      createWooCommerceSource({
        baseUrl: 'http://shop.nl',
        consumerKey: 'k',
        consumerSecret: 's',
      }),
    /HTTPS/,
  );
});

test('an unsigned webhook is rejected by the source itself', () => {
  const source = createWooCommerceSource({
    baseUrl: 'https://shop.nl',
    consumerKey: 'k',
    consumerSecret: 's',
    webhookSecret: 'shhh',
  });
  assert.throws(() => source.parseWebhook(Buffer.from('{}'), 'nope'), SourceError);
});

// ---------------------------------------------------------------- reconciler

const remote = (over = {}) => ({
  offerId: 'o1',
  stock: { amount: 48, correctedStock: 48 },
  pricing: { bundlePrices: [{ quantity: 1, unitPrice: 12.95 }] },
  ...over,
});

test('matching numbers are not drift', () => {
  const r = compareOffer(remote(), { pushedStock: 48, pushedPrice: 12.95, desiredStock: 48 });
  assert.equal(r.drift, false);
  assert.equal(r.invisible, false);
});

test('a stock bol did not get is drift', () => {
  const r = compareOffer(remote({ stock: { amount: 12, correctedStock: 12 } }), {
    pushedStock: 48,
    pushedPrice: 12.95,
    desiredStock: 48,
  });
  assert.equal(r.drift, true);
  assert.deepEqual(r.detail.stock, { pushed: 48, bol: 12, corrected: 12 });
});

test('a price someone else changed is drift', () => {
  const r = compareOffer(
    remote({ pricing: { bundlePrices: [{ quantity: 1, unitPrice: 9.95 }] } }),
    { pushedStock: 48, pushedPrice: 12.95, desiredStock: 48 },
  );
  assert.equal(r.drift, true);
});

test('a product we never pushed is new, not drifting', () => {
  const r = compareOffer(remote(), { pushedStock: null, pushedPrice: null, desiredStock: 48 });
  assert.equal(r.drift, false);
});

test('correctedStock 0 with stock on our books is invisible, not drift', () => {
  // The offer agrees with us in every column and still sells nothing, because
  // bol has subtracted open orders. Re-pushing would change nothing.
  const r = compareOffer(remote({ stock: { amount: 48, correctedStock: 0 } }), {
    pushedStock: 48,
    pushedPrice: 12.95,
    desiredStock: 48,
  });
  assert.equal(r.invisible, true);
  assert.equal(r.drift, false);
});

test('correctedStock 0 when we also want zero is simply out of stock', () => {
  const r = compareOffer(remote({ stock: { amount: 0, correctedStock: 0 } }), {
    pushedStock: 0,
    pushedPrice: 12.95,
    desiredStock: 0,
  });
  assert.equal(r.invisible, false);
});

// ---------------------------------------------------------------- v10 export

test('the offer export is read by column name, not position', () => {
  const csv =
    'offerId;ean;conditionName;bundlePricesPrice;stockAmount\n' +
    'o-1;8712345678901;NEW;12,95;7\n' +
    'o-2;8712345678902;NEW;9,95;3\n';
  const map = parseOfferExport(csv);

  assert.equal(map.get('8712345678901'), 'o-1');
  assert.equal(map.get('8712345678902'), 'o-2');
});

test('a reordered export still maps correctly', () => {
  const csv = 'ean,stockAmount,offerId\n871,7,o-9\n';
  assert.equal(parseOfferExport(csv).get('871'), 'o-9');
});

test('an export without the expected columns fails loudly', () => {
  // A silently shifted column would attach every offer id to the wrong product.
  assert.throws(() => parseOfferExport('a;b;c\n1;2;3\n'), /no offerId\/ean column/);
});

test('an empty export is empty, not an error', () => {
  assert.equal(parseOfferExport('').size, 0);
  assert.equal(parseOfferExport('offerId;ean\n').size, 0);
});
