/**
 * Offers API v11 — the preferred adapter.
 *
 * Synchronous: POST returns 201 with the offerId, PATCH returns 204. No process
 * status polling. Accept / Content-Type: application/vnd.retailer.v11+json
 *
 * Spec: https://api.bol.com/registry/api-definitions/offers/offers-v11.yaml
 */

import { BolApiError } from '../core/errors.js';

/** @typedef {import('./client.js').BolClient} BolClient */

/** `page-size` is capped at 100 by the spec. */
export const MAX_PAGE_SIZE = 100;
/** The `eans` filter is a query parameter; keep the URL short enough to survive proxies. */
export const MAX_EANS_PER_CALL = 50;

/**
 * @typedef {object} OfferSummary
 * @property {string} offerId              uuid
 * @property {string} [ean]
 * @property {string} lastModifiedDateTime
 * @property {string} [reference]
 * @property {boolean} onHoldByRetailer
 * @property {{ amount?: number, correctedStock?: number, managedByRetailer?: boolean }} [stock]
 * @property {{ bundlePrices: Array<{ quantity: number, unitPrice: number }> }} pricing
 * @property {{ method: 'FBR'|'FBB' }} fulfilment
 * @property {Array<{ countryCode: 'NL'|'BE', forSale?: boolean }>} [countryAvailabilities]
 */

/**
 * List offers, one page.
 *
 * Filters: offer-ids, eans, reference, for-sale, last-modified-date-time
 * (ISO 8601, UTC), page-size (1-100), cursor.
 * Rate limit for the list endpoint is 25/s, stricter than the item endpoints.
 *
 * @param {BolClient} client
 * @param {object} [q]
 * @param {string[]} [q.eans]
 * @param {string[]} [q.offerIds]
 * @param {string} [q.reference]
 * @param {boolean} [q.forSale]
 * @param {string} [q.lastModifiedDateTime]
 * @param {number} [q.pageSize]
 * @param {string} [q.cursor]
 * @returns {Promise<{ offers: OfferSummary[], page: { pageSize: number|null, nextCursor: string|null } }>}
 */
export async function listOffers(client, q = {}) {
  const { body } = await client.get('/retailer/offers', {
    'offer-ids': q.offerIds,
    eans: q.eans,
    reference: q.reference,
    'for-sale': q.forSale,
    'last-modified-date-time': q.lastModifiedDateTime,
    'page-size': q.pageSize ? Math.min(q.pageSize, MAX_PAGE_SIZE) : undefined,
    cursor: q.cursor,
  });

  return {
    offers: body?.offers ?? [],
    page: {
      pageSize: body?.page?.pageSize ?? null,
      nextCursor: body?.page?.nextCursor ?? null,
    },
  };
}

/**
 * Walk every page. Stops when page.nextCursor is null.
 *
 * Two stops that are not in the spec but are in the real world: a cursor that
 * repeats, and a page count that runs away. Both mean the same thing — the
 * walk is not advancing — and without them a reconcile can spin for hours
 * burning the 25/s read budget.
 *
 * @param {BolClient} client
 * @param {Parameters<typeof listOffers>[1]} [q]
 * @returns {AsyncGenerator<OfferSummary, void, void>}
 */
export async function* iterateOffers(client, q = {}) {
  const seen = new Set();
  let cursor = q.cursor;
  let pages = 0;

  for (;;) {
    const { offers, page } = await listOffers(client, {
      ...q,
      cursor,
      pageSize: q.pageSize ?? MAX_PAGE_SIZE,
    });

    for (const offer of offers) yield offer;

    pages += 1;
    if (!page.nextCursor) return;
    if (seen.has(page.nextCursor)) {
      throw new BolApiError({
        status: 500,
        method: 'GET',
        path: '/retailer/offers',
        body: { detail: `cursor repeated after ${pages} pages` },
      });
    }
    if (pages > 10000) {
      throw new BolApiError({
        status: 500,
        method: 'GET',
        path: '/retailer/offers',
        body: { detail: 'offer list did not terminate' },
      });
    }
    seen.add(page.nextCursor);
    cursor = page.nextCursor;
  }
}

