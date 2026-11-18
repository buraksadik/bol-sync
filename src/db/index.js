/**
 * PostgreSQL pool and a small transaction helper.
 */

import pg from 'pg';

/**
 * numeric columns come back as strings by default, which silently turns
 * price arithmetic into string concatenation. Parse them once, here.
 */
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));

/** @type {pg.Pool|null} */
let pool = null;

/**
 * @param {{ databaseUrl: string, poolMax: number }} config
 * @returns {pg.Pool}
 */
export function createPool({ databaseUrl, poolMax }) {
  if (!pool) {
    pool = new pg.Pool({ connectionString: databaseUrl, max: poolMax });
  }
  return pool;
}

/** @returns {pg.Pool} */
export function getPool() {
  if (!pool) throw new Error('pool not created');
  return pool;
}

/**
 * @template T
 * @param {(client: pg.PoolClient) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withTransaction(fn) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** @returns {Promise<void>} */
export async function closePool() {
  await pool?.end();
  pool = null;
}
