import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TokenManager } from '../src/bol/auth.js';
import { BolClient, mediaType, buildUrl, readRateHeaders } from '../src/bol/client.js';
import { TenantLimiter } from '../src/core/limiter.js';
import { bucketFor, budgeted } from '../src/bol/rateLimits.js';
import { BolApiError } from '../src/core/errors.js';
import {
  listOffers,
  iterateOffers,
  patchOffer,
  createOffer,
  resolveOfferIdsByEan,
} from '../src/bol/offers.v11.js';
import { getStatus, waitForCompletion } from '../src/bol/processStatus.js';

/**
 * A fetch stand-in that records calls and replays scripted responses.
 *
 * @param {Array<{ status: number, body?: any, headers?: Record<string,string> }>} script
 */
function fakeFetch(script) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init, headers: init?.headers ?? {} });
    const next = script.shift() ?? { status: 200, body: {} };
    const headers = new Headers(next.headers ?? {});
    const text = next.body === undefined ? '' : JSON.stringify(next.body);
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      headers,
      async text() {
        return text;
      },
    };
  };
  impl.calls = calls;
  return impl;
}

/** @param {typeof fetch} fetchImpl */
function makeTokens(fetchImpl, over = {}) {
  return new TokenManager({
    tokenUrl: 'https://login.bol.com/token',
    refreshMarginSec: 59,
    credentialsLoader: async () => ({ clientId: 'cid', clientSecret: 'csecret' }),
    fetchImpl,
    ...over,
  });
}

/** @param {typeof fetch} fetchImpl */
function makeClient(fetchImpl, over = {}) {
  const tokens = over.tokens ?? makeTokens(fakeFetch([{ status: 200, body: tokenBody() }]));
  return new BolClient({
    tenantId: 't1',
    baseUrl: 'https://api.bol.com',
    version: 'v11',
    tokens,
    limiter: new TenantLimiter({ tenantId: 't1', budgetPct: 100 }),
    timeoutMs: 5000,
    fetchImpl,
    ...over,
  });
}

const tokenBody = (over = {}) => ({
  access_token: 'tok-abc',
  token_type: 'Bearer',
  expires_in: 299,
  scope: 'RETAILER',
  ...over,
});

// ---------------------------------------------------------------- auth

test('a token is fetched once and reused', async () => {
  const f = fakeFetch([{ status: 200, body: tokenBody() }]);
  const tokens = makeTokens(f);

  assert.equal(await tokens.getToken('t1'), 'tok-abc');
  assert.equal(await tokens.getToken('t1'), 'tok-abc');

  assert.equal(f.calls.length, 1, 'the second call must come from the cache');
  assert.equal(tokens.stats.hits, 1);
});

