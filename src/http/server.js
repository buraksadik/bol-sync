/**
 * Small HTTP surface. Node's built-in server; no framework needed for five routes.
 *
 *   GET  /health                   liveness
 *   GET  /health/queue             pending, running, dead, oldest pending age
 *   GET  /health/dead-letters      unresolved permanent failures
 *   GET  /health/drift             offers where bol disagrees with us
 *   POST /webhook/source/:tenant   source shop pushes a change
 *
 * The webhook verifies its signature before anything else. An unauthenticated
 * webhook can set a whole catalogue to zero, which makes it the most dangerous
 * route in the service.
 */

import { createServer } from 'node:http';
import { dedupeKey, PRIORITY } from '../sync/differ.js';
import { SourceError } from '../core/errors.js';

/** @typedef {import('../queue/worker.js').WorkerContext} WorkerContext */

/** A shop sending megabytes at this endpoint is not sending a product update. */
const MAX_BODY_BYTES = 1_000_000;

/**
 * @param {{ ctx: WorkerContext }} o
 * @returns {Promise<{ close: () => Promise<void>, port: number }>}
 */
export async function startHttpServer({ ctx }) {
  const server = createServer((req, res) => {
    handle(req, res, ctx).catch((err) => {
      ctx.log?.error({ err, url: req.url }, 'http handler failed');
      send(res, 500, { error: 'internal' });
    });
  });

  await new Promise((resolve) => server.listen(ctx.config.httpPort, resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : ctx.config.httpPort;
  ctx.log?.info({ port }, 'http listening');

  return {
    port,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve(undefined));
      }),
  };
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {WorkerContext} ctx
 * @returns {Promise<void>}
 */
async function handle(req, res, ctx) {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;

  if (req.method === 'GET' && path === '/health') {
    return send(res, 200, { ok: true, worker: ctx.config.worker.id });
  }

  if (req.method === 'GET' && path.startsWith('/health/')) {
    const tenantId = url.searchParams.get('tenant');
    if (!tenantId) return send(res, 400, { error: 'tenant query parameter required' });

    if (path === '/health/queue') {
      const stats = await ctx.repos.jobs.stats(tenantId);
      // oldestPendingSec is the number that says the queue is sick. A large
      // backlog moving fast is a busy queue; a small one standing still is a
      // stuck one, and only the age tells them apart.
      return send(res, 200, stats);
    }
    if (path === '/health/dead-letters') {
      return send(res, 200, { items: await ctx.repos.jobs.openDeadLetters(tenantId, 100) });
    }
    if (path === '/health/drift') {
      const [drift, invisible] = await Promise.all([
        ctx.repos.products.findDrifted(tenantId),
        ctx.repos.products.findInvisibleOffers(tenantId),
      ]);
      return send(res, 200, {
        drift: drift.map(summarise),
        invisible: invisible.map(summarise),
      });
    }
    return send(res, 404, { error: 'not found' });
  }

  const webhook = path.match(/^\/webhook\/source\/([0-9a-fA-F-]{36})$/);
  if (req.method === 'POST' && webhook) {
    try {
      const rawBody = await readBody(req);
      const result = await handleSourceWebhook({
        tenantId: webhook[1],
        rawBody,
        signature:
          header(req, 'x-wc-webhook-signature') ?? header(req, 'x-source-signature'),
        ctx,
      });
      return send(res, 202, result);
    } catch (err) {
      if (err instanceof SourceError) {
        ctx.log?.warn({ err: err.message, tenant: webhook[1] }, 'webhook rejected');
        return send(res, 401, { error: 'signature' });
      }
      throw err;
    }
  }

  return send(res, 404, { error: 'not found' });
}

/**
 * Verify, parse, enqueue. The handler itself does no bol calls — it only puts a
 * pull_source job on the queue for the named SKUs, so a webhook storm turns into
 * one deduplicated job per product.
 *
 * @param {object} o
 * @param {string} o.tenantId
 * @param {Buffer} o.rawBody
 * @param {string|null} o.signature
 * @param {WorkerContext} o.ctx
 * @returns {Promise<{ accepted: number }>}
 */
export async function handleSourceWebhook({ tenantId, rawBody, signature, ctx }) {
  const source = await ctx.sourceFor(tenantId);
  // Signature first, before the body is parsed or trusted for anything.
  const items = source.parseWebhook(rawBody, signature);

  const skus = [...new Set(items.map((i) => i.sku).filter(Boolean))];
  if (skus.length === 0) return { accepted: 0 };

  // One job per tenant, carrying the SKUs. Fifty webhooks in a minute collapse
  // onto one pending row through the dedupe index instead of fifty reads.
  await ctx.repos.jobs.enqueue({
    tenantId,
    productId: null,
    type: 'pull_source',
    dedupeKey: dedupeKey(tenantId, 0, 'pull_source_webhook'),
    payload: { skus, trigger: 'webhook' },
    priority: PRIORITY.STOCK_DECREASE,
    maxAttempts: 3,
    runAfter: new Date(),
  });

  return { accepted: skus.length };
}

/** @param {import('../db/repositories/products.repo.js').SyncRow} row */
function summarise(row) {
  return {
    sku: row.sku,
    offerId: row.offerId,
    pushedStock: row.pushedStock,
    bolStock: row.bolStock,
    bolCorrectedStock: row.bolCorrectedStock,
    pushedPrice: row.pushedPrice,
    bolPrice: row.bolPrice,
  };
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {string} name
 * @returns {string|null}
 */
function header(req, name) {
  const v = req.headers[name];
  return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<Buffer>}
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    /** @type {Buffer[]} */
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new SourceError('WEBHOOK_BODY_TOO_LARGE'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {object} body
 * @returns {void}
 */
function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}
