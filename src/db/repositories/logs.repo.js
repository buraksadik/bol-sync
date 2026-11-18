/**
 * sync_log + reconcile_runs
 */

/**
 * Keys whose value never reaches the database, whatever nesting they sit at.
 * The list is deliberately broad: a log line is worth less than a leaked key.
 */
const SECRET_KEYS = [
  'authorization',
  'client_secret',
  'clientsecret',
  'access_token',
  'accesstoken',
  'refresh_token',
  'password',
  'secret',
  'token',
  'apikey',
  'api_key',
  'cookie',
  'set-cookie',
];

/**
 * Deep copy with secrets replaced and long strings clipped.
 *
 * @param {unknown} value
 * @param {number} [depth]
 * @returns {unknown}
 */
export function redact(value, depth = 0) {
  if (depth > 6) return '[deep]';
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === 'string') return value.length > 2000 ? `${value.slice(0, 2000)}…` : value;
  if (typeof value !== 'object') return value;
  if (Buffer.isBuffer(value)) return '[buffer]';
  if (Array.isArray(value)) return value.slice(0, 200).map((v) => redact(v, depth + 1));

  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SECRET_KEYS.includes(k.toLowerCase()) ? '[redacted]' : redact(v, depth + 1);
  }
  return out;
}

export class LogsRepo {
  /** @param {import('pg').Pool} pool */
  constructor(pool) {
    this.pool = pool;
  }

  /**
   * One API call, one row. This is the table a client is shown when they ask
   * "why is this SKU wrong", so it holds the request and the response, with
   * every credential stripped first.
   *
   * @param {object} entry
   * @param {string} entry.tenantId
   * @param {number|null} [entry.productId]
   * @param {number|null} [entry.jobId]
   * @param {string} entry.action
   * @param {number|null} entry.httpStatus
   * @param {object|null} entry.request
   * @param {object|null} entry.response
   * @param {number} entry.durationMs
   * @returns {Promise<void>}
   */
  async write(entry) {
    await this.pool.query(
      `INSERT INTO sync_log
         (tenant_id, product_id, job_id, action, http_status, request, response, duration_ms)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8)`,
      [
        entry.tenantId,
        entry.productId ?? null,
        entry.jobId ?? null,
        entry.action,
        entry.httpStatus ?? null,
        entry.request ? JSON.stringify(redact(entry.request)) : null,
        entry.response ? JSON.stringify(redact(entry.response)) : null,
        Math.round(entry.durationMs ?? 0),
      ],
    );
  }

  /**
   * A full sync writes thousands of log rows. One statement instead of one
   * round trip per call, or the audit trail becomes the bottleneck.
   *
   * @param {object[]} entries
   * @returns {Promise<number>}
   */
  async writeMany(entries) {
    if (entries.length === 0) return 0;

    const params = [];
    const tuples = entries.map((e, i) => {
      params.push(
        e.tenantId,
        e.productId ?? null,
        e.jobId ?? null,
        e.action,
        e.httpStatus ?? null,
        e.request ? JSON.stringify(redact(e.request)) : null,
        e.response ? JSON.stringify(redact(e.response)) : null,
        Math.round(e.durationMs ?? 0),
      );
      const a = i * 8 + 1;
      const c = Array.from({ length: 8 }, (_, k) => `$${a + k}`);
      return i === 0
        ? `(${c[0]}::uuid, ${c[1]}::bigint, ${c[2]}::bigint, ${c[3]}::text, ${c[4]}::integer, ${c[5]}::jsonb, ${c[6]}::jsonb, ${c[7]}::integer)`
        : `(${c.join(', ')})`;
    });

    const { rowCount } = await this.pool.query(
      `INSERT INTO sync_log
         (tenant_id, product_id, job_id, action, http_status, request, response, duration_ms)
       VALUES ${tuples.join(', ')}`,
      params,
    );
    return rowCount ?? 0;
  }

  /**
   * @param {string} tenantId
   * @param {number} productId
   * @param {number} limit
   * @returns {Promise<object[]>}
   */
  async productHistory(tenantId, productId, limit) {
    const { rows } = await this.pool.query(
      `SELECT id, action, http_status, request, response, duration_ms, created_at
         FROM sync_log
        WHERE tenant_id = $1 AND product_id = $2
        ORDER BY created_at DESC
        LIMIT $3`,
      [tenantId, productId, limit],
    );
    return rows.map((r) => ({
      id: Number(r.id),
      action: r.action,
      httpStatus: r.http_status === null ? null : Number(r.http_status),
      request: r.request,
      response: r.response,
      durationMs: Number(r.duration_ms),
      createdAt: r.created_at,
    }));
  }

  /**
   * @param {object} run
   * @param {string} run.tenantId
   * @param {'incremental'|'full'} run.mode
   * @param {Date|null} run.since
   * @returns {Promise<number>} run id
   */
  async startReconcileRun(run) {
    const { rows } = await this.pool.query(
      `INSERT INTO reconcile_runs (tenant_id, mode, since) VALUES ($1, $2, $3) RETURNING id`,
      [run.tenantId, run.mode, run.since],
    );
    return Number(rows[0].id);
  }

  /**
   * @param {number} runId
   * @param {{ offersSeen: number, driftFound: number, invisibleFound: number }} result
   * @returns {Promise<void>}
   */
  async finishReconcileRun(runId, result) {
    await this.pool.query(
      `UPDATE reconcile_runs
          SET offers_seen = $2, drift_found = $3, invisible_found = $4, finished_at = now()
        WHERE id = $1`,
      [runId, result.offersSeen, result.driftFound, result.invisibleFound],
    );
  }

  /**
   * Where an incremental reconcile should resume from.
   *
   * The last *finished* run, not the last started one: resuming from a run that
   * crashed halfway would skip everything it never read.
   *
   * @param {string} tenantId
   * @returns {Promise<Date|null>}
   */
  async lastReconcileAt(tenantId) {
    const { rows } = await this.pool.query(
      `SELECT MAX(started_at) AS at FROM reconcile_runs
        WHERE tenant_id = $1 AND finished_at IS NOT NULL`,
      [tenantId],
    );
    return rows[0]?.at ?? null;
  }

  /**
   * sync_log is the biggest table in the database by an order of magnitude.
   * Without this the disk fills before the first client renews.
   *
   * @param {number} days
   * @returns {Promise<number>}
   */
  async prune(days) {
    const { rowCount } = await this.pool.query(
      `DELETE FROM sync_log WHERE created_at < now() - make_interval(days => $1)`,
      [Math.max(1, Math.trunc(days))],
    );
    return rowCount ?? 0;
  }
}
