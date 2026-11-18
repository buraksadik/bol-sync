/**
 * tenants + safety_stock_rules + price_rules
 */

import { encryptSecret, decryptSecret } from '../../core/secrets.js';

// Re-exported so callers that already reach for the repository do not need to
// know where the crypto lives.
export { encryptSecret, decryptSecret };

/**
 * @typedef {object} Tenant
 * @property {string} id
 * @property {string} name
 * @property {string} bolClientId
 * @property {'v10'|'v11'} offersApiVersion
 * @property {number} rateBudgetPct
 * @property {boolean} managedByRetailer
 * @property {Date|null} pausedUntil
 * @property {boolean} active
 */

/** @param {Record<string, any>} r @returns {Tenant} */
function toTenant(r) {
  return {
    id: r.id,
    name: r.name,
    bolClientId: r.bol_client_id,
    offersApiVersion: r.offers_api_version,
    rateBudgetPct: Number(r.rate_budget_pct),
    managedByRetailer: r.managed_by_retailer,
    pausedUntil: r.paused_until,
    active: r.active,
  };
}

const TENANT_COLUMNS = `id, name, bol_client_id, offers_api_version, rate_budget_pct,
                        managed_by_retailer, paused_until, active`;

export class RulesRepo {
  /**
   * @param {import('pg').Pool} pool
   * @param {Buffer} [encKey]  BOL_CRED_ENC_KEY, 32 bytes
   */
  constructor(pool, encKey) {
    this.pool = pool;
    this.encKey = encKey ?? null;
  }

  /**
   * Active and not paused. A paused tenant stays in the table and comes back by
   * itself once `paused_until` passes — no manual step to forget.
   *
   * @returns {Promise<Tenant[]>}
   */
  async activeTenants() {
    const { rows } = await this.pool.query(
      `SELECT ${TENANT_COLUMNS} FROM tenants
        WHERE active AND (paused_until IS NULL OR paused_until <= now())
        ORDER BY created_at`,
    );
    return rows.map(toTenant);
  }

  /** @param {string} tenantId @returns {Promise<Tenant>} */
  async getTenant(tenantId) {
    const { rows } = await this.pool.query(
      `SELECT ${TENANT_COLUMNS} FROM tenants WHERE id = $1`,
      [tenantId],
    );
    if (rows.length === 0) throw new Error(`TENANT_NOT_FOUND: ${tenantId}`);
    return toTenant(rows[0]);
  }

  /**
   * Decrypts bol_client_secret_enc with BOL_CRED_ENC_KEY.
   * The return value must never be logged or stored.
   *
   * @param {string} tenantId
   * @returns {Promise<{ clientId: string, clientSecret: string }>}
   */
  async getCredentials(tenantId) {
    if (!this.encKey) throw new Error('CRED_ENC_KEY_MISSING');
    const { rows } = await this.pool.query(
      `SELECT bol_client_id, bol_client_secret_enc FROM tenants WHERE id = $1`,
      [tenantId],
    );
    if (rows.length === 0) throw new Error(`TENANT_NOT_FOUND: ${tenantId}`);
    return {
      clientId: rows[0].bol_client_id,
      clientSecret: decryptSecret(rows[0].bol_client_secret_enc, this.encKey),
    };
  }

  /**
   * @param {string} tenantId
   * @param {string} clientId
   * @param {string} clientSecret
   * @returns {Promise<void>}
   */
  async setCredentials(tenantId, clientId, clientSecret) {
    if (!this.encKey) throw new Error('CRED_ENC_KEY_MISSING');
    await this.pool.query(
      `UPDATE tenants SET bol_client_id = $2, bol_client_secret_enc = $3 WHERE id = $1`,
      [tenantId, clientId, encryptSecret(clientSecret, this.encKey)],
    );
  }

  /**
   * @param {string} tenantId
   * @param {Date} until
   * @param {string} reason
   * @returns {Promise<void>}
   */
  async pauseTenant(tenantId, until, reason) {
    await this.pool.query(`UPDATE tenants SET paused_until = $2 WHERE id = $1`, [
      tenantId,
      until,
    ]);
    await this.pool.query(
      `INSERT INTO dead_letters (tenant_id, reason, detail)
       VALUES ($1, 'TENANT_PAUSED', $2::jsonb)`,
      [tenantId, JSON.stringify({ reason, until })],
    );
  }

  /**
   * Rules come back ordered the way resolveRule() wants to read them: SKU scope
   * before tenant scope, lower priority first. Sorting in SQL keeps the two
   * places from disagreeing about what "most specific" means.
   *
   * @param {string} tenantId
   * @returns {Promise<Array<import('../../sync/safetyStock.js').SafetyRule & { scope: 'tenant'|'sku', sku?: string, priority: number }>>}
   */
  async safetyRules(tenantId) {
    const { rows } = await this.pool.query(
      `SELECT scope, sku, buffer_abs, buffer_pct, min_publish, max_publish,
              stock_delta_threshold, priority
         FROM safety_stock_rules
        WHERE tenant_id = $1
        ORDER BY (scope = 'sku') DESC, priority ASC, id ASC`,
      [tenantId],
    );
    return rows.map((r) => ({
      scope: r.scope,
      sku: r.sku ?? undefined,
      bufferAbs: Number(r.buffer_abs),
      bufferPct: Number(r.buffer_pct),
      minPublish: Number(r.min_publish),
      maxPublish: Number(r.max_publish),
      stockDeltaThreshold: Number(r.stock_delta_threshold),
      priority: Number(r.priority),
    }));
  }

  /**
   * @param {string} tenantId
   * @returns {Promise<Array<import('../../sync/pricing.js').PriceRule & { scope: 'tenant'|'sku', sku?: string, priority: number }>>}
   */
  async priceRules(tenantId) {
    const { rows } = await this.pool.query(
      `SELECT scope, sku, markup_pct, floor_price, ceiling_price, rounding,
              max_change_pct, priority
         FROM price_rules
        WHERE tenant_id = $1
        ORDER BY (scope = 'sku') DESC, priority ASC, id ASC`,
      [tenantId],
    );
    return rows.map((r) => ({
      scope: r.scope,
      sku: r.sku ?? undefined,
      markupPct: Number(r.markup_pct),
      floorPrice: r.floor_price === null ? null : Number(r.floor_price),
      ceilingPrice: r.ceiling_price === null ? null : Number(r.ceiling_price),
      rounding: r.rounding,
      maxChangePct: Number(r.max_change_pct),
      priority: Number(r.priority),
    }));
  }
}
