-- bol-sync — PostgreSQL schema
-- Apply with: node scripts/migrate.js

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------- tenants

CREATE TABLE IF NOT EXISTS tenants (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                   text        NOT NULL,
  bol_client_id          text        NOT NULL,
  bol_client_secret_enc  bytea       NOT NULL,          -- AES-256-GCM, key = BOL_CRED_ENC_KEY
  offers_api_version     text        NOT NULL DEFAULT 'v11',  -- v11 | v10
  rate_budget_pct        smallint    NOT NULL DEFAULT 60,
  -- true  : bol orders are written back into the source system
  -- false : they are not, let bol subtract open orders itself
  managed_by_retailer    boolean     NOT NULL DEFAULT false,
  paused_until           timestamptz,
  active                 boolean     NOT NULL DEFAULT true,
  created_at             timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- catalogue

CREATE TABLE IF NOT EXISTS products (
  id                 bigserial PRIMARY KEY,
  tenant_id          uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  sku                text        NOT NULL,
  ean                text,
  offer_id           uuid,                               -- bol offer id (v11 = uuid)
  condition          text        NOT NULL DEFAULT 'NEW', -- NEW | SECONDHAND | REFURBISHED
  fulfilment_method  text        NOT NULL DEFAULT 'FBR', -- FBR | FBB
  sync_enabled       boolean     NOT NULL DEFAULT true,
  disabled_reason    text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, sku)
);

CREATE INDEX IF NOT EXISTS products_tenant_ean    ON products (tenant_id, ean);
CREATE UNIQUE INDEX IF NOT EXISTS products_offer  ON products (tenant_id, offer_id)
  WHERE offer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS products_unresolved    ON products (tenant_id)
  WHERE offer_id IS NULL AND sync_enabled;

-- ---------------------------------------------------------------- state

-- What the source system (webshop / ERP / feed) says.
CREATE TABLE IF NOT EXISTS source_state (
  product_id    bigint PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
  stock         integer       NOT NULL,
  price         numeric(10,2) NOT NULL,
  currency      char(3)       NOT NULL DEFAULT 'EUR',
  source_name   text          NOT NULL,                 -- woocommerce | shopify | csv | ...
  payload_hash  text          NOT NULL,                 -- skip work when nothing changed
  observed_at   timestamptz   NOT NULL
);

-- Three layers: what we want, what we sent, what bol reports back.
CREATE TABLE IF NOT EXISTS offer_state (
  product_id            bigint PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
  desired_stock         integer,
  desired_price         numeric(10,2),
  planned_at            timestamptz,

  pushed_stock          integer,
  pushed_price          numeric(10,2),
  pushed_at             timestamptz,

  bol_stock             integer,        -- stock.amount
  bol_corrected_stock   integer,        -- stock.correctedStock -> this is what actually sells
  bol_price             numeric(10,2),
  bol_last_modified     timestamptz,
  reconciled_at         timestamptz,

  drift_detected_at     timestamptz,    -- pushed_* != bol_*
  needs_manual_review   boolean     NOT NULL DEFAULT false,
  review_reason         text
);

CREATE INDEX IF NOT EXISTS offer_state_drift  ON offer_state (drift_detected_at)
  WHERE drift_detected_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS offer_state_review ON offer_state (needs_manual_review)
  WHERE needs_manual_review;

-- ---------------------------------------------------------------- rules

