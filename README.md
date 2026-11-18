# bol-sync

Stock and price sync between a webshop and a Bol.com seller account.

Your shop sells one unit. Bol.com still shows it in stock. The order comes in, you cancel
it, and your seller rating takes the hit. This service closes that gap, and it is built so
that the failure modes cost you nothing.

Built on the **Offers API v11**, which is synchronous: one `PATCH` updates stock and price
together and returns `204`. No process-status polling. The older v10 endpoints are kept as
a fallback adapter for accounts that are not on v11 yet.

## See it work in two minutes

No Bol.com account needed. The demo writes a supplier feed, runs the real rules over it,
and prints what the service decided.

```
npm install
npm run migrate
npm run seed:demo
```

```
sku         in shop   on bol   held back      price   note
----------------------------------------------------------------------------
BAM-001          50       48           2      12.95
BAM-002           3        1           2    1249.00
BAM-003           0        0           0      24.50
BAM-004         120      100          20       8.95   own rule for this sku
BAM-005           2        0           2      34.95   under the minimum after the buffer
BAM-006           7        5           2      19.95

queued: 6 job(s) waiting for a bol offer id
```

Three things happened there. BAM-004 used its own rule instead of the shop-wide one.
BAM-005 had two left, the buffer is two, so it went to zero rather than to a number that
would sell. BAM-002 came in as `1.249,00` and was read as 1249.00, because Dutch feeds use
a decimal comma.

## What it does

- Reads stock and price from the source shop: WooCommerce, or a CSV / XML supplier feed.
- Applies your safety-stock and price rules.
- Pushes only real changes to Bol.com, inside the rate limit.
- Reads Bol.com back every 15 minutes and reports any offer that drifted.
- Answers a webhook from the shop in seconds instead of waiting for the next poll.

## Why it does not oversell

1. **Safety buffer.** A buffer is held back from every offer, as a fixed number or a
   percentage. Below a minimum the offer goes to zero instead of a small number, because
   a small number still sells.
2. **Stock drops jump the queue.** A decrease is sent at once. An increase waits for a
   delta threshold, so a product that moves between 7 and 8 does not create hundreds of
   writes a day.
3. **Stale source data is ignored.** If the shop has not answered for 30 minutes, nothing
   is planned. A dead source that answers "0 stock" can pull a whole catalogue offline.
4. **Bulk-drop guard.** If more than 20% of the catalogue drops to zero in one pass, the
   whole batch is held and a human is asked. That pattern is almost always a broken feed,
   and half a catalogue offline is no better than all of it.
5. **Three stock layers.** What we want, what we sent, and what Bol.com reports back are
   stored separately. When they differ, something else touched the offer, and the next
   reconcile re-pushes it.

## Rate limits

Limits are per seller account, not per application. The service spends 60% of the
published limit by default, so your repricer or ERP keeps working. Every response header
(`X-RateLimit-Remaining`) is read back and lowers the local bucket when Bol.com's count is
stricter than ours. A `429` is handled by its own `Retry-After` value, never by a guess.

| Bucket | Bol.com limit | Default budget |
|---|---|---|
| offer writes | 50 / s | 30 / s |
| offer reads | 25 / s | 15 / s |
| offer export | 9 / hour | 5 / hour |

The token bucket lives in Postgres and is spent in a single SQL statement. Two worker
processes cannot both believe they had the last token.

## Decisions worth reading

A few choices that are not obvious from the code:

- **`correctedStock` is stored apart from `amount`.** `amount` is what we sent.
  `correctedStock` is what actually sells after Bol.com subtracts open orders. An offer
  can agree with us in every column and still sell nothing. That is lost revenue, not a
  bug, so it gets a report rather than a pointless re-push.
- **A product that disappears from the feed is not set to zero.** It keeps its last
  snapshot and goes stale. A supplier dropping a row is not a supplier saying "none left".
- **`stock_quantity: null` in WooCommerce means unknown, not zero.** Stock management is
  simply off for that product. Publishing 0 would take it off the shelf for no reason.
- **The target is re-read from the database before every push.** A job that waited out
  three backoffs is carrying a number from several minutes ago.
- **A 404 clears the offer id and asks for a new one.** Retrying a dead id never recovers.
- **An offer is never created automatically.** A duplicate offer on your account is a
  support ticket, not a feature. Unknown EANs are reported instead.
- **Nothing is marked as sent before Bol.com confirms it.** On v10 that means waiting for
  the process status; if the record has expired, the result is "unknown" and the reconcile
  settles it. Guessing "success" would record a number Bol.com may never have received.

## Layout

```
docs/architecture.md     design: tables, queue, rules, errors
docs/bol-api-notes.md    verified API facts with source URLs
src/bol/                 auth, HTTP client, v11 and v10 adapters
src/core/                token bucket, retry, errors, circuit breaker, secrets
src/sync/                safety stock, pricing, planner, differ, reconciler
src/sources/             WooCommerce, CSV and XML feeds
src/queue/               worker, scheduler, job handlers
src/http/                health endpoints and the source webhook
src/db/schema.sql        PostgreSQL schema
```

## Run

```
cp .env.example .env
npm install
npm run migrate
npm start
```

On Windows without Docker, `scripts/pg-dev.ps1` runs a throwaway Postgres from the
binary-only package: no installer, no service, no admin rights.

```
.\scripts\pg-dev.ps1 init
.\scripts\pg-dev.ps1 start
```

## Tests

```
npm test
```

163 tests. The ones that need a database skip themselves unless `DATABASE_URL` is set, so
the suite stays green on a laptop with none.

The integration tests earn their keep. The first run against a real Postgres found that
`UPDATE ... RETURNING` hands rows back in an undefined order, which was quietly putting a
priority-10 "stop overselling" job behind a priority-80 one.

## HTTP

| Route | What it answers |
|---|---|
| `GET /health` | is the process alive |
| `GET /health/queue?tenant=…` | pending, running, dead, and the age of the oldest pending job |
| `GET /health/dead-letters?tenant=…` | failures that will not fix themselves |
| `GET /health/drift?tenant=…` | offers where Bol.com disagrees with us, and offers that are live but invisible |
| `POST /webhook/source/:tenant` | the shop pushes a change |

The webhook verifies its HMAC signature before the body is parsed. An unsigned webhook
could set a whole catalogue to zero, so it is the most carefully guarded route here.

## What you provide

Your Bol.com API credentials, from your seller dashboard:
`Instellingen` → `Diensten` → `API Instellingen`.

You create a separate key pair for this service, and you can revoke it with one click.
Your password and your account are never involved. The secret is stored encrypted
(AES-256-GCM) and never appears in a log line.

## Status

Complete and tested end to end against the official API specification and a local
Postgres. The one thing it has not seen is a live seller account, because those
credentials come from the shop owner.

Not built yet: a Shopify adapter, and multi-tenant onboarding through the UI. Both are a
day of work each when a client needs them.

## How I work

Async and written-first. No calls needed. You get a written update every day a job is
open, a written handover at the end, and a silent screen recording of the working result.
Everything stays in writing, so you can read back every decision months later.