test('the token request uses Basic auth and the form grant', async () => {
  const f = fakeFetch([{ status: 200, body: tokenBody() }]);
  await makeTokens(f).getToken('t1');

  const { url, init } = f.calls[0];
  assert.equal(url, 'https://login.bol.com/token');
  assert.equal(init.method, 'POST');
  assert.equal(init.body, 'grant_type=client_credentials');
  assert.equal(init.headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.equal(init.headers.Accept, 'application/json', 'the auth service accepts only JSON');
  assert.equal(
    init.headers.Authorization,
    `Basic ${Buffer.from('cid:csecret').toString('base64')}`,
  );
});

test('eight concurrent callers share one token request', async () => {
  const f = fakeFetch([{ status: 200, body: tokenBody() }]);
  const tokens = makeTokens(f);

  const all = await Promise.all(Array.from({ length: 8 }, () => tokens.getToken('t1')));

  assert.deepEqual(new Set(all), new Set(['tok-abc']));
  assert.equal(f.calls.length, 1, 'bol bans IPs for hammering the token endpoint');
});

test('a token is refreshed before it expires, not after', async () => {
  let now = 1_000_000;
  const f = fakeFetch([
    { status: 200, body: tokenBody() },
    { status: 200, body: tokenBody({ access_token: 'tok-2' }) },
  ]);
  const tokens = makeTokens(f, { now: () => now });

  await tokens.getToken('t1');
  now += 239_000; // 239s of 299, margin is 59s
  assert.equal(await tokens.getToken('t1'), 'tok-abc');

  now += 2_000; // now inside the margin
  assert.equal(await tokens.getToken('t1'), 'tok-2');
});

test('a failed token request does not poison later callers', async () => {
  const f = fakeFetch([
    { status: 503, body: { detail: 'down' } },
    { status: 200, body: tokenBody() },
  ]);
  const tokens = makeTokens(f);

  await assert.rejects(() => tokens.getToken('t1'), BolApiError);
  assert.equal(await tokens.getToken('t1'), 'tok-abc');
});

test('a token response without access_token is an error, not a blank bearer', async () => {
  const f = fakeFetch([{ status: 200, body: { expires_in: 299 } }]);
  await assert.rejects(() => makeTokens(f).getToken('t1'), BolApiError);
});

// ---------------------------------------------------------------- client

test('requests carry the versioned media type and the bearer', async () => {
  const f = fakeFetch([{ status: 200, body: { offers: [], page: {} } }]);
  const client = makeClient(f);

  await client.get('/retailer/offers');

  const { init } = f.calls[0];
  assert.equal(init.headers.Accept, 'application/vnd.retailer.v11+json');
  assert.equal(init.headers.Authorization, 'Bearer tok-abc');
  assert.equal(init.headers['Content-Type'], undefined, 'a GET has no body to type');
});

test('a body gets a Content-Type, a 204 gets no parsed body', async () => {
  const f = fakeFetch([{ status: 204 }]);
  const client = makeClient(f);

  const res = await client.patch('/retailer/offers/abc', { stock: { amount: 3 } });

  assert.equal(res.status, 204);
  assert.equal(res.body, null);
  assert.equal(f.calls[0].init.headers['Content-Type'], 'application/vnd.retailer.v11+json');
  assert.equal(f.calls[0].init.body, '{"stock":{"amount":3}}');
});

test('process-status is requested as v10 even from a v11 client', async () => {
  const f = fakeFetch([{ status: 200, body: { status: 'SUCCESS' } }]);
  const client = makeClient(f);

  await getStatus(client, 'ps-1');

  assert.equal(f.calls[0].init.headers.Accept, 'application/vnd.retailer.v10+json');
});

test('a 401 refreshes the token and retries exactly once', async () => {
  const tokenFetch = fakeFetch([
    { status: 200, body: tokenBody() },
    { status: 200, body: tokenBody({ access_token: 'tok-fresh' }) },
  ]);
  const apiFetch = fakeFetch([
    { status: 401, body: { detail: 'expired' } },
    { status: 200, body: { ok: true } },
  ]);
  const client = makeClient(apiFetch, { tokens: makeTokens(tokenFetch) });

  const res = await client.get('/retailer/offers');

  assert.equal(res.body.ok, true);
  assert.equal(apiFetch.calls.length, 2);
  assert.equal(apiFetch.calls[1].init.headers.Authorization, 'Bearer tok-fresh');
});

test('a second 401 surfaces as a credentials problem', async () => {
  const tokenFetch = fakeFetch([
    { status: 200, body: tokenBody() },
    { status: 200, body: tokenBody({ access_token: 'tok-2' }) },
  ]);
  const apiFetch = fakeFetch([
    { status: 401, body: { detail: 'nope' } },
    { status: 401, body: { detail: 'nope' } },
  ]);
  const client = makeClient(apiFetch, { tokens: makeTokens(tokenFetch) });

  await assert.rejects(() => client.get('/retailer/offers'), (err) => {
    assert.ok(err instanceof BolApiError);
    assert.equal(err.status, 401);
    return true;
  });
  assert.equal(apiFetch.calls.length, 2, 'one retry, not a loop');
});

test('a 429 carries Retry-After through and blocks the bucket', async () => {
  const f = fakeFetch([{ status: 429, body: { detail: 'slow down' }, headers: { 'Retry-After': '37' } }]);
  const client = makeClient(f);

  await assert.rejects(() => client.get('/retailer/offers'), (err) => {
    assert.equal(err.retryAfterSec, 37);
    return true;
  });

  const bucket = client.limiter.bucket('offers_read');
  assert.ok(bucket.delayMs() > 30000, 'the whole bucket waits, not just this job');
});

test('X-RateLimit-Remaining overrides our own count when it is lower', async () => {
  const f = fakeFetch([{ status: 200, body: {}, headers: { 'X-RateLimit-Remaining': '2' } }]);
  const client = makeClient(f);

  await client.get('/retailer/offers');

  // Another tool on the same seller account spends from the same limit, and
  // only bol can see both of us.
  assert.ok(client.limiter.bucket('offers_read').tokens <= 2);
});

test('violations from a 400 are kept for the dead letter', async () => {
  const f = fakeFetch([
    {
      status: 400,
      body: { detail: 'bad', violations: [{ name: 'stock.amount', reason: 'max 999' }] },
    },
  ]);
  const client = makeClient(f);

  await assert.rejects(() => client.patch('/retailer/offers/x', { stock: { amount: 5000 } }), (err) => {
    assert.deepEqual(err.violations, ['stock.amount: max 999']);
    return true;
  });
});

test('the audit line never contains a credential', async () => {
  const entries = [];
  const f = fakeFetch([{ status: 200, body: { access_token: 'leaked', ok: 1 } }]);
  const client = makeClient(f, { auditSink: (e) => entries.push(e) });

  await client.post('/retailer/offers', { secret: 'hunter2', ean: '871' });

  assert.equal(entries[0].request.secret, '[redacted]');
  assert.equal(entries[0].request.ean, '871');
  assert.equal(entries[0].response.access_token, '[redacted]');
  assert.equal(entries[0].httpStatus, 200);
});

test('an audit sink that throws does not break the request', async () => {
  const f = fakeFetch([{ status: 200, body: { ok: true } }]);
  const client = makeClient(f, {
    auditSink: () => {
      throw new Error('log table is full');
    },
  });

  const res = await client.get('/retailer/offers');
  assert.equal(res.body.ok, true);
});

test('buildUrl repeats array filters instead of joining them', () => {
  const url = buildUrl('https://api.bol.com', '/retailer/offers', {
    eans: ['871', '872'],
    'page-size': 100,
    cursor: undefined,
  });
  assert.equal(url, 'https://api.bol.com/retailer/offers?eans=871&eans=872&page-size=100');
});

test('readRateHeaders ignores junk instead of producing NaN', () => {
  const h = new Headers({ 'X-RateLimit-Remaining': 'unknown', 'Retry-After': '12' });
  const rate = readRateHeaders(h);
  assert.equal(rate.remaining, null);
  assert.equal(rate.retryAfterSec, 12);
});

test('mediaType and bucketFor agree with the published limits', () => {
  assert.equal(mediaType('v10'), 'application/vnd.retailer.v10+json');
  assert.equal(bucketFor('GET', '/retailer/offers'), 'offers_read');
  assert.equal(bucketFor('GET', '/retailer/offers/abc-123'), 'offers_write');
  assert.equal(bucketFor('PATCH', '/retailer/offers/abc-123'), 'offers_write');
  assert.equal(bucketFor('POST', '/retailer/offers/export'), 'export');
  assert.equal(bucketFor('GET', '/shared/process-status/ps-1'), 'process_status');
  assert.equal(bucketFor('POST', '/shared/process-status'), 'process_status_bulk');

  // The export ceiling is 9 per hour; 60% of it still has to be at least 1.
  assert.equal(budgeted('export', 60).capacity, 5);
  assert.equal(budgeted('offers_write', 60).capacity, 30);
});

// ---------------------------------------------------------------- offers v11

test('listOffers maps the paged envelope', async () => {
  const f = fakeFetch([
    { status: 200, body: { offers: [{ offerId: 'o1' }], page: { pageSize: 100, nextCursor: 'c2' } } },
  ]);
  const client = makeClient(f);

  const { offers, page } = await listOffers(client, { eans: ['871'], pageSize: 500 });

  assert.equal(offers[0].offerId, 'o1');
  assert.equal(page.nextCursor, 'c2');
  assert.ok(f.calls[0].url.includes('page-size=100'), 'page-size is capped at 100');
});

test('iterateOffers walks the cursor to the end', async () => {
  const f = fakeFetch([
    { status: 200, body: { offers: [{ offerId: 'o1' }], page: { nextCursor: 'c2' } } },
    { status: 200, body: { offers: [{ offerId: 'o2' }], page: { nextCursor: null } } },
  ]);
  const client = makeClient(f);

  const seen = [];
  for await (const o of iterateOffers(client)) seen.push(o.offerId);

  assert.deepEqual(seen, ['o1', 'o2']);
});

test('a cursor that repeats stops the walk instead of spinning', async () => {
  const f = fakeFetch([
    { status: 200, body: { offers: [{ offerId: 'o1' }], page: { nextCursor: 'same' } } },
    { status: 200, body: { offers: [{ offerId: 'o2' }], page: { nextCursor: 'same' } } },
  ]);
  const client = makeClient(f);

  await assert.rejects(async () => {
    for await (const _ of iterateOffers(client)) { /* drain */ }
  }, /cursor repeated/);
});

test('an empty patch is refused before it spends a write token', async () => {
  const f = fakeFetch([]);
  const client = makeClient(f);

  await assert.rejects(() => patchOffer(client, 'o1', {}), /empty patch/);
  assert.equal(f.calls.length, 0);
});

test('createOffer insists on getting an offerId back', async () => {
  const ok = fakeFetch([{ status: 201, body: { offerId: 'new-1' } }]);
  assert.deepEqual(await createOffer(makeClient(ok), { ean: '871' }), { offerId: 'new-1' });

  const bad = fakeFetch([{ status: 201, body: {} }]);
  await assert.rejects(() => createOffer(makeClient(bad), { ean: '871' }), /no offerId/);
});

test('an EAN with two offers resolves to the most recently modified one', async () => {
  const f = fakeFetch([
    {
      status: 200,
      body: {
        offers: [
          { offerId: 'old', ean: '871', lastModifiedDateTime: '2026-01-01T00:00:00Z' },
          { offerId: 'new', ean: '871', lastModifiedDateTime: '2026-11-01T00:00:00Z' },
        ],
        page: { nextCursor: null },
      },
    },
  ]);

  const map = await resolveOfferIdsByEan(makeClient(f), ['871']);
  assert.equal(map.get('871'), 'new', 'picking blind would attach the wrong condition or channel');
});

// ---------------------------------------------------------------- process status

test('an expired process status returns null instead of throwing', async () => {
  const f = fakeFetch([{ status: 404, body: { detail: 'not found' } }]);
  assert.equal(await getStatus(makeClient(f), 'ps-gone'), null);
});

test('waitForCompletion stops polling once the status settles', async () => {
  const f = fakeFetch([
    { status: 200, body: { status: 'PENDING' } },
    { status: 200, body: { status: 'SUCCESS', entityId: 'o1' } },
  ]);
  const client = makeClient(f);

  const status = await waitForCompletion(client, 'ps-1', { intervalMs: 1, timeoutMs: 5000 });

  assert.equal(status.status, 'SUCCESS');
  assert.equal(f.calls.length, 2);
});

test('waitForCompletion gives up rather than looping forever', async () => {
  const f = fakeFetch(Array.from({ length: 50 }, () => ({ status: 200, body: { status: 'PENDING' } })));
  const client = makeClient(f);

  await assert.rejects(
    () => waitForCompletion(client, 'ps-1', { intervalMs: 1, timeoutMs: 20 }),
    /still PENDING/,
  );
});

test('a vanished process status ends the wait instead of guessing SUCCESS', async () => {
  const f = fakeFetch([
    { status: 200, body: { status: 'PENDING' } },
    { status: 404, body: {} },
  ]);
  // Guessing here would write a pushed_* value bol may never have received.
  assert.equal(await waitForCompletion(makeClient(f), 'ps-1', { intervalMs: 1 }), null);
});
