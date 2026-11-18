/**
 * Configuration. Read once at boot, validated once, never read from
 * process.env anywhere else.
 */

import 'dotenv/config';

/**
 * @typedef {object} Config
 * @property {string} nodeEnv
 * @property {string} logLevel
 * @property {number} httpPort
 * @property {{ databaseUrl: string, poolMax: number }} db
 * @property {{ tokenUrl: string, apiBase: string, version: 'v10'|'v11',
 *              tokenRefreshMarginSec: number, credEncKey: Buffer,
 *              timeoutMs: number, rateBudgetPct: number }} bol
 * @property {{ id: string, concurrency: number, claimBatch: number,
 *              pollIntervalMs: number, maxAttempts: number,
 *              backoffBaseMs: number, backoffMaxMs: number,
 *              stuckAfterMs: number }} worker
 * @property {import('./sync/safetyStock.js').SafetyRule & { staleAfterMin: number, bulkDropGuardPct: number }} safety
 * @property {import('./sync/pricing.js').PriceRule} price
 * @property {{ reconcileIntervalMin: number, reconcileFullAt: string, pullSourceIntervalMin: number }} schedule
 * @property {{ type: string, baseUrl: string, apiKey: string, apiSecret: string, csvPath: string, webhookSecret: string }} source
 */

/**
 * @param {string} name
 * @param {string} [fallback]
 * @returns {string}
 */
function required(name, fallback) {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === '') throw new Error(`missing env: ${name}`);
  return v;
}

/** @param {string} name @param {number} fallback @returns {number} */
function num(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const v = Number(raw);
  if (Number.isNaN(v)) throw new Error(`env ${name} is not a number: ${raw}`);
  return v;
}

/**
 * @param {string} name
 * @param {object} fallback
 * @returns {object}
 */
function parseJson(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`env ${name} is not valid JSON`);
  }
}

/**
 * @returns {Config}
 */
export function loadConfig() {
  const version = /** @type {'v10'|'v11'} */ (process.env.BOL_OFFERS_API_VERSION ?? 'v11');
  if (version !== 'v10' && version !== 'v11') {
    throw new Error(`BOL_OFFERS_API_VERSION must be v10 or v11, got: ${version}`);
  }

  const encKeyRaw = process.env.BOL_CRED_ENC_KEY ?? '';
  const credEncKey = Buffer.from(encKeyRaw, 'base64');
  if (credEncKey.length !== 32) {
    throw new Error('BOL_CRED_ENC_KEY must be 32 bytes, base64 encoded');
  }

  const budget = num('RATE_BUDGET_PCT', 60);
  if (budget < 1 || budget > 100) throw new Error('RATE_BUDGET_PCT must be 1-100');

  return {
    nodeEnv: process.env.NODE_ENV ?? 'development',
    logLevel: process.env.LOG_LEVEL ?? 'info',
    httpPort: num('HTTP_PORT', 3000),
    db: {
      databaseUrl: required('DATABASE_URL'),
      poolMax: num('DB_POOL_MAX', 10),
    },
    bol: {
      tokenUrl: process.env.BOL_TOKEN_URL ?? 'https://login.bol.com/token',
      apiBase: process.env.BOL_API_BASE ?? 'https://api.bol.com',
      version,
      tokenRefreshMarginSec: num('BOL_TOKEN_REFRESH_MARGIN_SEC', 59),
      credEncKey,
      timeoutMs: num('HTTP_TIMEOUT_MS', 15000),
      rateBudgetPct: budget,
    },
    worker: {
      id: process.env.WORKER_ID ?? 'worker-1',
      concurrency: num('WORKER_CONCURRENCY', 8),
      claimBatch: num('WORKER_CLAIM_BATCH', 25),
      pollIntervalMs: num('WORKER_POLL_INTERVAL_MS', 500),
      maxAttempts: num('JOB_MAX_ATTEMPTS', 6),
      backoffBaseMs: num('JOB_BACKOFF_BASE_MS', 1000),
      backoffMaxMs: num('JOB_BACKOFF_MAX_MS', 300000),
      stuckAfterMs: num('JOB_STUCK_AFTER_MS', 120000),
    },
    safety: {
      bufferAbs: num('SAFETY_BUFFER_ABS', 2),
      bufferPct: num('SAFETY_BUFFER_PCT', 0),
      minPublish: num('SAFETY_MIN_PUBLISH', 1),
      maxPublish: num('SAFETY_MAX_PUBLISH', 999),
      stockDeltaThreshold: num('STOCK_DELTA_THRESHOLD', 2),
      staleAfterMin: num('SOURCE_STALE_AFTER_MIN', 30),
      bulkDropGuardPct: num('BULK_DROP_GUARD_PCT', 20),
    },
    price: {
      markupPct: num('PRICE_MARKUP_PCT', 0),
      floorPrice: process.env.PRICE_FLOOR ? Number(process.env.PRICE_FLOOR) : null,
      ceilingPrice: process.env.PRICE_CEILING ? Number(process.env.PRICE_CEILING) : null,
      rounding: /** @type {'none'|'cent'|'psychological_99'} */ (
        process.env.PRICE_ROUNDING ?? 'cent'
      ),
      maxChangePct: num('PRICE_MAX_CHANGE_PCT', 25),
    },
    schedule: {
      reconcileIntervalMin: num('RECONCILE_INTERVAL_MIN', 15),
      reconcileFullAt: process.env.RECONCILE_FULL_AT ?? '03:30',
      pullSourceIntervalMin: num('PULL_SOURCE_INTERVAL_MIN', 10),
    },
    source: {
      type: process.env.SOURCE_TYPE ?? 'woocommerce',
      baseUrl: process.env.SOURCE_BASE_URL ?? '',
      apiKey: process.env.SOURCE_API_KEY ?? '',
      apiSecret: process.env.SOURCE_API_SECRET ?? '',
      csvPath: process.env.SOURCE_CSV_PATH ?? '',
      webhookSecret: process.env.SOURCE_WEBHOOK_SECRET ?? '',
      // Which feed column holds what. Dutch feeds name these in Dutch, and no
      // two suppliers agree, so it is configuration rather than a guess.
      columnMap: parseJson('SOURCE_COLUMN_MAP', {
        sku: 'sku',
        ean: 'ean',
        stock: 'voorraad',
        price: 'prijs',
      }),
    },
  };
}
