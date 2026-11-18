/**
 * products + source_state + offer_state
 */

/**
 * @typedef {object} ProductRow
 * @property {number} id
 * @property {string} tenantId
 * @property {string} sku
 * @property {string|null} ean
 * @property {string|null} offerId
 * @property {boolean} syncEnabled
 */

/**
 * @typedef {object} SyncRow
 * @property {number} productId
 * @property {string} sku
 * @property {string|null} ean
 * @property {string|null} offerId
 * @property {number} sourceStock
 * @property {number} sourcePrice
 * @property {Date} observedAt
 * @property {number|null} desiredStock
 * @property {number|null} desiredPrice
 * @property {number|null} pushedStock
 * @property {number|null} pushedPrice
 * @property {number|null} bolStock
 * @property {number|null} bolCorrectedStock
 * @property {number|null} bolPrice
 */

/**
 * Build `($1::t, $2::t), ($3, $4)` for a multi-row VALUES list. Only the first
 * tuple carries casts; Postgres takes the column types from there.
 *
 * @param {number} rowCount
 * @param {string[]} types
 * @returns {string}
 */
function valuesList(rowCount, types) {
  const tuples = [];
  for (let r = 0; r < rowCount; r += 1) {
    const cells = types.map((type, c) => {
      const n = r * types.length + c + 1;
      return r === 0 ? `$${n}::${type}` : `$${n}`;
    });
    tuples.push(`(${cells.join(', ')})`);
  }
  return tuples.join(', ');
}

/** @param {Record<string, any>} r @returns {SyncRow} */
function toSyncRow(r) {
  return {
    productId: Number(r.product_id),
    sku: r.sku,
    ean: r.ean,
    offerId: r.offer_id,
    sourceStock: r.source_stock === null ? null : Number(r.source_stock),
    sourcePrice: r.source_price === null ? null : Number(r.source_price),
    observedAt: r.observed_at,
    desiredStock: r.desired_stock === null ? null : Number(r.desired_stock),
    desiredPrice: r.desired_price === null ? null : Number(r.desired_price),
    pushedStock: r.pushed_stock === null ? null : Number(r.pushed_stock),
    pushedPrice: r.pushed_price === null ? null : Number(r.pushed_price),
    bolStock: r.bol_stock === null ? null : Number(r.bol_stock),
    bolCorrectedStock: r.bol_corrected_stock === null ? null : Number(r.bol_corrected_stock),
    bolPrice: r.bol_price === null ? null : Number(r.bol_price),
  };
}

export class ProductsRepo {
  /** @param {import('pg').Pool} pool */
  constructor(pool) {
    this.pool = pool;
  }

  /**
   * A missing EAN in the feed must not erase one we already know. Suppliers
   * leave the column empty far more often than they correct it.
   *
   * @param {string} tenantId
   * @param {Array<{ sku: string, ean: string|null }>} items
   * @returns {Promise<number>}
   */
  async upsertProducts(tenantId, items) {
    if (items.length === 0) return 0;

    const params = [tenantId];
    const tuples = items.map((item, i) => {
      params.push(item.sku, item.ean ?? null);
      const a = i * 2 + 2;
      return i === 0 ? `($1::uuid, $${a}::text, $${a + 1}::text)` : `($1, $${a}, $${a + 1})`;
    });

    const { rowCount } = await this.pool.query(
      `INSERT INTO products (tenant_id, sku, ean)
       VALUES ${tuples.join(', ')}
       ON CONFLICT (tenant_id, sku)
       DO UPDATE SET ean = COALESCE(EXCLUDED.ean, products.ean)`,
      params,
    );
    return rowCount ?? 0;
  }

  /**
   * @param {string} tenantId
   * @param {string[]} skus
   * @returns {Promise<Map<string, number>>}
   */
  async idsBySku(tenantId, skus) {
    if (skus.length === 0) return new Map();
    const { rows } = await this.pool.query(
      `SELECT id, sku FROM products WHERE tenant_id = $1 AND sku = ANY($2::text[])`,
      [tenantId, skus],
    );
    return new Map(rows.map((r) => [r.sku, Number(r.id)]));
  }

