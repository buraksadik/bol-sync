/**
 * sync_jobs + dead_letters
 */

/**
 * @typedef {object} Job
 * @property {number} id
 * @property {string} tenantId
 * @property {number|null} productId
 * @property {string} type
 * @property {string|null} dedupeKey
 * @property {object} payload
 * @property {number} priority
 * @property {string} status
 * @property {number} attempts
 * @property {number} maxAttempts
 * @property {Date} runAfter
 */

/** Columns every query returns, so one mapper covers them all. */
const JOB_COLUMNS = `id, tenant_id, product_id, type, dedupe_key, payload,
                     priority, status, attempts, max_attempts, run_after`;

/**
 * @param {Record<string, any>} row
 * @returns {Job}
 */
function toJob(row) {
  return {
    id: Number(row.id),
    tenantId: row.tenant_id,
    productId: row.product_id === null ? null : Number(row.product_id),
    type: row.type,
    dedupeKey: row.dedupe_key,
    payload: row.payload ?? {},
    priority: Number(row.priority),
    status: row.status,
    attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
    runAfter: row.run_after,
  };
}

export class JobsRepo {
  /** @param {import('pg').Pool} pool */
  constructor(pool) {
    this.pool = pool;
  }

  /**
   * Insert, or update the open job that already carries this dedupe key.
   * The newest enqueue wins: it lowers run_after and takes the stronger
   * priority, so a stock drop can overtake a pending price change.
   *
   * A job with a null dedupe key always inserts. Null never collides in a
   * unique index, which is exactly what one-off jobs want.
   *
   * @param {Omit<Job, 'id'|'status'|'attempts'>} job
   * @returns {Promise<number>} job id
   */
  async enqueue(job) {
    const { rows } = await this.pool.query(
      `INSERT INTO sync_jobs
         (tenant_id, product_id, type, dedupe_key, payload, priority, max_attempts, run_after)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, COALESCE($8, now()))
       ON CONFLICT (dedupe_key) WHERE status IN ('pending', 'running')
       DO UPDATE SET payload    = EXCLUDED.payload,
                     priority   = LEAST(sync_jobs.priority, EXCLUDED.priority),
                     run_after  = LEAST(sync_jobs.run_after, EXCLUDED.run_after),
                     updated_at = now()
       RETURNING id`,
      [
        job.tenantId,
        job.productId ?? null,
        job.type,
        job.dedupeKey ?? null,
        JSON.stringify(job.payload ?? {}),
        job.priority ?? 100,
        job.maxAttempts ?? 6,
        job.runAfter ?? null,
      ],
    );
    return Number(rows[0].id);
  }

  /**
   * One statement for the whole batch. A planning run over 5,000 products that
   * enqueues row by row spends more time in round trips than in Postgres.
   *
   * @param {Array<Omit<Job, 'id'|'status'|'attempts'>>} jobs
   * @returns {Promise<number>} rows written
   */
  async enqueueMany(jobs) {
    if (jobs.length === 0) return 0;

    const values = [];
    const params = [];
    jobs.forEach((job, i) => {
      const b = i * 8;
      values.push(
        `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}::jsonb, $${b + 6}, $${b + 7}, COALESCE($${b + 8}, now()))`,
      );
      params.push(
        job.tenantId,
        job.productId ?? null,
        job.type,
        job.dedupeKey ?? null,
        JSON.stringify(job.payload ?? {}),
        job.priority ?? 100,
        job.maxAttempts ?? 6,
        job.runAfter ?? null,
      );
    });

    const { rowCount } = await this.pool.query(
      `INSERT INTO sync_jobs
         (tenant_id, product_id, type, dedupe_key, payload, priority, max_attempts, run_after)
       VALUES ${values.join(', ')}
       ON CONFLICT (dedupe_key) WHERE status IN ('pending', 'running')
       DO UPDATE SET payload    = EXCLUDED.payload,
                     priority   = LEAST(sync_jobs.priority, EXCLUDED.priority),
                     run_after  = LEAST(sync_jobs.run_after, EXCLUDED.run_after),
                     updated_at = now()`,
      params,
    );
    return rowCount ?? 0;
  }

  /**
   * FOR UPDATE SKIP LOCKED claim. Several workers can poll the same table
   * without a lock server: each skips the rows another one already holds.
   *
   * `attempts` increments here, not on failure. A worker that is killed mid-job
   * still burns an attempt, so a job that crashes the process cannot loop
   * forever — it reaches max_attempts and lands in dead_letters.
   *
   * The ORDER BY appears twice on purpose. The inner one decides *which* rows
   * are claimed; it does not decide the order `RETURNING` hands them back —
   * that order is undefined, and in practice comes out as insertion order. A
   * real database caught this: a priority-10 "stop overselling" job was being
   * returned behind a priority-80 one. The outer SELECT fixes the order the
   * worker actually runs them in.
   *
   * @param {string} workerId
   * @param {number} limit
   * @returns {Promise<Job[]>}
   */
  async claim(workerId, limit) {
    const { rows } = await this.pool.query(
      `WITH claimed AS (
         UPDATE sync_jobs
            SET status     = 'running',
                locked_by  = $1,
                locked_at  = now(),
                attempts   = attempts + 1,
                updated_at = now()
          WHERE id IN (
            SELECT id FROM sync_jobs
             WHERE status = 'pending' AND run_after <= now()
             ORDER BY priority ASC, run_after ASC
             FOR UPDATE SKIP LOCKED
             LIMIT $2
          )
          RETURNING ${JOB_COLUMNS}
       )
       SELECT * FROM claimed ORDER BY priority ASC, run_after ASC, id ASC`,
      [workerId, limit],
    );
    return rows.map(toJob);
  }

