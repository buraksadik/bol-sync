/**
 * Handlers: reconcile and resolve_offer_id
 */

import { reconcile } from '../../sync/reconciler.js';
import { resolveOfferIdsByEan } from '../../bol/offers.v11.js';
import { dedupeKey, PRIORITY } from '../../sync/differ.js';

/** @typedef {import('../worker.js').JobHandler} JobHandler */

/**
 * Walks GET /retailer/offers with a cursor, writes bol_* columns, flags drift
 * and invisible offers, opens a reconcile_runs row.
 *
 * payload: { mode: 'incremental' | 'full', since?: string }
 *
 * @type {JobHandler}
 */
export async function reconcileHandler(job, ctx) {
  const { products, jobs, logs } = ctx.repos;
  const mode = job.payload?.mode === 'full' ? 'full' : 'incremental';

  // Where to resume from. Only finished runs count: resuming from one that
  // crashed halfway would skip everything it never got to read.
  const since =
    mode === 'full'
      ? null
      : (job.payload?.since ? new Date(job.payload.since) : await logs.lastReconcileAt(job.tenantId));

  const runId = await logs.startReconcileRun({ tenantId: job.tenantId, mode, since });
  const client = await ctx.clientFor(job.tenantId);
  client.context = { productId: null, jobId: job.id };

  const result = await reconcile({
    client,
    tenantId: job.tenantId,
    since,
    products,
    jobs,
    maxAttempts: ctx.config.worker.maxAttempts,
  });

  await logs.finishReconcileRun(runId, result);

  ctx.log?.info(
    {
      tenantId: job.tenantId,
      mode,
      seen: result.offersSeen,
      drift: result.driftFound,
      invisible: result.invisibleFound,
      requeued: result.requeuedProductIds.length,
    },
    'reconcile done',
  );

  if (result.invisibleFound > 0) {
    // Not an error and not re-pushable: bol has subtracted open orders and the
    // offer is off the shelf. It is lost revenue, so it gets said out loud.
    ctx.log?.warn(
      { tenantId: job.tenantId, count: result.invisibleFound },
      'offers live but invisible (correctedStock 0)',
    );
  }
}

/**
 * Fills products.offer_id from the EAN.
 *
 * Batches EANs into the `eans` filter rather than asking one by one. An EAN with
 * no offer is left unresolved and reported; it is not auto-created, because a
 * duplicate offer on a seller's account is a support ticket, not a feature.
 *
 * payload: { productIds: number[] }
 *
 * @type {JobHandler}
 */
export async function resolveOfferIdHandler(job, ctx) {
  const { products, jobs } = ctx.repos;

  const candidates = Array.isArray(job.payload?.productIds) && job.payload.productIds.length > 0
    ? await products.loadSyncRows(job.tenantId, { productIds: job.payload.productIds })
    : await products.findUnresolved(job.tenantId, 500);

  const withEan = candidates.filter((p) => p.ean);
  const withoutEan = candidates.filter((p) => !p.ean);

  for (const p of withoutEan) {
    // No EAN means no way to find the offer and no safe way to create one.
    // Stop trying rather than queue it forever.
    await products.disableSync(p.id ?? p.productId, 'NO_EAN');
  }

  if (withEan.length === 0) {
    ctx.log?.info({ tenantId: job.tenantId, disabled: withoutEan.length }, 'nothing to resolve');
    return;
  }

  const client = await ctx.clientFor(job.tenantId);
  client.context = { productId: null, jobId: job.id };

  const eans = [...new Set(withEan.map((p) => /** @type {string} */ (p.ean)))];
  const found = await resolveOfferIdsByEan(client, eans);
  const attached = await products.attachOfferIds(found, job.tenantId);

  // Everything we asked about and did not find. These are real: the seller
  // lists the product in the shop but has no offer on bol yet.
  const missing = withEan.filter((p) => !found.has(/** @type {string} */ (p.ean)));
  await products.flagForReviewMany(
    missing.map((p) => ({ productId: p.id ?? p.productId, reason: 'NO_OFFER_ON_BOL' })),
  );

  // Resolved products can finally be pushed.
  const resolved = withEan.filter((p) => found.has(/** @type {string} */ (p.ean)));
  await jobs.enqueueMany(
    resolved.map((p) => {
      const productId = p.id ?? p.productId;
      return {
        tenantId: job.tenantId,
        productId,
        type: 'push_offer',
        dedupeKey: dedupeKey(job.tenantId, productId, 'push_offer'),
        payload: { reasons: ['OFFER_RESOLVED'] },
        priority: PRIORITY.STOCK_DECREASE,
        maxAttempts: ctx.config.worker.maxAttempts,
        runAfter: new Date(),
      };
    }),
  );

  ctx.log?.info(
    {
      tenantId: job.tenantId,
      asked: eans.length,
      attached,
      missing: missing.length,
      noEan: withoutEan.length,
    },
    'resolve_offer_id done',
  );
}
