-- Sentinel / Stock Checkers — Supabase (Postgres) schema
-- PRD §13. Single-tenant v1, but multi-tenant-ready (add owner_id + RLS later).

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- Retailers and their Discord binding
-- ---------------------------------------------------------------------------
create table if not exists retailers (
  id                   uuid primary key default gen_random_uuid(),
  name                 text not null,
  adapter_type         text not null,          -- 'target' | 'ebay' | 'walmart' | 'pokemon_center'
  channel_id           text not null,          -- Discord channel
  webhook_url          text,                   -- per-channel webhook for fast posts
  config               jsonb not null default '{}'::jsonb,  -- keys, store ids, proxy ref, cadence
  default_interval_sec int not null default 45,
  enabled              boolean not null default true,
  created_at           timestamptz not null default now()
);

create index if not exists retailers_enabled_idx on retailers (enabled);

-- ---------------------------------------------------------------------------
-- Watched items
-- ---------------------------------------------------------------------------
create table if not exists watches (
  id            uuid primary key default gen_random_uuid(),
  retailer_id   uuid not null references retailers(id) on delete cascade,
  product_id    text not null,          -- adapter-canonical id (tcin, item id, slug)
  source_url    text not null,
  display_name  text,
  image_url     text,
  threshold     numeric,                -- alert only if price <= threshold (null = any)
  tcg_sku       text,                   -- optional, for market-price enrichment
  interval_sec  int,                    -- override; null = use retailer default
  last_status   text not null default 'unknown', -- 'in' | 'out' | 'unknown' | 'queue'
  last_price    numeric,
  last_checked  timestamptz,
  last_alerted  timestamptz,            -- for cooldown / dedup
  enabled       boolean not null default true,
  created_at    timestamptz not null default now()
);

create index if not exists watches_retailer_idx on watches (retailer_id);
create index if not exists watches_enabled_idx on watches (enabled);
create unique index if not exists watches_retailer_product_uq
  on watches (retailer_id, product_id);

-- ---------------------------------------------------------------------------
-- Alert log (dedup + audit + analytics)
-- ---------------------------------------------------------------------------
create table if not exists alerts (
  id            uuid primary key default gen_random_uuid(),
  watch_id      uuid not null references watches(id) on delete cascade,
  fired_at      timestamptz not null default now(),
  price         numeric,
  market_price  numeric,
  confidence    text,
  payload       jsonb                   -- snapshot of the CheckResult
);

create index if not exists alerts_watch_idx on alerts (watch_id, fired_at desc);

-- ---------------------------------------------------------------------------
-- Market-price cache (shared w/ DNA Card Vault)
-- ---------------------------------------------------------------------------
create table if not exists price_cache (
  tcg_sku       text primary key,
  value         numeric,
  currency      text not null default 'USD',
  source        text,
  sample_size   int,
  as_of         timestamptz,
  expires_at    timestamptz
);

-- ---------------------------------------------------------------------------
-- Optional: proxy/credential pool for hostile adapters
-- ---------------------------------------------------------------------------
create table if not exists proxy_pool (
  id            uuid primary key default gen_random_uuid(),
  endpoint      text not null,
  kind          text,                   -- 'residential' | 'datacenter'
  healthy       boolean not null default true,
  last_used     timestamptz
);