  /**
   * Write the source snapshot and report which products actually changed.
   *
   * Two things happen here and they are deliberately separate:
   *
   *   - `observed_at` is refreshed for EVERY row in the feed, changed or not.
   *     A product whose stock has been 7 for three hours is not stale data; it
   *     is fresh data that happens to be identical. If we skipped the write,
   *     the staleness guard would eventually refuse to plan a perfectly healthy
   *     product, and a later reconcile could not re-push it.
   *   - the returned ids are only those whose payload_hash moved. That is what
   *     saves the planning and diffing work.
   *
   * Returns the changed product ids rather than a count, because the caller
   * needs to know *which* ones; a number would force a second query.
   *
   * @param {Array<{ productId: number, stock: number, price: number, sourceName: string, payloadHash: string, observedAt: Date }>} rows
   * @returns {Promise<number[]>} product ids whose payload changed
   */
  async upsertSourceState(rows) {
    if (rows.length === 0) return [];

    const params = [];
    for (const r of rows) {
      params.push(r.productId, r.stock, r.price, r.sourceName, r.payloadHash, r.observedAt);
    }
    const values = valuesList(rows.length, [
      'bigint',
      'integer',
      'numeric',
      'text',
      'text',
      'timestamptz',
    ]);

    // `prev` reads the pre-update snapshot: CTEs in one statement all see the
    // same starting state, so the comparison is against the old hash even
    // though `ups` is overwriting it.
    const { rows: changed } = await this.pool.query(
      `WITH incoming (product_id, stock, price, source_name, payload_hash, observed_at)
              AS (VALUES ${values}),
            prev AS (
              SELECT s.product_id, s.payload_hash
                FROM source_state s
                JOIN incoming i ON i.product_id = s.product_id
            ),
            ups AS (
              INSERT INTO source_state
                     (product_id, stock, price, source_name, payload_hash, observed_at)
              SELECT product_id, stock, price, source_name, payload_hash, observed_at
                FROM incoming
              ON CONFLICT (product_id) DO UPDATE
                 SET stock        = EXCLUDED.stock,
                     price        = EXCLUDED.price,
                     source_name  = EXCLUDED.source_name,
                     payload_hash = EXCLUDED.payload_hash,
                     observed_at  = EXCLUDED.observed_at
              RETURNING product_id
            )
       SELECT i.product_id
         FROM incoming i
         LEFT JOIN prev p ON p.product_id = i.product_id
        WHERE p.payload_hash IS DISTINCT FROM i.payload_hash`,
      params,
    );
    return changed.map((r) => Number(r.product_id));
  }

  /**
   * Everything the planner and differ need, in one query.
   *
   * `onlyChanged` means "observed since we last planned it", which is the
   * cheapest honest definition of work to do.
   *
   * @param {string} tenantId
   * @param {{ onlyChanged?: boolean, limit?: number, productIds?: number[] }} [o]
   * @returns {Promise<SyncRow[]>}
   */
  async loadSyncRows(tenantId, o = {}) {
    const where = ['p.tenant_id = $1', 'p.sync_enabled'];
    const params = [tenantId];

    if (o.productIds?.length) {
      params.push(o.productIds);
      where.push(`p.id = ANY($${params.length}::bigint[])`);
    }
    if (o.onlyChanged) {
      where.push('(o.planned_at IS NULL OR s.observed_at > o.planned_at)');
    }

    let sql = `SELECT p.id AS product_id, p.sku, p.ean, p.offer_id,
                      s.stock AS source_stock, s.price AS source_price, s.observed_at,
                      o.desired_stock, o.desired_price,
                      o.pushed_stock, o.pushed_price,
                      o.bol_stock, o.bol_corrected_stock, o.bol_price
                 FROM products p
                 JOIN source_state s ON s.product_id = p.id
                 LEFT JOIN offer_state o ON o.product_id = p.id
                WHERE ${where.join(' AND ')}
                ORDER BY p.id`;

    if (o.limit) {
      params.push(o.limit);
      sql += ` LIMIT $${params.length}`;
    }

    const { rows } = await this.pool.query(sql, params);
    return rows.map(toSyncRow);
  }

