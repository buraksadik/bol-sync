/**
 * Handler: pull_source
 *
 * Reads the source shop, stores the snapshot, plans, diffs and enqueues
 * push_offer jobs.
 *
 * Steps:
 *   1. source.fetchAll() or fetchBySku() when the payload names SKUs
 *   2. skip rows whose payload_hash is unchanged
 *   3. upsert source_state
 *   4. planner.planBatch() -> desired_*
 *   5. bulk-drop guard: if it trips, write a review row and enqueue nothing
 *   6. differ.diffBatch() -> push_offer jobs, deduplicated
 *
 * A source that throws must not clear source_state. Old data going stale is
 * handled by the staleness rule; deleted data is not handled by anything.
 *
 * The same goes for a product that quietly disappears from the feed: it keeps
 * its last snapshot, goes stale, and stops being planned. It is never set to
 * zero. A supplier dropping a row is not a supplier saying "none left", and
 * guessing which one they meant is how a catalogue goes dark overnight.
 */

import { hashItem, assertSourceItem } from '../../sources/source.interface.js';
import { planBatch } from '../../sync/planner.js';
import { diffBatch, dedupeKey, PRIORITY } from '../../sync/differ.js';
import { DEFAULT_RULE } from '../../sync/safetyStock.js';
import { DEFAULT_PRICE_RULE } from '../../sync/pricing.js';
import { RuleViolation } from '../../core/errors.js';

/** @typedef {import('../worker.js').JobHandler} JobHandler */

/**
 * The rules arrive already ordered by the repository: SKU scope first, then
 * ascending priority. So the first one that applies is the most specific one.
 *
 * @template T
 * @param {Array<T & { scope: string, sku?: string }>} rules
 * @param {string} sku
 * @param {T} fallback
 * @returns {T}
 */
function pickRule(rules, sku, fallback) {
  return rules.find((r) => r.scope === 'tenant' || r.sku === sku) ?? fallback;
}

/** @type {JobHandler} */
export async function pullSourceHandler(job, ctx) {
  const { products, rules, jobs } = ctx.repos;
  const tenant = await rules.getTenant(job.tenantId);
  const source = await ctx.sourceFor(job.tenantId);

  // 1. Read the source.
  /** @type {string[]|null} */
  const skus = Array.isArray(job.payload?.skus) && job.payload.skus.length > 0
    ? job.payload.skus
    : null;
  const items = (skus ? await source.fetchBySku(skus) : await source.fetchAll()).map(
    assertSourceItem,
  );

  if (items.length === 0) {
    // Not an error and not a reason to touch anything. An empty read leaves the
    // previous snapshot alone and lets the staleness guard do its job.
    ctx.log?.warn({ tenantId: job.tenantId, source: source.name }, 'source returned no items');
    return;
  }

  // 2+3. Register the SKUs, then write the snapshot. The write refreshes
  // observed_at for every row and tells us which payloads actually moved.
  await products.upsertProducts(
    job.tenantId,
    items.map((i) => ({ sku: i.sku, ean: i.ean })),
  );
  const idBySku = await products.idsBySku(
    job.tenantId,
    items.map((i) => i.sku),
  );

  const changedIds = await products.upsertSourceState(
    items
      .filter((i) => idBySku.has(i.sku))
      .map((i) => ({
        productId: /** @type {number} */ (idBySku.get(i.sku)),
        stock: i.stock,
        price: i.price,
        sourceName: source.name,
        payloadHash: hashItem(i),
        observedAt: i.observedAt,
      })),
  );

  if (changedIds.length === 0) {
    ctx.log?.debug({ tenantId: job.tenantId, seen: items.length }, 'nothing changed');
    return;
  }

  // 4. Plan only what moved.
  const syncRows = await products.loadSyncRows(job.tenantId, { productIds: changedIds });
  const [safety, price] = await Promise.all([
    rules.safetyRules(job.tenantId),
    rules.priceRules(job.tenantId),
  ]);

  const planInputs = syncRows.map((row) => ({
    productId: row.productId,
    sku: row.sku,
    sourceStock: row.sourceStock,
    sourcePrice: row.sourcePrice,
    observedAt: row.observedAt,
    pushedStock: row.pushedStock,
    pushedPrice: row.pushedPrice,
    safetyRule: pickRule(safety, row.sku, { ...DEFAULT_RULE, ...ctx.config.safety }),
    priceRule: pickRule(price, row.sku, { ...DEFAULT_PRICE_RULE, ...ctx.config.price }),
  }));

  const { plans, guard } = planBatch(planInputs, {
    staleAfterMin: ctx.config.safety.staleAfterMin,
    bulkDropGuardPct: ctx.config.safety.bulkDropGuardPct,
  });

  // 5. Guard. Throwing a RuleViolation is how this reaches a human: the worker
  // classifies it as permanent, writes a dead_letters row with the numbers, and
  // stops. Nothing has been planned or enqueued, and the next scheduled pull
  // will try again on fresher data.
  if (guard.tripped) {
    throw new RuleViolation('BULK_DROP_GUARD', {
      tenantId: job.tenantId,
      source: source.name,
      sharePct: Math.round(guard.share),
      guardPct: ctx.config.safety.bulkDropGuardPct,
      planned: planInputs.length,
    });
  }

  const usable = plans.filter((p) => !p.skipped);
  await products.saveDesired(
    usable.map((p) => ({
      productId: p.productId,
      desiredStock: p.desiredStock,
      desiredPrice: p.desiredPrice,
    })),
  );

  // A product the planner refused is worth seeing, but it must not stop the
  // other 4,999 from being pushed.
  await products.flagForReviewMany(
    plans
      .filter((p) => p.skipped || p.skipReason)
      .map((p) => ({ productId: p.productId, reason: p.skipReason ?? 'SKIPPED' })),
  );

  // 6. Diff and enqueue.
  const byId = new Map(syncRows.map((r) => [r.productId, r]));
  const pushJobs = diffBatch(
    usable.map((p) => {
      const row = /** @type {any} */ (byId.get(p.productId));
      return {
        productId: p.productId,
        offerId: row.offerId,
        desiredStock: p.desiredStock,
        desiredPrice: p.desiredPrice,
        pushedStock: row.pushedStock,
        pushedPrice: row.pushedPrice,
        safetyRule: pickRule(safety, row.sku, { ...DEFAULT_RULE, ...ctx.config.safety }),
      };
    }),
    { managedByRetailer: tenant.managedByRetailer },
  );

  const written = await jobs.enqueueMany(
    pushJobs.map((p) => ({
      tenantId: job.tenantId,
      productId: p.productId,
      type: p.type,
      dedupeKey: dedupeKey(job.tenantId, p.productId, p.type),
      payload: { patch: p.patch, reasons: p.reasons },
      priority: p.priority,
      maxAttempts: ctx.config.worker.maxAttempts,
      runAfter: new Date(),
    })),
  );

  ctx.log?.info(
    {
      tenantId: job.tenantId,
      seen: items.length,
      changed: changedIds.length,
      planned: usable.length,
      enqueued: written,
    },
    'pull_source done',
  );
}

export { pickRule, PRIORITY };
