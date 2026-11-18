/**
 * Shared API v10 — process status. Needed only by the v10 fallback.
 *
 * Spec: https://api.bol.com/registry/api-definitions/process-status/process-status-v10.yaml
 * Accept: application/vnd.retailer.v10+json
 *
 * Important: process status records are retained for a limited time only. After
 * that a single lookup returns 404 and a bulk lookup simply omits the id. Polling
 * must stop on 404 or the worker loops forever on a job that already finished.
 */

import { BolApiError } from '../core/errors.js';
import { sleep } from '../core/limiter.js';

/** @typedef {import('./client.js').BolClient} BolClient */
/** @typedef {import('./offers.v10.js').ProcessStatus} ProcessStatus */

/** Event types this service produces. */
export const EVENT_TYPES = /** @type {const} */ ([
  'CREATE_OFFER',
  'UPDATE_OFFER',
  'DELETE_OFFER',
  'UPDATE_OFFER_STOCK',
  'UPDATE_OFFER_PRICE',
  'CREATE_OFFER_EXPORT',
]);

/** The bulk endpoint takes at most 1000 ids per call. */
export const MAX_BULK_IDS = 1000;

/**
 * GET /shared/process-status/{id} — 100/s.
 *
 * @param {BolClient} client
 * @param {string} processStatusId
 * @returns {Promise<ProcessStatus|null>} null on 404 (expired, stop polling)
 */
export async function getStatus(client, processStatusId) {
  try {
    const { body } = await client.request({
      method: 'GET',
      path: `/shared/process-status/${encodeURIComponent(processStatusId)}`,
      version: 'v10',
    });
    return body;
  } catch (err) {
    // 404 is not a failure here. The record aged out, which means the work
    // itself finished long ago; treating it as an error would keep the job
    // alive forever waiting for an answer that no longer exists.
    if (err instanceof BolApiError && err.status === 404) return null;
    throw err;
  }
}

/**
 * POST /shared/process-status — up to 1000 ids per call, but only 2 calls/s.
 * Batch aggressively: 1000 ids in one call beats 1000 calls by a factor of 500.
 *
 * @param {BolClient} client
 * @param {string[]} processStatusIds  max 1000
 * @returns {Promise<ProcessStatus[]>}
 */
export async function getStatusBulk(client, processStatusIds) {
  if (processStatusIds.length === 0) return [];

  /** @type {ProcessStatus[]} */
  const out = [];
  for (let i = 0; i < processStatusIds.length; i += MAX_BULK_IDS) {
    const batch = processStatusIds.slice(i, i + MAX_BULK_IDS);
    const { body } = await client.request({
      method: 'POST',
      path: '/shared/process-status',
      version: 'v10',
      body: batch.map((id) => ({ processStatusId: id })),
    });
    // Ids whose record expired are simply missing from the answer. That is the
    // bulk equivalent of a 404 and the caller must not wait for them.
    out.push(...(body?.processStatuses ?? body ?? []));
  }
  return out;
}

/**
 * Poll until the status leaves PENDING.
 *
 * Returns null when the record is gone (404). The caller treats that the same
 * way it treats a timeout: stop waiting, and let the reconciler decide what
 * actually happened by reading the offer itself. Guessing SUCCESS here would
 * write a pushed_* value bol may never have received.
 *
 * @param {BolClient} client
 * @param {string} processStatusId
 * @param {{ intervalMs?: number, timeoutMs?: number, signal?: AbortSignal }} [o]
 * @returns {Promise<ProcessStatus|null>}
 */
export async function waitForCompletion(client, processStatusId, o = {}) {
  const intervalMs = o.intervalMs ?? 500;
  const deadline = Date.now() + (o.timeoutMs ?? 30000);

  for (;;) {
    const status = await getStatus(client, processStatusId);
    if (status === null) return null;
    if (status.status && status.status !== 'PENDING') return status;

    if (Date.now() + intervalMs > deadline) {
      throw new BolApiError({
        status: 504,
        method: 'GET',
        path: `/shared/process-status/${processStatusId}`,
        body: { detail: `still PENDING after ${o.timeoutMs ?? 30000}ms` },
      });
    }
    await sleep(intervalMs, o.signal);
  }
}

/**
 * @param {ProcessStatus|null} status
 * @returns {boolean}
 */
export function isSuccess(status) {
  return status?.status === 'SUCCESS';
}