  /**
   * @param {Array<{ productId: number, desiredStock: number|null, desiredPrice: number|null }>} plans
   * @returns {Promise<void>}
   */
  async saveDesired(plans) {
    if (plans.length === 0) return;

    const params = [];
    for (const p of plans) params.push(p.productId, p.desiredStock, p.desiredPrice);
    const values = valuesList(plans.length, ['bigint', 'integer', 'numeric']);

    await this.pool.query(
      `INSERT INTO offer_state (product_id, desired_stock, desired_price, planned_at)
       SELECT v.product_id, v.desired_stock, v.desired_price, now()
         FROM (VALUES ${values}) AS v (product_id, desired_stock, desired_price)
       ON CONFLICT (product_id) DO UPDATE
          SET desired_stock = EXCLUDED.desired_stock,
              desired_price = EXCLUDED.desired_price,
              planned_at    = now()`,
      params,
    );
  }

  /**
   * Called only after bol confirmed the write (204 on v11, SUCCESS on v10).
   *
   * Writing this before the confirmation would be the worst bug in the service:
   * we would believe bol has a stock it never received, and never send it again.
   *
   * @param {number} productId
   * @param {{ stock?: number, price?: number }} sent
   * @returns {Promise<void>}
   */
  async markPushed(productId, sent) {
    await this.pool.query(
      `INSERT INTO offer_state (product_id, pushed_stock, pushed_price, pushed_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (product_id) DO UPDATE
          SET pushed_stock = COALESCE(EXCLUDED.pushed_stock, offer_state.pushed_stock),
              pushed_price = COALESCE(EXCLUDED.pushed_price, offer_state.pushed_price),
              pushed_at    = now()`,
      [productId, sent.stock ?? null, sent.price ?? null],
    );
  }

  /**
   * What bol reports back, plus the drift flag.
   *
   * `correctedStock` is stored separately from `amount` on purpose: amount is
   * what we sent, correctedStock is what actually sells once bol subtracts open
   * orders. Only the second one explains an offer that is live but invisible.
   *
   * @param {string} tenantId
   * @param {Array<{ offerId: string, stock: object, pricing: object, lastModifiedDateTime: string }>} offers
   * @returns {Promise<number>} rows matched
   */
  async saveRemoteState(tenantId, offers) {
    if (offers.length === 0) return 0;

    const params = [tenantId];
    const tuples = offers.map((o, i) => {
      const unit = o.pricing?.bundlePrices?.find((b) => b.quantity === 1)?.unitPrice ?? null;
      params.push(
        o.offerId,
        o.stock?.amount ?? null,
        o.stock?.correctedStock ?? null,
        unit,
        o.lastModifiedDateTime ?? null,
      );
      const a = i * 5 + 2;
      const cells = [`$${a}`, `$${a + 1}`, `$${a + 2}`, `$${a + 3}`, `$${a + 4}`];
      return i === 0
        ? `(${cells[0]}::uuid, ${cells[1]}::integer, ${cells[2]}::integer, ${cells[3]}::numeric, ${cells[4]}::timestamptz)`
        : `(${cells.join(', ')})`;
    });

    const { rowCount } = await this.pool.query(
      `WITH incoming (offer_id, amount, corrected, price, last_modified)
              AS (VALUES ${tuples.join(', ')}),
            matched AS (
              SELECT p.id AS product_id, i.*
                FROM incoming i
                JOIN products p ON p.offer_id = i.offer_id AND p.tenant_id = $1
            )
       INSERT INTO offer_state
              (product_id, bol_stock, bol_corrected_stock, bol_price,
               bol_last_modified, reconciled_at)
       SELECT product_id, amount, corrected, price, last_modified, now() FROM matched
       ON CONFLICT (product_id) DO UPDATE
          SET bol_stock           = EXCLUDED.bol_stock,
              bol_corrected_stock = EXCLUDED.bol_corrected_stock,
              bol_price           = EXCLUDED.bol_price,
              bol_last_modified   = EXCLUDED.bol_last_modified,
              reconciled_at       = now(),
              drift_detected_at   =
                CASE WHEN offer_state.pushed_stock IS DISTINCT FROM EXCLUDED.bol_stock
                       OR offer_state.pushed_price IS DISTINCT FROM EXCLUDED.bol_price
                     THEN COALESCE(offer_state.drift_detected_at, now())
                     ELSE NULL
                END`,
      params,
    );
    return rowCount ?? 0;
  }