/**
 * @param {BolClient} client
 * @param {string} offerId
 * @returns {Promise<OfferSummary>}
 */
export async function getOffer(client, offerId) {
  const { body } = await client.get(`/retailer/offers/${encodeURIComponent(offerId)}`);
  return body;
}

/**
 * Create an offer. Returns 201 with the new offerId.
 * Required: ean, condition, pricing, fulfilment.
 *
 * @param {BolClient} client
 * @param {object} payload
 * @returns {Promise<{ offerId: string }>}
 */
export async function createOffer(client, payload) {
  const { body } = await client.post('/retailer/offers', payload);
  if (!body?.offerId) {
    throw new BolApiError({
      status: 201,
      method: 'POST',
      path: '/retailer/offers',
      body: { detail: 'create returned no offerId' },
    });
  }
  return { offerId: body.offerId };
}

/**
 * Partial update. Stock and price travel in the same request — this is the whole
 * reason to prefer v11 over v10.
 *
 * Send only the sections that changed; a PATCH that carries an unchanged block
 * still counts against the rate limit and still produces a lastModified bump,
 * which makes the reconciler's job harder.
 *
 * @param {BolClient} client
 * @param {string} offerId
 * @param {object} patch
 * @param {{ bundlePrices: Array<{ quantity: number, unitPrice: number }> }} [patch.pricing]
 * @param {{ amount?: number, managedByRetailer?: boolean }} [patch.stock]
 * @param {boolean} [patch.onHoldByRetailer]
 * @param {string} [patch.reference]
 * @returns {Promise<void>} resolves on 204
 */
export async function patchOffer(client, offerId, patch) {
  const keys = Object.keys(patch ?? {});
  if (keys.length === 0) {
    // Cheaper to refuse here than to spend a write token saying nothing.
    throw new BolApiError({
      status: 400,
      method: 'PATCH',
      path: `/retailer/offers/${offerId}`,
      body: { detail: 'empty patch' },
    });
  }
  await client.patch(`/retailer/offers/${encodeURIComponent(offerId)}`, patch);
}

/**
 * @param {BolClient} client
 * @param {string} offerId
 * @returns {Promise<void>}
 */
export async function deleteOffer(client, offerId) {
  await client.delete(`/retailer/offers/${encodeURIComponent(offerId)}`);
}

/**
 * Why an offer is not for sale. The reason list includes missing mandatory
 * content attributes, which is the single most common cause of an offer that
 * looks fine in our database but sells nothing.
 *
 * @param {BolClient} client
 * @param {string} offerId
 * @returns {Promise<{ offerId: string, countries: Array<{ countryCode: string, reasons: object[] }> }>}
 */
export async function getNotForSaleReasons(client, offerId) {
  const { body } = await client.get(
    `/retailer/offers/${encodeURIComponent(offerId)}/not-for-sale-reasons`,
  );
  return {
    offerId,
    countries: body?.notForSaleReasons ?? body?.countries ?? [],
  };
}

/**
 * Resolve offerId from EAN when products.offer_id is empty.
 *
 * An EAN with several offers (different condition, or FBR next to FBB) is a
 * real case and picking blind would attach the wrong one. The newest offer
 * wins, because that is the one the seller most recently worked on.
 *
 * @param {BolClient} client
 * @param {string[]} eans  batch them; the filter takes a list
 * @returns {Promise<Map<string, string>>} ean -> offerId
 */
export async function resolveOfferIdsByEan(client, eans) {
  /** @type {Map<string, string>} */
  const found = new Map();
  /** @type {Map<string, string>} ean -> lastModified of the chosen offer */
  const chosenAt = new Map();

  for (let i = 0; i < eans.length; i += MAX_EANS_PER_CALL) {
    const batch = eans.slice(i, i + MAX_EANS_PER_CALL);
    for await (const offer of iterateOffers(client, { eans: batch })) {
      if (!offer.ean) continue;
      const previous = chosenAt.get(offer.ean);
      if (previous && previous >= (offer.lastModifiedDateTime ?? '')) continue;
      found.set(offer.ean, offer.offerId);
      chosenAt.set(offer.ean, offer.lastModifiedDateTime ?? '');
    }
  }
  return found;
}
