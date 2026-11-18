/**
 * Retailer API v10 — fallback adapter.
 *
 * Only used when the seller account is not on v11 (BOL_OFFERS_API_VERSION=v10).
 *
 * Everything here is asynchronous: PUT returns 202 with a processStatusId and
 * the work is not done yet. Stock and price are separate endpoints, so one
 * logical change costs two writes plus polling.
 *
 * Accept / Content-Type: application/vnd.retailer.v10+json
 */

import { BolApiError } from '../core/errors.js';
import { splitCsvLine } from '../sources/csv.source.js';

/** @typedef {import('./client.js').BolClient} BolClient */
/** @typedef {{ processStatusId: string, entityId: string, eventType: string, status: 'PENDING'|'SUCCESS'|'FAILURE'|'TIMEOUT', errorMessage: string|null }} ProcessStatus */

/**
 * PUT /retailer/offers/{offer-id}/stock
 * Body: { amount: 0..999, managedByRetailer: boolean }
 *
 * @param {BolClient} client
 * @param {string} offerId
 * @param {{ amount: number, managedByRetailer: boolean }} stock
 * @returns {Promise<ProcessStatus>} 202
 */
export async function updateStock(client, offerId, stock) {
  const { body } = await client.request({
    method: 'PUT',
    path: `/retailer/offers/${encodeURIComponent(offerId)}/stock`,
    version: 'v10',
    body: stock,
  });
  return assertProcessStatus(body, 'PUT /stock');
}

/**
 * PUT /retailer/offers/{offer-id}/price
 * Body: { pricing: { bundlePrices: [{ quantity, unitPrice }] } }
 *
 * @param {BolClient} client
 * @param {string} offerId
 * @param {{ bundlePrices: Array<{ quantity: number, unitPrice: number }> }} pricing
 * @returns {Promise<ProcessStatus>} 202
 */
export async function updatePrice(client, offerId, pricing) {
  const { body } = await client.request({
    method: 'PUT',
    path: `/retailer/offers/${encodeURIComponent(offerId)}/price`,
    version: 'v10',
    body: { pricing },
  });
  return assertProcessStatus(body, 'PUT /price');
}

/**
 * A 202 without a processStatusId leaves us unable to find out whether the
 * write landed. Fail loudly instead of assuming it did.
 *
 * @param {any} body
 * @param {string} what
 * @returns {ProcessStatus}
 */
function assertProcessStatus(body, what) {
  if (!body?.processStatusId) {
    throw new BolApiError({
      status: 202,
      method: 'PUT',
      path: what,
      body: { detail: 'accepted without a processStatusId' },
    });
  }
  return body;
}

/**
 * @param {BolClient} client
 * @param {string} offerId
 * @returns {Promise<object>}
 */
export async function getOffer(client, offerId) {
  const { body } = await client.request({
    method: 'GET',
    path: `/retailer/offers/${encodeURIComponent(offerId)}`,
    version: 'v10',
  });
  return body;
}

/**
 * Request the full offer export as CSV.
 *
 * Rate limit: 9 per hour, for both the request and the download. Use this for
 * the first import only; for routine reconciliation use the v11 list endpoint.
 *
 * @param {BolClient} client
 * @returns {Promise<ProcessStatus>}
 */
export async function requestOfferExport(client) {
  const { body } = await client.request({
    method: 'POST',
    path: '/retailer/offers/export',
    version: 'v10',
    body: { format: 'CSV' },
  });
  return assertProcessStatus(body, 'POST /offers/export');
}

/**
 * @param {BolClient} client
 * @param {string} reportId  entityId from the finished CREATE_OFFER_EXPORT status
 * @returns {Promise<string>} raw CSV
 */
export async function downloadOfferExport(client, reportId) {
  const { body } = await client.request({
    method: 'GET',
    path: `/retailer/offers/export/${encodeURIComponent(reportId)}`,
    version: 'v10',
  });
  // The client parses JSON when it can; a CSV body comes back as { raw }.
  return typeof body === 'string' ? body : (body?.raw ?? '');
}

/**
 * Pull (ean, offerId) pairs out of the export CSV.
 *
 * The column names are read from the header rather than assumed by position.
 * bol has changed this export before, and a silently shifted column would
 * attach every offer id to the wrong product — which is far worse than a
 * loud failure on the first import.
 *
 * @param {string} csv
 * @returns {Map<string, string>} ean -> offerId
 */
export function parseOfferExport(csv) {
  const lines = csv.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n').filter(Boolean);
  if (lines.length < 2) return new Map();

  const delimiter = lines[0].includes(';') ? ';' : ',';
  const header = splitCsvLine(lines[0], delimiter).map((h) => h.toLowerCase().replace(/\s/g, ''));

  const offerIdx = header.findIndex((h) => h === 'offerid' || h === 'offer_id');
  const eanIdx = header.findIndex((h) => h === 'ean');
  if (offerIdx === -1 || eanIdx === -1) {
    throw new BolApiError({
      status: 200,
      method: 'GET',
      path: '/retailer/offers/export',
      body: { detail: `export header has no offerId/ean column: ${header.join(delimiter)}` },
    });
  }

  /** @type {Map<string, string>} */
  const out = new Map();
  for (let i = 1; i < lines.length; i += 1) {
    const cells = splitCsvLine(lines[i], delimiter);
    const ean = cells[eanIdx]?.trim();
    const offerId = cells[offerIdx]?.trim();
    if (ean && offerId && !out.has(ean)) out.set(ean, offerId);
  }
  return out;
}