  /**
   * @param {string} tenantId
   * @param {number} limit
   * @returns {Promise<ProductRow[]>}
   */
  async findUnresolved(tenantId, limit) {
    const { rows } = await this.pool.query(
      `SELECT id, tenant_id, sku, ean, offer_id, sync_enabled
         FROM products
        WHERE tenant_id = $1 AND offer_id IS NULL AND sync_enabled
        ORDER BY id
        LIMIT $2`,
      [tenantId, limit],
    );
    return rows.map((r) => ({
      id: Number(r.id),
      tenantId: r.tenant_id,
      sku: r.sku,
      ean: r.ean,
      offerId: r.offer_id,
      syncEnabled: r.sync_enabled,
    }));
  }

  /**
   * Attach offer ids found by EAN.
   *
   * Two guards, both learned from the shape of the unique index on
   * (tenant_id, offer_id): only products that have no offer id yet are touched,
   * and a tenant that lists the same EAN under two SKUs gets exactly one of
   * them attached instead of a constraint violation that fails the whole batch.
   *
   * @param {Map<string, string>} eanToOfferId
   * @param {string} tenantId
   * @returns {Promise<number>}
   */
  async attachOfferIds(eanToOfferId, tenantId) {
    if (eanToOfferId.size === 0) return 0;

    const params = [tenantId];
    const tuples = [...eanToOfferId].map(([ean, offerId], i) => {
      params.push(ean, offerId);
      const a = i * 2 + 2;
      return i === 0 ? `($${a}::text, $${a + 1}::uuid)` : `($${a}, $${a + 1})`;
    });

    const { rowCount } = await this.pool.query(
      `WITH incoming (ean, offer_id) AS (VALUES ${tuples.join(', ')}),
            pick AS (
              SELECT DISTINCT ON (p.ean) p.id, i.offer_id
                FROM products p
                JOIN incoming i ON i.ean = p.ean
               WHERE p.tenant_id = $1 AND p.offer_id IS NULL AND p.sync_enabled
               ORDER BY p.ean, p.id
            )
       UPDATE products p
          SET offer_id = pick.offer_id
         FROM pick
        WHERE p.id = pick.id`,
      params,
    );
    return rowCount ?? 0;
  }

  /**
   * The offer is gone on bol's side (404). Forget the id so the next run can
   * resolve it again; keep the product, because the SKU still exists here.
   *
   * @param {string} tenantId
   * @param {string} offerId
   * @returns {Promise<void>}
   */
  async clearOfferId(tenantId, offerId) {
    await this.pool.query(
      `UPDATE products SET offer_id = NULL WHERE tenant_id = $1 AND offer_id = $2`,
      [tenantId, offerId],
    );
  }

  /**
   * @param {number} productId
   * @param {string} reason
   * @returns {Promise<void>}
   */
  async disableSync(productId, reason) {
    await this.pool.query(
      `UPDATE products SET sync_enabled = false, disabled_reason = $2 WHERE id = $1`,
      [productId, String(reason).slice(0, 500)],
    );
  }

