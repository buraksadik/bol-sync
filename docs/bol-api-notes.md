# Bol.com API — verified notes

Source: the live OpenAPI specs and documentation, read on **18 November 2026**.
Nothing here was written from memory. Every line comes from one of these URLs.

| What | URL |
|---|---|
| Retailer API v10 spec | `https://api.bol.com/retailer/public/apispec/Retailer%20API%20-%20v10` |
| Offers API v11 spec | `https://api.bol.com/registry/api-definitions/offers/offers-v11.yaml` |
| Process Status v10 spec | `https://api.bol.com/registry/api-definitions/process-status/process-status-v10.yaml` |
| Live rate limit list (JSON) | `https://api.bol.com/retailer/public/ratelimits` |
| Authentication | `https://api.bol.com/retailer/public/Retailer-API/authentication.html` |
| Conventions (429, headers) | `https://api.bol.com/retailer/public/Retailer-API/conventions.html` |

---

## 1. Authentication

- `POST https://login.bol.com/token?grant_type=client_credentials`
- `Authorization: Basic base64(clientId:clientSecret)`
- `Content-Type: application/x-www-form-urlencoded`, `Accept: application/json`
- Response: `{ access_token, token_type: "Bearer", expires_in: 299, scope }`
- **299 seconds.** The documentation warns about this directly: asking for a new token on
  every request overloads the auth service and gets the IP banned.
  → The token is held in one place, refreshed at second 240, and concurrent refreshes
  share a single request.

## 2. Updating stock and price — there are two generations

### v11 Offers API (new, preferred)

Version `11.5.0`. **Synchronous** — no process-status mechanism needed.

| Method | Endpoint | Response |
|---|---|---|
| GET | `/retailer/offers` | 200 + paged list |
| POST | `/retailer/offers` | **201** + `offerId` |
| GET | `/retailer/offers/{offer-id}` | 200 |
| PATCH | `/retailer/offers/{offer-id}` | **204** |
| DELETE | `/retailer/offers/{offer-id}` | 204 |
| GET | `/retailer/offers/{offer-id}/not-for-sale-reasons` | 200 |

- Accept / Content-Type: `application/vnd.retailer.v11+json`
- `GET /retailer/offers` filters: `offer-ids`, `eans`, `reference`, `for-sale`,
  `last-modified-date-time` (ISO 8601 UTC), `page-size` (1–100), `cursor`.
  → **Cursor-based paging.** Keep going until `page.nextCursor` is null.
- The spec sets no `style` or `explode` on the array filters, so the OpenAPI default
  applies: repeated parameters (`eans=a&eans=b`), not a comma-joined list. A joined list
  would be read as one very long EAN and find nothing, without an error.
- The `PATCH` body is partial: `pricing`, `stock`, `fulfilment`, `onHoldByRetailer`,
  `reference`, `countryAvailabilities`, `economicOperatorId`, `unknownProductTitle`.
  Stock and price are updated in **one request**.
- `offerId` is now a UUID.

What v11 adds over v10 (from the official "what's new" page): synchronous processing, a
paged offer list, partial updates through PATCH, refurbished support, one offer covering
both NL and BE, and a separate endpoint for the reason an offer is offline.

### v10 Retailer API (old, fallback adapter)

| Method | Endpoint | Response |
|---|---|---|
| PUT | `/retailer/offers/{offer-id}/stock` | **202** + ProcessStatus |
| PUT | `/retailer/offers/{offer-id}/price` | **202** + ProcessStatus |
| PUT | `/retailer/offers/{offer-id}` | 202 + ProcessStatus |
| POST | `/retailer/offers/export` | 202 (requests a CSV report) |
| GET | `/retailer/offers/export/{report-id}` | 200 CSV |

- Accept / Content-Type: `application/vnd.retailer.v10+json`
- A 202 means **the work is not done**. Use the `processStatusId` with
  `GET /shared/process-status/{id}`.
  Statuses: `PENDING | SUCCESS | FAILURE | TIMEOUT`.
- Bulk lookup: `POST /shared/process-status`, at most **1000** ids per request.
- Event types that matter here: `UPDATE_OFFER_STOCK`, `UPDATE_OFFER_PRICE`,
  `UPDATE_OFFER`, `CREATE_OFFER`, `DELETE_OFFER`, `CREATE_OFFER_EXPORT`.
- **Warning:** process status records are not kept forever. Once a record expires the
  lookup returns 404. Polling has to stop there, or the worker loops forever on work that
  finished long ago.

## 3. Data shapes

### stock
```json
{ "amount": 6, "managedByRetailer": true }
```
- On v10, `amount` is limited to **0–999** (`minimum: 0, maximum: 999` in the spec). v11
  states no upper bound, but we still clamp at 999.
- What `managedByRetailer` means (from the official description):
  - `false` → Bol.com subtracts **all open orders** itself and works out the corrected
    stock.
  - `true` → only orders placed **after the last offer update** are counted.
  - The rule: `true` when Bol.com orders are written back into the source system
    (webshop or ERP), `false` when they are not. The wrong choice leads straight to
    overselling.
- `correctedStock` is read-only: what is left after open orders are subtracted.
  **This is the field that decides whether the product sells.** At 0 the offer is off the
  shelf. It must not be confused with the `amount` we send.

