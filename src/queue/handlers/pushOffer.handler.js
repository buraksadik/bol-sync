/**
 * Handler: push_offer
 *
 * Sends one offer's stock and/or price to bol and records what was sent.
 */

import { patchOffer } from '../../bol/offers.v11.js';
import { updateStock, updatePrice } from '../../bol/offers.v10.js';
import { waitForCompletion } from '../../bol/processStatus.js';
import { buildPricing } from '../../sync/pricing.js';
import { dedupeKey, PRIORITY } from '../../sync/differ.js';
import { BolApiError, RuleViolation } from '../../core/errors.js';

/** @typedef {import('../worker.js').JobHandler} JobHandler */

/**
 * Steps:
 *   1. load product + offer_state; bail out if sync_enabled is false
 *   2. no offer_id -> enqueue resolve_offer_id and finish
 *   3. re-read desired_* from the database, not from job.payload
 *      (the payload may be minutes old; the row is current)
 *   4. v11: single PATCH with the changed sections
 *      v10: PUT stock and/or PUT price, then poll process status
 *   5. on success write pushed_stock / pushed_price / pushed_at
 *   6. on 404 clear products.offer_id and enqueue resolve_offer_id
 *   7. on 409 re-read the offer, re-plan, let the retry layer try once more
 *
 * Step 3 is the one that is easy to get wrong. Writing the payload's value back
 * into pushed_* after a slow retry records a number that is no longer true.
 *
 * @type {JobHandler}
 */
export async function pushOfferHandler(job, ctx) {
  const { products, rules, jobs } = ctx.repos;
  if (!job.productId) throw new RuleViolation('PUSH_WITHOUT_PRODUCT', { jobId: job.id });

  // 1 + 3. The row is the truth, not the payload. A job that waited out three
  // backoffs is carrying a number from several minutes ago.
  const [row] = await products.loadSyncRows(job.tenantId, { productIds: [job.productId] });
  if (!row) {
    // sync_enabled went false, or the product was deleted, while this sat in
    // the queue. Nothing to do and nothing wrong.
    ctx.log?.debug({ jobId: job.id, productId: job.productId }, 'product no longer syncable');
    return;
  }

  // 2. Never create an offer from here. A duplicate offer on a seller's account
  // is a support ticket, so resolving is a separate, deliberate step.
  if (!row.offerId) {
    await jobs.enqueue({
      tenantId: job.tenantId,
      productId: job.productId,
      type: 'resolve_offer_id',
      dedupeKey: dedupeKey(job.tenantId, job.productId, 'resolve_offer_id'),
      payload: { productIds: [job.productId] },
      priority: PRIORITY.RESOLVE_OFFER_ID,
      maxAttempts: 3,
      runAfter: new Date(),
    });
    return;
  }

  const sendStock = row.desiredStock !== null && row.desiredStock !== row.pushedStock;
  const sendPrice = row.desiredPrice !== null && Number(row.desiredPrice) !== Number(row.pushedPrice);
  if (!sendStock && !sendPrice) {
    ctx.log?.debug({ jobId: job.id, productId: job.productId }, 'already in sync');
    return;
  }

  const tenant = await rules.getTenant(job.tenantId);
  const client = await ctx.clientFor(job.tenantId);
  client.context = { productId: job.productId, jobId: job.id };

  /** @type {{ stock?: number, price?: number }} */
  const sent = {};

  try {
    if (tenant.offersApiVersion === 'v10') {
      await pushV10({ client, row, tenant, sendStock, sendPrice, sent, ctx });
    } else {
      const patch = {};
      if (sendStock) {
        patch.stock = {
          amount: row.desiredStock,
          managedByRetailer: tenant.managedByRetailer,
        };
        sent.stock = row.desiredStock;
      }
      if (sendPrice) {
        patch.pricing = buildPricing([{ quantity: 1, unitPrice: Number(row.desiredPrice) }]);
        sent.price = Number(row.desiredPrice);
      }
      // v11 is synchronous: a 204 is the confirmation, no polling.
      await patchOffer(client, row.offerId, patch);
    }
  } catch (err) {
    await handlePushError(err, { job, row, ctx });
    throw err;
  }

  // 5. Only now, and only with what actually went out.
  await products.markPushed(job.productId, sent);
  ctx.log?.info(
    { productId: job.productId, offerId: row.offerId, ...sent },
    'offer pushed',
  );
}

/**
 * v10 costs two writes and two polls for what v11 does in one PATCH. Stock goes
 * first: if the price call fails afterwards, the shop is still protected from
 * overselling, which is the failure we actually care about.
 *
 * @param {object} o
 * @returns {Promise<void>}
 */
async function pushV10({ client, row, tenant, sendStock, sendPrice, sent, ctx }) {
  if (sendStock) {
    const status = await updateStock(client, row.offerId, {
      amount: row.desiredStock,
      managedByRetailer: tenant.managedByRetailer,
    });
    await settle(client, status, 'UPDATE_OFFER_STOCK', ctx);
    sent.stock = row.desiredStock;
  }
  if (sendPrice) {
    const status = await updatePrice(client, row.offerId, {
      bundlePrices: [{ quantity: 1, unitPrice: Number(row.desiredPrice) }],
    });
    await settle(client, status, 'UPDATE_OFFER_PRICE', ctx);
    sent.price = Number(row.desiredPrice);
  }
}

/**
 * A 202 is not a success. Wait for the real answer, and treat an expired record
 * as "unknown" rather than "fine" — the reconciler finds out what truly landed.
 *
 * @param {import('../../bol/client.js').BolClient} client
 * @param {{ processStatusId: string }} accepted
 * @param {string} what
 * @param {any} ctx
 * @returns {Promise<void>}
 */
async function settle(client, accepted, what, ctx) {
  const status = await waitForCompletion(client, accepted.processStatusId, {
    intervalMs: 500,
    timeoutMs: 30_000,
  });
  if (status === null) {
    ctx.log?.warn({ what, id: accepted.processStatusId }, 'process status expired; reconcile will confirm');
    return;
  }
  if (status.status !== 'SUCCESS') {
    throw new RuleViolation(`V10_${what}_${status.status}`, {
      processStatusId: accepted.processStatusId,
      errorMessage: status.errorMessage ?? null,
    });
  }
}

/**
 * 404 and 409 are not ordinary failures and must not simply be retried.
 *
 * @param {unknown} err
 * @param {object} o
 * @returns {Promise<void>}
 */
async function handlePushError(err, { job, row, ctx }) {
  if (!(err instanceof BolApiError)) return;
  const { products, jobs } = ctx.repos;

  if (err.status === 404) {
    // The offer is gone on bol's side. Keep the product, forget the id, and let
    // the resolver look again — retrying the same dead id would never recover.
    await products.clearOfferId(job.tenantId, row.offerId);
    await jobs.enqueue({
      tenantId: job.tenantId,
      productId: job.productId,
      type: 'resolve_offer_id',
      dedupeKey: dedupeKey(job.tenantId, job.productId, 'resolve_offer_id'),
      payload: { productIds: [job.productId] },
      priority: PRIORITY.RESOLVE_OFFER_ID,
      maxAttempts: 3,
      runAfter: new Date(),
    });
    ctx.log?.warn({ productId: job.productId, offerId: row.offerId }, 'offer gone, id cleared');
    return;
  }

  if (err.status === 409) {
    // Our view of the offer is stale. Mark it so the next reconcile re-reads it;
    // the retry layer will try this job once more in a couple of seconds.
    await products.flagForReview(job.productId, 'CONFLICT_ON_PUSH');
  }
}