  /**
   * Offers where bol disagrees with what we last sent.
   *
   * The flag is set in saveRemoteState, which is the only place that sees
   * pushed_* and bol_* in the same row. Something outside this service changed
   * the offer: the seller by hand, a repricer, or a v10 write that reported
   * success and did not land.
   *
   * @param {string} tenantId
   * @returns {Promise<SyncRow[]>}
   */
  async findDrifted(tenantId) {
    const { rows } = await this.pool.query(
      `SELECT p.id AS product_id, p.sku, p.ean, p.offer_id,
              s.stock AS source_stock, s.price AS source_price, s.observed_at,
              o.desired_stock, o.desired_price, o.pushed_stock, o.pushed_price,
              o.bol_stock, o.bol_corrected_stock, o.bol_price
         FROM products p
         JOIN offer_state o ON o.product_id = p.id
         LEFT JOIN source_state s ON s.product_id = p.id
        WHERE p.tenant_id = $1
          AND p.sync_enabled
          AND o.drift_detected_at IS NOT NULL
        ORDER BY o.drift_detected_at`,
      [tenantId],
    );
    return rows.map(toSyncRow);
  }

  /**
   * correctedStock = 0 while desired_stock > 0: on our books but off the shelf.
   *
   * This is the query that finds the money leak. The offer looks healthy in
   * every dashboard — stock sent, no error, no drift — and still sells nothing,
   * because bol has subtracted open orders down to zero.
   *
   * @param {string} tenantId
   * @returns {Promise<SyncRow[]>}
   */
  async findInvisibleOffers(tenantId) {
    const { rows } = await this.pool.query(
      `SELECT p.id AS product_id, p.sku, p.ean, p.offer_id,
              s.stock AS source_stock, s.price AS source_price, s.observed_at,
              o.desired_stock, o.desired_price, o.pushed_stock, o.pushed_price,
              o.bol_stock, o.bol_corrected_stock, o.bol_price
         FROM products p
         JOIN offer_state o ON o.product_id = p.id
         LEFT JOIN source_state s ON s.product_id = p.id
        WHERE p.tenant_id = $1
          AND p.sync_enabled
          AND o.bol_corrected_stock = 0
          AND o.desired_stock > 0
        ORDER BY o.desired_stock DESC`,
      [tenantId],
    );
    return rows.map(toSyncRow);
  }

  /**
   * One statement, because "everything was skipped" is a normal outcome — a
   * stale feed skips the whole catalogue, and 5,000 round trips to say so would
   * cost more than the sync itself.
   *
   * @param {Array<{ productId: number, reason: string }>} entries
   * @returns {Promise<number>}
   */
  async flagForReviewMany(entries) {
    if (entries.length === 0) return 0;

    const params = [];
    for (const e of entries) params.push(e.productId, String(e.reason).slice(0, 500));
    const values = valuesList(entries.length, ['bigint', 'text']);

    const { rowCount } = await this.pool.query(
      `INSERT INTO offer_state (product_id, needs_manual_review, review_reason)
       SELECT v.product_id, true, v.reason FROM (VALUES ${values}) AS v (product_id, reason)
       ON CONFLICT (product_id) DO UPDATE
          SET needs_manual_review = true, review_reason = EXCLUDED.review_reason`,
      params,
    );
    return rowCount ?? 0;
  }

  /**
   * @param {number} productId
   * @param {string} reason
   * @returns {Promise<void>}
   */
  async flagForReview(productId, reason) {
    await this.pool.query(
      `INSERT INTO offer_state (product_id, needs_manual_review, review_reason)
       VALUES ($1, true, $2)
       ON CONFLICT (product_id) DO UPDATE
          SET needs_manual_review = true, review_reason = EXCLUDED.review_reason`,
      [productId, String(reason).slice(0, 500)],
    );
  }
}

export { toSyncRow };