CREATE TABLE IF NOT EXISTS safety_stock_rules (
  id                     bigserial PRIMARY KEY,
  tenant_id              uuid     NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  scope                  text     NOT NULL DEFAULT 'tenant',   -- tenant | sku
  sku                    text,
  buffer_abs             integer  NOT NULL DEFAULT 2,
  buffer_pct             numeric(5,2) NOT NULL DEFAULT 0,
  min_publish            integer  NOT NULL DEFAULT 1,          -- below this -> publish 0
  max_publish            integer  NOT NULL DEFAULT 999,        -- bol v10 hard cap
  stock_delta_threshold  integer  NOT NULL DEFAULT 2,          -- only for increases
  priority               smallint NOT NULL DEFAULT 100,        -- lower wins
  CHECK (scope <> 'sku' OR sku IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS safety_rules_lookup ON safety_stock_rules (tenant_id, scope, sku);

CREATE TABLE IF NOT EXISTS price_rules (
  id              bigserial PRIMARY KEY,
  tenant_id       uuid     NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  scope           text     NOT NULL DEFAULT 'tenant',
  sku             text,
  markup_pct      numeric(6,2)  NOT NULL DEFAULT 0,
  floor_price     numeric(10,2),
  ceiling_price   numeric(10,2),
  rounding        text     NOT NULL DEFAULT 'cent',  -- none | cent | psychological_99
  max_change_pct  numeric(5,2) NOT NULL DEFAULT 25,  -- bigger jump -> manual review
  priority        smallint NOT NULL DEFAULT 100,
  CHECK (scope <> 'sku' OR sku IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS price_rules_lookup ON price_rules (tenant_id, scope, sku);

-- ---------------------------------------------------------------- queue

CREATE TABLE IF NOT EXISTS sync_jobs (
  id            bigserial PRIMARY KEY,
  tenant_id     uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  product_id    bigint      REFERENCES products(id) ON DELETE CASCADE,
  type          text        NOT NULL,   -- pull_source | resolve_offer_id | push_offer | reconcile
  dedupe_key    text,
  payload       jsonb       NOT NULL DEFAULT '{}'::jsonb,
  priority      smallint    NOT NULL DEFAULT 100,   -- lower runs first
  status        text        NOT NULL DEFAULT 'pending', -- pending|running|done|failed|dead
  attempts      smallint    NOT NULL DEFAULT 0,
  max_attempts  smallint    NOT NULL DEFAULT 6,
  run_after     timestamptz NOT NULL DEFAULT now(),
  locked_by     text,
  locked_at     timestamptz,
  last_error    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- One open job per (product, type). Re-queuing updates the existing row instead.
CREATE UNIQUE INDEX IF NOT EXISTS sync_jobs_dedupe ON sync_jobs (dedupe_key)
  WHERE status IN ('pending', 'running');
CREATE INDEX IF NOT EXISTS sync_jobs_claim ON sync_jobs (status, run_after, priority);
CREATE INDEX IF NOT EXISTS sync_jobs_stuck ON sync_jobs (locked_at)
  WHERE status = 'running';

-- ---------------------------------------------------------------- audit

CREATE TABLE IF NOT EXISTS sync_log (
  id           bigserial PRIMARY KEY,
  tenant_id    uuid        NOT NULL,
  product_id   bigint,
  job_id       bigint,
  action       text        NOT NULL,  -- PATCH_OFFER | PUT_STOCK | GET_OFFERS | TOKEN ...
  http_status  integer,
  request      jsonb,                 -- secrets redacted before write
  response     jsonb,
  duration_ms  integer,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sync_log_recent  ON sync_log (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS sync_log_product ON sync_log (product_id, created_at DESC);

CREATE TABLE IF NOT EXISTS dead_letters (
  id          bigserial PRIMARY KEY,
  tenant_id   uuid        NOT NULL,
  product_id  bigint,
  job_id      bigint,
  reason      text        NOT NULL,   -- BAD_REQUEST | PRICE_OUT_OF_RANGE | MAX_ATTEMPTS ...
  detail      jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);

CREATE INDEX IF NOT EXISTS dead_letters_open ON dead_letters (tenant_id, created_at DESC)
  WHERE resolved_at IS NULL;

-- ---------------------------------------------------------------- rate limiting

-- Shared token bucket so several worker processes cannot blow the same limit.
CREATE TABLE IF NOT EXISTS rate_buckets (
  tenant_id   uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  bucket      text        NOT NULL,   -- offers_write | offers_read | export | ...
  tokens      numeric     NOT NULL,
  capacity    numeric     NOT NULL,
  refill_per_sec numeric  NOT NULL,
  blocked_until  timestamptz,         -- set from Retry-After on 429
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, bucket)
);

-- ---------------------------------------------------------------- run bookkeeping

CREATE TABLE IF NOT EXISTS reconcile_runs (
  id              bigserial PRIMARY KEY,
  tenant_id       uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  mode            text        NOT NULL,  -- incremental | full
  since           timestamptz,
  offers_seen     integer     NOT NULL DEFAULT 0,
  drift_found     integer     NOT NULL DEFAULT 0,
  invisible_found integer     NOT NULL DEFAULT 0, -- correctedStock = 0 while we expect stock
  started_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz
);
