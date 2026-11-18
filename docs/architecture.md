# Stock and price sync — architecture

The job: move stock and price from a webshop (WooCommerce, Shopify, a CSV/XML supplier
feed, or an ERP) into a Bol.com seller account **without overselling** and **without
breaking the rate limit**.

The design in one sentence: the source system tells the truth, the rules engine works out
the target, the queue sends one change at a time, and reconciliation catches whatever
drifted.

```
source (webhook / poll)
      │
      ▼
 source_state  ──►  planner (safety stock + price rules)  ──►  offer_state.desired_*
                                                                     │
                                                              differ │ (threshold + priority)
                                                                     ▼
                                                               sync_jobs (queue)
                                                                     │
                                                      limiter ──► worker ──► Bol v11 PATCH
                                                                     │
                                                                     ▼
                                                             offer_state.pushed_*
                                                                     ▲
                       reconciler (15 min, GET /retailer/offers) ────┘
```

---

## 1. Why v11

On v10, stock and price are two separate `PUT` calls. Each returns **202** with a
`processStatusId`, and you have to poll to find out what happened. On v11 a single `PATCH`
updates both and returns **204**. The work is done when the call returns.

What that means for a full update of a 5,000 product catalogue:

- v10: 10,000 writes plus 10,000 process-status reads
- v11: 5,000 writes, no polling

`src/bol/offers.v10.js` is still here. If a client's account is not on v11 yet, one line
of configuration (`BOL_OFFERS_API_VERSION=v10`) falls back to the old endpoints.

---

## 2. Tables

PostgreSQL. For small installs the same schema runs on SQLite (`uuid` → `text`,
`jsonb` → `text`, `numeric` → `real`).

| Table | What it holds | The point of it |
|---|---|---|
| `tenants` | One client, with encrypted Bol credentials | `rate_budget_pct` decides how much of the limit we spend |
| `products` | sku ↔ ean ↔ `offer_id` | With no `offer_id`, the EAN resolves it first |
| `source_state` | Raw stock and price from the source | `payload_hash` drops work that changed nothing |
| `offer_state` | `desired_*`, `pushed_*`, `bol_*` — three layers | Keeping them apart is what makes reconciliation possible |
| `safety_stock_rules` | Buffer rules, per tenant or per sku | `priority` lets the narrowest rule win |
| `price_rules` | Floor, ceiling, rounding, maximum change | `max_change_pct` is the insurance against a price accident |
| `sync_jobs` | The queue | `dedupe_key` keeps one open job per product |
| `sync_log` | Request and response of every HTTP call | Proof for the client of what we sent and when |
| `dead_letters` | Permanent failures | No product disappears quietly |
| `rate_buckets` | The token bucket, persisted | A shared bucket for multi-process installs |

### Why three stock layers (`desired` / `pushed` / `bol`)

- `desired_stock` — the number we **want** to send, after the rules.
- `pushed_stock` — the number we last actually **sent**.
- `bol_stock` + `bol_corrected_stock` — the number Bol.com **reports** when we read it.

If `pushed != bol`, something outside this service touched the offer: the seller edited it
by hand, or another tool wrote to it. That gap raises an alert. With a single layer the
gap is invisible, and that is where overselling comes from.

Schema: `src/db/schema.sql`

---

## 3. The queue

No Redis or RabbitMQ. A Postgres table plus `FOR UPDATE SKIP LOCKED` is enough. It runs in
one container and adds no dependency to the client's VPS.

```sql
UPDATE sync_jobs SET status = 'running', locked_by = $1, locked_at = now()
WHERE id IN (
  SELECT id FROM sync_jobs
  WHERE status = 'pending' AND run_after <= now()
  ORDER BY priority ASC, run_after ASC
  FOR UPDATE SKIP LOCKED
  LIMIT $2
)
RETURNING *;
```

**Job types**

| Type | What it does | Priority |
|---|---|---|
| `push_offer` (stock **drop**) | PATCH to Bol.com | **10** |
| `push_offer` (price change) | PATCH to Bol.com | 50 |
| `push_offer` (stock **rise**) | PATCH to Bol.com | 80 |
| `resolve_offer_id` | EAN → offerId | 60 |
| `pull_source` | Read the source | 90 |
| `reconcile` | Read Bol.com and compare | 120 |

**A stock drop always goes first.** Overselling costs a cancellation and a hit to the
seller rating. A price rise that goes out a minute late costs nothing like that.

**Deduplication:** a unique index on `dedupe_key = tenant_id:product_id:push_offer`,
conditional on `status IN ('pending','running')`. A product can change fifty times a
minute and still have exactly one job waiting, carrying the newest target.

**One at a time, not in bulk:** v11 has no bulk update endpoint. At 50/s with a 60%
budget that is about 108,000 offer updates an hour. Sending them one at a time is not the
bottleneck.

### The "changed while running" race — the queue's quietest bug

The dedupe index has a side effect. While a job is `running`, a new enqueue updates the
same row. So the worker is sending an old payload while the row already holds a new one.
If the job then finishes as `status='done'`, **that change is silently lost** — and what
gets lost is usually a stock drop, which is exactly where overselling starts.

The fix lives in `markDone`: if `updated_at > locked_at`, the job closes as `pending`
instead of `done` and runs again at once. In Postgres the right-hand side of an `UPDATE`
sees the old values, so the comparison fits in one statement:

```sql
SET status = CASE WHEN updated_at > locked_at THEN 'pending' ELSE 'done' END
```

`attempts` also increments **at claim time**, not on failure. A job that crashes the
process therefore cannot loop forever. It reaches `max_attempts` and lands in
`dead_letters`.

---

## 4. The safety stock rule