### pricing
```json
{ "bundlePrices": [ { "quantity": 1, "unitPrice": 9.99 } ] }
```
- An element with `quantity: 1` is **mandatory**. At most 4 elements.
- `unitPrice`: VAT **included**, `minimum: 1`, `maximum: 9999`, two decimals, dot
  separator.
- With more than one tier, `quantity` must increase and `unitPrice` must decrease.

## 4. Rate limits — real values from the live list

| Endpoint | Method | Limit |
|---|---|---|
| `/retailer/offers/**` | GET, POST, PATCH, DELETE | **50 / second** |
| `/retailer/offers*` | GET (list) | **25 / second** |
| `/retailer/offers/*/stock` | PUT (v10) | 50 / second |
| `/retailer/offers/*/price` | PUT (v10) | 50 / second |
| `/retailer/offers/export` | POST | **9 / hour** |
| `/retailer/offers/export/*` | GET | 9 / hour |
| `/shared/process-status/*` | GET | 100 / second |
| `/shared/process-status` | GET, POST (bulk) | **2 / second** |
| `/retailer/orders` | GET | 25 / minute |
| `/retailer/orders/*` | GET | 25 / second |
| `/retailer/inventory` | GET | 20 / minute |

Headers (from the conventions page):
- Within the limit: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`
- Over it: **429** plus `Retry-After: <seconds>`, with a body of
  `{ "title": "Too Many Requests", "status": 429, "detail": "..." }`

What follows for the design:

1. The CSV export allows **9 requests an hour**, so it is only usable for the first
   import. Reconciliation uses the v11 `GET /retailer/offers` with
   `last-modified-date-time` instead.
2. Limits are **per seller account**, not per application. If the client runs a repricer
   or an ERP, we share the same bucket with it. Default budget: **60%** of the limit.
3. Even a 403 is marked retryable in the conventions table. A 400 is not.

## 5. Error codes (per the official table)

| Code | Retryable | What we do |
|---|---|---|
| 400 | No | Permanent → dead letter, the SKU is flagged |
| 401 | No | Refresh the token once, retry the request once |
| 403 | **Yes** | Back off and retry; three in a row pauses the tenant |
| 404 | No | The offer is gone → clear `offer_id`, resolve it again from the EAN |
| 409 | — | Re-read the offer, re-plan, try once more |
| 429 | Yes | Apply `Retry-After` exactly, empty the bucket |
| 5xx | Yes | Exponential backoff with jitter, six attempts at most |

---

## 6. The demo environment — it exists, but not in the way you would hope

Verified on 18 November 2026, two ways.

**Path probe.** Made-up prefixes return `403`. The demo prefixes return `401`, meaning
"authenticate first" — so those paths are real and routed.

```
401  https://api.bol.com/retailer-demo/offers
401  https://api.bol.com/shared-demo/process-status/1
403  https://api.bol.com/retailer-xyzzy/offers      <- made up
403  https://api.bol.com/nonsense/offers            <- made up
```

**The spec itself.** The v10 spec's own `info.description` names the demo environment and
links two pages:
- [Demo environment](https://api.bol.com/retailer/public/Retailer-API/demo/demo.html)
- [Demo scenarios v10](https://api.bol.com/retailer/public/Retailer-API/demo/v10-index.html)
  — 16 endpoint groups: Commissions, Insights, Inventory, Invoices, Offers, Orders,
  Process Status, Products, Promotions, Replenishments, Retailers, Returns, Shipments,
  Shipping Labels, Subscriptions, Transports.

### What it gives you

| Feature | State |
|---|---|
| Authentication | Works **exactly** as in production |
| An example response per endpoint | Yes, **hard coded** |
| Validation and models | The **current** production versions |
| Rate limit headers | Yes |

### What it does not — three hard limits

1. **It keeps no state.** Bol.com's own words: *"updates will return a process status
   entity, but this is a mocked instance so no actual updates are being processed."*
   The stock you write goes nowhere. Read it back and nothing has changed. The hard-coded
   answers only match **the specific requests described in the demo documentation**;
   there is no end-to-end flow.
2. **One generic rate limit**, not one per endpoint. So the limit table in §4 cannot be
   tested there.
3. **Not recommended for CI/CD**, and not suitable for load testing.

### Where the credentials come from — this is the real constraint

Everything, the demo environment included, needs a Client ID and Client Secret from the
**Seller Dashboard (SDD)**. There is **no** self-service developer key. Without a bol.com
seller account you cannot even reach the demo environment.

The path: `SDD → account profile → Instellingen → Diensten → API Instellingen`.
A **technical contact** is required first. Without it, API access is not granted, and if
Bol.com cannot reach that contact they may ban the integration.

The dashboard has two sections:

| Section | What it is for |
|---|---|
| **Client Credentials** | Keys the seller created themselves |
| **Authorized parties** | Keys given to integration partners |

**What this means for the design.** The service does not need a seller account of its
own. The shop owner creates **a key pair just for the service** in their own dashboard.
Bol.com recommends exactly that — *"Create separate credentials for separate purposes. Do
not reuse the same credentials for your own app(s) to grant access to anyone else."*
Access is revoked with one click on the bin icon.

So the service never sees the shop's password, and the access it was given can be taken
back at any moment. That is the whole security model of the integration.
