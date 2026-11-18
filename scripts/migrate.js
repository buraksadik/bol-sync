/**
 * Applies src/db/schema.sql. The schema is idempotent (IF NOT EXISTS), so this
 * is safe to run on every deploy.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { createPool, closePool } from '../src/db/index.js';

const here = dirname(fileURLToPath(import.meta.url));

async function main() {
  const config = loadConfig();
  const pool = createPool(config.db);
  const sql = await readFile(join(here, '..', 'src', 'db', 'schema.sql'), 'utf8');

  await pool.query(sql);
  console.log('schema applied');
  await closePool();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