```
raw        = source_state.stock
buffer     = max(buffer_abs, ceil(raw * buffer_pct / 100))
candidate  = raw - buffer
if candidate < min_publish  ->  publish = 0
else                        ->  publish = min(candidate, max_publish, 999)
```

Defaults: `buffer_abs = 2`, `buffer_pct = 0`, `min_publish = 1`, `max_publish = 999`.

On top of that:

1. **An asymmetric threshold.** Every drop is sent immediately. A rise is skipped when
   `abs(new - pushed) < stock_delta_threshold` (default 2). A product that moves between
   7 and 8 then does not produce hundreds of writes a day.
2. **Zero is a special case.** When the target is 0 the threshold is ignored and the
   value always goes out.
3. **`managedByRetailer` is a tenant setting.** `true` when Bol.com orders are written
   back into the source system, `false` when they are not. The wrong choice means
   overselling, directly. The detail is in `docs/bol-api-notes.md` §3.
4. **Do not touch a stale source.** If `source_state.observed_at` is older than
   `SOURCE_STALE_AFTER_MIN` minutes, nothing is planned. A dead source that answers
   "0 stock" can pull the whole catalogue off the shelf. That is the most expensive
   mistake this service could make.
5. **A bulk-drop guard.** If more than `BULK_DROP_GUARD_PCT` of the catalogue goes to
   zero in one pass, the batch is held and a warning is written. That pattern nearly
   always means a broken feed on the source side.

Code: `src/sync/safetyStock.js` — pure functions, no side effects, directly testable.

---

## 5. The price rule

```
base    = source_state.price            (VAT included, EUR)
marked  = base * (1 + markup_pct / 100)
clamped = clamp(marked, floor_price, ceiling_price)
final   = round(clamped, rounding)      none | cent | psychological_99
```

Guard rails:

- `final < 1` or `final > 9999` → not sent, dead letter. (Bol.com's own spec limits.)
- `abs(final - pushed_price) / pushed_price > max_change_pct` (default 25%) → not sent,
  waits for a human. This is what catches a source feed that starts reporting cents
  instead of euros.
- `bundlePrices` always contains a `quantity: 1` element. If there are volume tiers, the
  quantity must increase and the unit price must decrease.

Code: `src/sync/pricing.js`

---

## 6. Rate limits

A token bucket per bucket name, per tenant:

| Bucket | Real limit | Default budget (60%) |
|---|---|---|
| `offers_write` | 50 / s | 30 / s |
| `offers_read` | 25 / s | 15 / s |
| `process_status` | 100 / s | 60 / s |
| `process_status_bulk` | 2 / s | 1 / s |
| `export` | 9 / hour | 5 / hour |
| `orders_read` | 25 / min | 15 / min |

The rules:

- Limits are **per seller account**. If the client runs another tool, it drinks from the
  same bucket. That is why the default is 60% and not 100%
  (`tenants.rate_budget_pct` changes it).
- `X-RateLimit-Remaining` is read from every response. When Bol.com's count is lower than
  ours, the bucket **drops to that value**. Bol.com's header is the real source of truth,
  not our own counter.
- On a 429, the `Retry-After` value is used exactly as given and the bucket is emptied.
- The token endpoint has its own, much tighter limit. The token is held in one place,
  refreshed at second 240 of its 299-second life, and concurrent refreshes share one
  request.

Code: `src/core/limiter.js`, `src/bol/rateLimits.js`

---

## 7. Error handling

| Case | Class | Behaviour |
|---|---|---|
| 400 | permanent | Dead letter plus `products.sync_enabled = false`. Never retried. |
| 401 | token | Refresh once, retry once. A second 401 pauses the tenant. |
| 403 | transient | Backoff. Three in a row pauses the tenant and raises a notice. |
| 404 (offer) | data | Clear `offer_id`, queue a `resolve_offer_id`. |
| 409 | conflict | Re-read the offer, re-plan, try once more. |
| 429 | limit | Wait out `Retry-After`, empty the bucket, requeue the job. |
| 5xx / timeout | transient | Exponential backoff with jitter, six attempts at most. |
| Network error | transient | The same. |

Backoff: `min(2^attempt * 1000ms, 5 min)` with ±20% jitter. Without the jitter every job
that failed in the same 429 wave wakes at the same millisecond and produces the next one.

**Circuit breaker:** more than 10 transient failures for one tenant inside a 60-second
window pauses that tenant for 5 minutes. Other clients are not affected.

**A dead letter is always visible to a human.** No product is skipped quietly. The
`dead_letters` table is served by `GET /health/dead-letters` and by a daily summary.

Code: `src/core/errors.js`, `src/core/retry.js`, `src/core/circuitBreaker.js`

---

## 8. Reconciliation

Every 15 minutes:

1. `GET /retailer/offers?last-modified-date-time=<last run>&page-size=100`, then the
   cursor loop.
2. For every offer that comes back, write `bol_stock`, `bol_corrected_stock`, `bol_price`
   and `bol_last_modified`.
3. Rows where `pushed_* != bol_*` are marked as **drift** and go back on the queue.
4. Rows where `bol_corrected_stock = 0` while `desired_stock > 0` are reported
   separately. These offers are on our books but off the shelf, which is lost revenue
   rather than a bug.

The CSV export (`POST /retailer/offers/export`) is only used for the **first import**.
Nine requests an hour makes it unusable for routine work.

Once a day the pass runs without the `last-modified` filter, over everything.

---

## 9. Configuration

Everything comes from `.env`; see `.env.example`.

Credentials are stored in the database encrypted with AES-256-GCM under
`BOL_CRED_ENC_KEY`. They never reach a log line in plain text — see the redaction in
`src/bol/client.js`.
