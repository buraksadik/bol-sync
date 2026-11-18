/**
 * A runnable demo of the decision pipeline, with no Bol.com account needed.
 *
 * It writes a small supplier feed, applies the rules to it, and prints what the
 * service decided and why. Every number you see was produced by the same code
 * that runs in production — nothing here is hard coded for the demo.
 *
 *   npm run migrate
 *   npm run seed:demo
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../src/config.js';
import { createPool, closePool } from '../src/db/index.js';
import { JobsRepo } from '../src/db/repositories/jobs.repo.js';
import { ProductsRepo } from '../src/db/repositories/products.repo.js';
import { RulesRepo } from '../src/db/repositories/rules.repo.js';
import { encryptSecret } from '../src/core/secrets.js';
import { createCsvSource } from '../src/sources/csv.source.js';
import { pullSourceHandler } from '../src/queue/handlers/pullSource.handler.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const FEED_PATH = join(root, 'data', 'demo-feed.csv');

/** A supplier feed as they really arrive: Dutch headers, decimal commas. */
const FEED = `sku;ean;voorraad;prijs
BAM-001;8712345678901;50;12,95
BAM-002;8712345678902;3;1.249,00
BAM-003;8712345678903;0;24,50
BAM-004;8712345678904;120;8,95
BAM-005;8712345678905;2;34,95
BAM-006;8712345678906;7;"19,95"
`;

async function main() {
  const config = loadConfig();
  const pool = createPool(config.db);
  const repos = {
    jobs: new JobsRepo(pool),
    products: new ProductsRepo(pool),
    rules: new RulesRepo(pool, config.bol.credEncKey),
  };

  await mkdir(dirname(FEED_PATH), { recursive: true });
  await writeFile(FEED_PATH, FEED, 'utf8');

  await pool.query(`DELETE FROM tenants WHERE name = 'demo'`);
  const { rows } = await pool.query(
    `INSERT INTO tenants (name, bol_client_id, bol_client_secret_enc, managed_by_retailer)
     VALUES ('demo', 'demo-client-id', $1, false) RETURNING id`,
    [encryptSecret('demo-secret-never-used', config.bol.credEncKey)],
  );
  const tenantId = rows[0].id;

  // Two rules, so the demo shows which one wins.
  await pool.query(
    `INSERT INTO safety_stock_rules (tenant_id, scope, buffer_abs, min_publish)
     VALUES ($1, 'tenant', 2, 1)`,
    [tenantId],
  );
  await pool.query(
    `INSERT INTO safety_stock_rules (tenant_id, scope, sku, buffer_abs, min_publish)
     VALUES ($1, 'sku', 'BAM-004', 20, 1)`,
    [tenantId],
  );

  const source = createCsvSource({
    path: FEED_PATH,
    delimiter: ';',
    columnMap: { sku: 'sku', ean: 'ean', stock: 'voorraad', price: 'prijs' },
  });

  const ctx = {
    pool,
    config,
    log: null,
    repos,
    sourceFor: async () => source,
    clientFor: async () => {
      throw new Error('the demo never calls bol');
    },
  };

  await pullSourceHandler(
    {
      id: 0,
      tenantId,
      productId: null,
      type: 'pull_source',
      dedupeKey: null,
      payload: {},
      priority: 90,
      status: 'running',
      attempts: 1,
      maxAttempts: 3,
      runAfter: new Date(),
    },
    ctx,
  );

  const { rows: result } = await pool.query(
    `SELECT p.sku, s.stock AS source_stock, s.price AS source_price,
            o.desired_stock, o.desired_price, o.review_reason
       FROM products p
       JOIN source_state s ON s.product_id = p.id
       LEFT JOIN offer_state o ON o.product_id = p.id
      WHERE p.tenant_id = $1
      ORDER BY p.sku`,
    [tenantId],
  );

  console.log(`\ntenant ${tenantId}\nfeed   ${FEED_PATH}\n`);
  console.log('sku         in shop   on bol   held back      price   note');
  console.log('-'.repeat(76));
  for (const r of result) {
    const shop = Number(r.source_stock);
    const bol = Number(r.desired_stock);
    const held = bol > 0 ? shop - bol : shop;
    const note =
      bol === 0 && shop > 0
        ? 'under the minimum after the buffer'
        : (r.review_reason ?? (held > 2 ? 'own rule for this sku' : ''));
    console.log(
      `${r.sku.padEnd(10)} ${String(shop).padStart(8)} ${String(bol).padStart(8)} ` +
        `${String(held).padStart(11)} ${Number(r.desired_price).toFixed(2).padStart(10)}   ${note}`,
    );
  }

  const stats = await repos.jobs.stats(tenantId);
  console.log(`\nqueued: ${stats.pending} job(s) waiting for a bol offer id`);
  console.log('nothing was sent anywhere: this demo has no bol credentials.\n');

  await closePool();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
