/**
 * An isolated Postgres schema per test file.
 *
 * `node --test` runs test files in parallel, and the integration files all
 * point at one database. That is not a theoretical problem: `JobsRepo.claim()`
 * is deliberately tenant-agnostic, because a worker serves every tenant. So a
 * claim in one file happily picks up jobs another file just enqueued, and the
 * failures look like flaky SQL rather than what they are.
 *
 * Deleting rows between tests does not fix it — the files interleave. Giving
 * each file its own schema does, and it keeps the tests parallel.
 *
 * This lives outside test/ on purpose: `npm test` scans test/, and a helper in
 * there would be run as a test file with no tests in it.
 */

import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';

/**
 * @param {string} label  short name, shows up in the schema name when debugging
 * @returns {Promise<{ pool: import('pg').Pool, schema: string, drop: () => Promise<void> }>}
 */
export async function createTestSchema(label) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');

  const pg = (await import('pg')).default;
  pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));

  const schema = `t_${label.replace(/\W/g, '')}_${randomBytes(4).toString('hex')}`;

  // One admin connection to create the schema, before any pooled client binds
  // its search_path to something that does not exist yet.
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.end();

  const pool = new pg.Pool({ connectionString: url, max: 4 });
  // Every connection in the pool, not just the first one.
  pool.on('connect', (client) => {
    client.query(`SET search_path TO ${schema}, public`);
  });

  const ddl = await readFile(new URL('../src/db/schema.sql', import.meta.url), 'utf8');
  await pool.query(ddl);

  return {
    pool,
    schema,
    async drop() {
      await pool.end();
      const cleanup = new pg.Client({ connectionString: url });
      await cleanup.connect();
      await cleanup.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await cleanup.end();
    },
  };
}