  /**
   * Finish a job — unless it changed while it was running.
   *
   * That case is real and it matters: a webhook can re-enqueue the same product
   * while the push is in flight. `updated_at > locked_at` means the payload we
   * just sent is already out of date, so the job goes back to pending instead of
   * done. Marking it done there would silently drop a stock change, which is
   * exactly how overselling starts.
   *
   * @param {number} jobId
   * @returns {Promise<'done'|'pending'>}
   */
  async markDone(jobId) {
    const { rows } = await this.pool.query(
      `UPDATE sync_jobs
          SET status     = CASE WHEN updated_at > locked_at THEN 'pending' ELSE 'done' END,
              run_after  = CASE WHEN updated_at > locked_at THEN now() ELSE run_after END,
              locked_by  = NULL,
              locked_at  = NULL,
              last_error = NULL,
              updated_at = now()
        WHERE id = $1
        RETURNING status`,
      [jobId],
    );
    return rows[0]?.status ?? 'done';
  }

  /**
   * @param {number} jobId
   * @param {string} error
   * @param {number} delayMs
   * @returns {Promise<void>}
   */
  async requeue(jobId, error, delayMs) {
    await this.pool.query(
      `UPDATE sync_jobs
          SET status     = 'pending',
              run_after  = now() + make_interval(secs => $3 / 1000.0),
              last_error = $2,
              locked_by  = NULL,
              locked_at  = NULL,
              updated_at = now()
        WHERE id = $1`,
      [jobId, String(error).slice(0, 2000), Math.max(0, delayMs)],
    );
  }

  /**
   * status = 'dead' plus a dead_letters row. Nothing is ever dropped silently.
   *
   * Both writes go in one transaction. A dead job with no dead letter is an
   * invisible failure, which is worse than a loud one.
   *
   * @param {Job} job
   * @param {string} reason
   * @param {object} detail
   * @returns {Promise<void>}
   */
  async kill(job, reason, detail) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE sync_jobs
            SET status = 'dead', locked_by = NULL, locked_at = NULL,
                last_error = $2, updated_at = now()
          WHERE id = $1`,
        [job.id, String(reason).slice(0, 2000)],
      );
      await client.query(
        `INSERT INTO dead_letters (tenant_id, product_id, job_id, reason, detail)
         VALUES ($1, $2, $3, $4, $5::jsonb)`,
        [job.tenantId, job.productId, job.id, reason, JSON.stringify(detail ?? {})],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * A worker that was killed leaves its jobs in 'running' forever. Put them back.
   *
   * @param {number} stuckAfterMs
   * @returns {Promise<number>}
   */
  async releaseStuck(stuckAfterMs) {
    const { rowCount } = await this.pool.query(
      `UPDATE sync_jobs
          SET status     = 'pending',
              locked_by  = NULL,
              locked_at  = NULL,
              last_error = 'RELEASED_STUCK',
              updated_at = now()
        WHERE status = 'running'
          AND locked_at < now() - make_interval(secs => $1 / 1000.0)`,
      [Math.max(0, stuckAfterMs)],
    );
    return rowCount ?? 0;
  }

  /**
   * `oldestPendingSec` is the number that actually tells you the queue is sick.
   * A large pending count with a small age is a busy queue; a small count with a
   * large age is a stuck one.
   *
   * @param {string} tenantId
   * @returns {Promise<{ pending: number, running: number, dead: number, oldestPendingSec: number }>}
   */
  async stats(tenantId) {
    const { rows } = await this.pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'pending')  AS pending,
         COUNT(*) FILTER (WHERE status = 'running')  AS running,
         COUNT(*) FILTER (WHERE status = 'dead')     AS dead,
         COALESCE(
           EXTRACT(EPOCH FROM (now() - MIN(run_after) FILTER (WHERE status = 'pending'))),
           0
         ) AS oldest_pending_sec
       FROM sync_jobs
       WHERE tenant_id = $1`,
      [tenantId],
    );
    const r = rows[0];
    return {
      pending: Number(r.pending),
      running: Number(r.running),
      dead: Number(r.dead),
      oldestPendingSec: Math.max(0, Math.round(Number(r.oldest_pending_sec))),
    };
  }

  /**
   * @param {string} tenantId
   * @param {number} limit
   * @returns {Promise<object[]>}
   */
  async openDeadLetters(tenantId, limit) {
    const { rows } = await this.pool.query(
      `SELECT d.id, d.product_id, d.job_id, d.reason, d.detail, d.created_at, p.sku
         FROM dead_letters d
         LEFT JOIN products p ON p.id = d.product_id
        WHERE d.tenant_id = $1 AND d.resolved_at IS NULL
        ORDER BY d.created_at DESC
        LIMIT $2`,
      [tenantId, limit],
    );
    return rows.map((r) => ({
      id: Number(r.id),
      productId: r.product_id === null ? null : Number(r.product_id),
      jobId: r.job_id === null ? null : Number(r.job_id),
      sku: r.sku ?? null,
      reason: r.reason,
      detail: r.detail,
      createdAt: r.created_at,
    }));
  }

  /**
   * @param {number} deadLetterId
   * @returns {Promise<void>}
   */
  async resolveDeadLetter(deadLetterId) {
    await this.pool.query(
      `UPDATE dead_letters SET resolved_at = now() WHERE id = $1 AND resolved_at IS NULL`,
      [deadLetterId],
    );
  }
}

export { toJob };
