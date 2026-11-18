/**
 * Entry point. Boots the pool, the worker, the scheduler and the HTTP server,
 * then waits for a shutdown signal.
 */

import pino from 'pino';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.js';
import { createPool, closePool } from './db/index.js';
import { Worker } from './queue/worker.js';
import { Scheduler, buildSchedules } from './queue/scheduler.js';
import { startHttpServer } from './http/server.js';
import { pushOfferHandler } from './queue/handlers/pushOffer.handler.js';
import { pullSourceHandler } from './queue/handlers/pullSource.handler.js';
import { reconcileHandler, resolveOfferIdHandler } from './queue/handlers/reconcile.handler.js';
import { JobsRepo } from './db/repositories/jobs.repo.js';
import { ProductsRepo } from './db/repositories/products.repo.js';
import { RulesRepo } from './db/repositories/rules.repo.js';
import { LogsRepo } from './db/repositories/logs.repo.js';
import { TokenManager } from './bol/auth.js';
import { BolClient } from './bol/client.js';
import { limiterFor } from './core/limiter.js';
import { createSource } from './sources/source.interface.js';

/**
 * Everything a running service needs, wired together. Exported so a test or a
 * script can boot the same thing without going through main().
 *
 * @param {object} [o]
 * @param {import('./config.js').Config} [o.config]
 * @returns {Promise<{ ctx: any, worker: Worker, scheduler: Scheduler, server: any, stop: () => Promise<void> }>}
 */
export async function createService({ config = loadConfig() } = {}) {
  const log = pino({ level: config.logLevel });
  const pool = createPool(config.db);

  const repos = {
    jobs: new JobsRepo(pool),
    products: new ProductsRepo(pool),
    rules: new RulesRepo(pool, config.bol.credEncKey),
    logs: new LogsRepo(pool),
  };

  // One token manager for the whole process. Per-tenant caching lives inside
  // it, so eight worker lanes share one token per tenant instead of eight.
  const tokens = new TokenManager({
    tokenUrl: config.bol.tokenUrl,
    refreshMarginSec: config.bol.tokenRefreshMarginSec,
    credentialsLoader: (tenantId) => repos.rules.getCredentials(tenantId),
  });

  /** @type {Map<string, any>} */
  const sourceCache = new Map();

  /** @type {import('./queue/worker.js').WorkerContext} */
  const ctx = {
    pool,
    config,
    log,
    repos,

    // Builds a BolClient bound to one tenant: its credentials, its API version,
    // its own rate-limit buckets.
    clientFor: async (tenantId) => {
      const tenant = await repos.rules.getTenant(tenantId);
      return new BolClient({
        tenantId,
        baseUrl: config.bol.apiBase,
        version: tenant.offersApiVersion,
        tokens,
        // Buckets are per seller account because that is how bol counts them.
        limiter: limiterFor(tenantId, tenant.rateBudgetPct),
        timeoutMs: config.bol.timeoutMs,
        auditSink: (entry) => {
          // Fire and forget: an audit row must never delay or fail a sync.
          repos.logs.write(entry).catch((err) => log.warn({ err }, 'audit write failed'));
        },
      });
    },

    sourceFor: async (tenantId) => {
      let source = sourceCache.get(tenantId);
      if (!source) {
        source = createSource(config.source.type, {
          baseUrl: config.source.baseUrl,
          consumerKey: config.source.apiKey,
          consumerSecret: config.source.apiSecret,
          webhookSecret: config.source.webhookSecret,
          path: config.source.csvPath,
          columnMap: config.source.columnMap,
        });
        sourceCache.set(tenantId, source);
      }
      return source;
    },

    listActiveTenants: () => repos.rules.activeTenants(),
  };

  const worker = new Worker({
    ctx,
    handlers: {
      push_offer: pushOfferHandler,
      pull_source: pullSourceHandler,
      reconcile: reconcileHandler,
      resolve_offer_id: resolveOfferIdHandler,
    },
  });

  const scheduler = new Scheduler({ ctx, schedules: buildSchedules(config) });
  const server = await startHttpServer({ ctx });

  return {
    ctx,
    worker,
    scheduler,
    server,
    async stop() {
      scheduler.stop();
      await worker.stop();
      await server.close();
      await closePool();
    },
  };
}

/**
 * @returns {Promise<void>}
 */
async function main() {
  const config = loadConfig();
  const service = await createService({ config });
  const { ctx, worker, scheduler } = service;

  // Anything a previous process left locked goes back on the queue before the
  // first claim, so a crash costs seconds rather than a stuck product.
  await worker.releaseStuck();

  scheduler.start();
  worker.start().catch((err) => {
    ctx.log.fatal({ err }, 'worker crashed');
    process.exit(1);
  });

  ctx.log.info(
    { version: config.bol.version, worker: config.worker.id, port: service.server.port },
    'bol-sync started',
  );

  let shuttingDown = false;
  /** @param {string} signal */
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    ctx.log.info({ signal }, 'shutting down');
    // In-flight jobs finish first. Killing a push mid-flight leaves bol holding
    // a value we never recorded, which is exactly what the reconciler then has
    // to clean up.
    await service.stop();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

// Only run when started directly, so importing createService in a test does not
// boot a server and park on a signal handler. pathToFileURL, not string
// concatenation: a Windows path turns into file:///C:/... with three slashes.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
