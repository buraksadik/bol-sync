/**
 * Reconciler: read bol back and compare.
 *
 * Without this the service only knows what it sent, not what is true. Sellers
 * edit offers by hand, other tools write to the same account, and a 202 from
 * v10 is not a guarantee of anything.
 *
 * Incremental pass every RECONCILE_INTERVAL_MIN using
 * `last-modified-date-time`; one full pass per night.
 */

import { iterateOffers } from '../bol/offers.v11.js';
import { dedupeKey, PRIORITY } from './differ.js';

/** @typedef {import('../bol/client.js').BolClient} BolClient */
/** @typedef {import('../bol/offers.v11.js').OfferSummary} OfferSummary */

/** Offers are written back in batches; one statement per batch, not per offer. */
const WRITE_BATCH = 200;

/**
 * @typedef {object} ReconcileResult
 * @property {number} offersSeen
 * @property {number} driftFound        pushed_* != bol_*
 * @property {number} invisibleFound    correctedStock = 0 while we expect stock
 * @property {number[]} requeuedProductIds
 */

/**
 * @param {object} o
 * @param {BolClient} o.client
 * @param {string} o.tenantId
 * @param {Date|null} o.since      null runs a full pass
 * @param {import('../db/repositories/products.repo.js').ProductsRepo} o.products
 * @param {import('../db/repositories/jobs.repo.js').JobsRepo} o.jobs
 * @param {number} [o.maxAttempts]
 * @returns {Promise<ReconcileResult>}
 */
export async function reconcile({ client, tenantId, since, products, jobs, maxAttempts = 6 }) {
  /** @type {OfferSummary[]} */
  let batch = [];
  let offersSeen = 0;

  const flush = async () => {
    if (batch.length === 0) return;
    await products.saveRemoteState(tenantId, batch);
    batch = [];
  };

  // An incremental pass overlaps the window by a minute. bol's
  // lastModifiedDateTime has second resolution and our clock is not theirs;
  // re-reading a few offers is cheaper than missing one.
  const sinceIso = since ? new Date(since.getTime() - 60_000).toISOString() : undefined;

  for await (const offer of iterateOffers(client, { lastModifiedDateTime: sinceIso })) {
    batch.push(offer);
    offersSeen += 1;
    if (batch.length >= WRITE_BATCH) await flush();
  }
  await flush();

  // The comparison itself happens in SQL, inside saveRemoteState: it is the
  // only place that sees pushed_* and bol_* in the same row.
  const drifted = await products.findDrifted(tenantId);
  const invisible = await products.findInvisibleOffers(tenantId);

  // Drift gets a re-push. Invisible does not: nothing is wrong with the offer,
  // bol has simply subtracted open orders, and pushing the same number again
  // would change nothing while spending a write token.
  const requeued = drifted.filter((row) => row.offerId && row.desiredStock !== null);
  await jobs.enqueueMany(
    requeued.map((row) => ({
      tenantId,
      productId: row.productId,
      type: 'push_offer',
      dedupeKey: dedupeKey(tenantId, row.productId, 'push_offer'),
      payload: { reasons: ['DRIFT'] },
      priority: PRIORITY.STOCK_DECREASE,
      maxAttempts,
      runAfter: new Date(),
    })),
  );

  return {
    offersSeen,
    driftFound: drifted.length,
    invisibleFound: invisible.length,
    requeuedProductIds: requeued.map((r) => r.productId),
  };
}

/**
 * Compare one offer against our stored state.
 *
 * Two different findings, deliberately kept apart:
 *
 *   drift     — bol's amount/price differ from what we last pushed. Something
 *               outside this service changed the offer. Re-push.
 *
 *   invisible — correctedStock is 0 while desired_stock is above 0. Nobody did
 *               anything wrong; bol has subtracted open orders and the offer is
 *               off the shelf. This is lost revenue, not a bug, and it needs a
 *               report rather than a re-push.
 *
 * @param {OfferSummary} remote
 * @param {{ pushedStock: number|null, pushedPrice: number|null, desiredStock: number|null }} local
 * @returns {{ drift: boolean, invisible: boolean, detail: object }}
 */
export function compareOffer(remote, local) {
  const remoteStock = remote?.stock?.amount ?? null;
  const remoteCorrected = remote?.stock?.correctedStock ?? null;
  const remotePrice =
    remote?.pricing?.bundlePrices?.find((b) => b.quantity === 1)?.unitPrice ?? null;

  // Never pushed means nothing to compare against. A product we have not sent
  // yet is not drifting; it is simply new.
  const stockDrift =
    local.pushedStock !== null && remoteStock !== null && Number(local.pushedStock) !== Number(remoteStock);
  const priceDrift =
    local.pushedPrice !== null && remotePrice !== null && Number(local.pushedPrice) !== Number(remotePrice);

  const invisible =
    remoteCorrected === 0 && local.desiredStock !== null && Number(local.desiredStock) > 0;

  return {
    drift: stockDrift || priceDrift,
    invisible,
    detail: {
      offerId: remote?.offerId,
      stock: { pushed: local.pushedStock, bol: remoteStock, corrected: remoteCorrected },
      price: { pushed: local.pushedPrice, bol: remotePrice },
    },
  };
}

/**
 * First import for a new client. Uses the v10 CSV export because it returns the
 * whole catalogue in one file; the 9-per-hour limit is irrelevant for a one-off.
 * After this, never again — the v11 list endpoint covers routine work.
 *
 * @param {object} o
 * @param {BolClient} o.client
 * @param {string} o.tenantId
 * @param {import('../db/repositories/products.repo.js').ProductsRepo} [o.products]
 * @param {{ timeoutMs?: number }} [o.opts]
 * @returns {Promise<{ imported: number, eanToOfferId: Map<string, string> }>}
 */
export async function initialImport({ client, tenantId, products, opts = {} }) {
  const { requestOfferExport, downloadOfferExport, parseOfferExport } = await import(
    '../bol/offers.v10.js'
  );
  const { waitForCompletion } = await import('../bol/processStatus.js');

  const started = await requestOfferExport(client);
  // The export is generated, not served: minutes, not seconds. The default
  // 30-second poll window is for stock writes and is far too short here.
  const finished = await waitForCompletion(client, started.processStatusId, {
    intervalMs: 5000,
    timeoutMs: opts.timeoutMs ?? 15 * 60_000,
  });
  if (!finished?.entityId) {
    return { imported: 0, eanToOfferId: new Map() };
  }

  const csv = await downloadOfferExport(client, finished.entityId);
  const eanToOfferId = parseOfferExport(csv);

  const imported = products ? await products.attachOfferIds(eanToOfferId, tenantId) : 0;
  return { imported, eanToOfferId };
}
