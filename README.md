# Sentinel — Stock Checkers

A self-hosted monitoring service that watches online retail listings for target
products and posts a rich alert to a dedicated Discord channel the moment an item
transitions into stock at or below a user-set price threshold.

> **Detect-and-notify, human-in-the-loop.** Sentinel surfaces opportunities and
> gets a human to the buy page fast. It does **not** automate checkout, defeat
> anti-bot systems, or bypass virtual queues. (PRD §1, §24)

This implements the PRD *"Stock Checkers / Discord Alert System"* (codename
Sentinel). See `../da7a1773-stockcheckerdiscordprd.pdf` for the full spec.

## Architecture

```
Discord (Stock Checkers category)
  #target #ebay #walmart #pokemon-center #ops
        │ slash commands        ▲ embeds (webhooks)
        ▼                       │
   Bot process            Dispatcher
   (gateway, CRUD)        (embeds, webhook posts)
        │                       ▲
        ▼                       │ alert events
   ┌──────────────── Core engine (worker) ────────────────┐
   │ Scheduler → for each watch: resolve adapter → check() │
   │ → diff state → transition? → enrich(market price)     │
   │ → emit alert / update state                           │
   └───────┬─────────┬──────────┬───────────┬──────────────┘
        Target     eBay      Walmart    Pokémon Ctr   ← adapters (plugins)
        RedSky   Browse API  stealth    + queue sensor
                          │
                  Supabase (Postgres): retailers, watches, alerts,
                  price_cache, proxy_pool
                          │
                  Market-price subsystem (PriceCharting / eBay active median)
```

## Layout

| Path | Purpose |
| --- | --- |
| `src/index.ts` | Worker entrypoint — runs the engine **and** the bot |
| `src/core/` | Engine, scheduler, state machine, circuit breaker, ops reporter |
| `src/adapters/` | The adapter contract + Target / eBay / Walmart / Pokémon Center |
| `src/dispatcher/` | Embed renderer + webhook posting |
| `src/market/` | Shared TCG market-price subsystem (PriceCharting + eBay median) |
| `src/bot/` | Discord gateway, slash-command handlers, command registration |
| `src/db/` | Supabase client, row types, repositories |
| `src/lib/` | Config, logger, HTTP client, rate limiter, UA rotation, Discord REST |
| `supabase/schema.sql` | Postgres schema (PRD §13) |
| `dashboard/` | Optional read-only web dashboard for Vercel (Next.js) — see `dashboard/README.md` |

## Adapter reliability (PRD §11.5)

| Retailer | Method | Stock confidence | Anti-bot | Build order |
| --- | --- | --- | --- | --- |
| Target | RedSky internal JSON | exact | low | 1 |
| eBay | Official Browse API | exact | n/a (quotas) | 2 |
| Pokémon Center | endpoint + queue sensor | queue_gated / inferred | high | 3 |
| Walmart | 3rd-party API / stealth | inferred | high | 4 |

## Getting started

```bash
cd sentinel
npm install
cp .env.example .env        # fill in Discord + Supabase (+ eBay / PriceCharting)

# 1. Create the schema in your Supabase project
#    (paste supabase/schema.sql into the SQL editor, or use the Supabase CLI)

# 2. Register slash commands with your guild
npm run register-commands

# 3. Run the worker (engine + bot) — must be a persistent process
npm run dev          # tsx watch (local)
npm run build && npm start   # compiled
```

### Configuration

All secrets live in the environment, never in the repo or DB (PRD §20). See
`.env.example` for the full list. Per-retailer secrets (RedSky web key, store id,
third-party API keys, proxy refs) live in the retailer's `config` JSONB.

## Slash commands (PRD §15)

| Command | Effect |
| --- | --- |
| `/add-retailer name adapter channel [create_channel]` | Register a retailer; optionally auto-create the channel + webhook |
| `/add-item retailer url [threshold] [name] [interval] [tcg_sku]` | Resolve URL → product id, insert a watch. For eBay, pass an **item URL** to track one listing, or a **search URL** (`/sch/...&_nkw=...`) / `search:<query>` to watch "new listing under $threshold". |
| `/list-watches [retailer]` | List tracked items with status |
| `/remove-item id` · `/pause-item id` · `/resume-item id` | Lifecycle control |
| `/set-threshold id value` · `/set-interval id seconds` | Tuning |
| `/status` | Worker heartbeat + per-adapter health |
| `/check-now id` | Force an immediate poll (debug) |

The bot needs **Manage Channels** (for category/channel creation) and **Manage
Webhooks**.

## Catalog discovery — "new-product watcher" (pre-drop visibility)

Beyond watching a known product, you can watch a retailer's **catalog** and get a
`🆕` alert the moment a brand-new SKU appears — often days before it's buyable.
Create one through the normal `/add-item` (or the dashboard's Add-item form) by
passing a `discover:` directive as the URL instead of a product link:

| Retailer | Directive | Source |
| --- | --- | --- |
| Target | `discover:keyword:<term>` or `discover:category:<id>` | RedSky `plp_search_v2` (reliable; needs `config.apiKey`) |
| Pokémon Center | `discover:sitemap` or `discover:new-releases` | public product sitemap / new-releases page (best-effort; Cloudflare → wants a proxy) |

How it works: each scan diffs the listing against your existing watches; any new
product is added to your watch list **paused** and announced in the retailer's
channel. The first scan seeds silently (no alert storm); later scans announce.
Resume the paused items you actually want to stock-watch. Strictly read-only —
no anti-bot bypass, no queue circumvention (PRD §24).

## Adding a retailer (the unit of extension — PRD §10)

1. Implement `RetailerAdapter` (`resolve()` + `check()`) in `src/adapters/`.
2. Register it in `src/adapters/registry.ts`.

Nothing in the engine changes; the core never knows what a "Target" is.

## Deployment (PRD §21)

Run the worker as a **persistent process** on Railway / Fly.io / a small VPS with
auto-restart. Continuous sub-minute polling does **not** fit serverless cron
(timeouts, no persistent state, cold starts). Vercel is reserved for an optional
read-only dashboard, not the poller.

**Target host: Fly.io** — see [`DEPLOY.md`](./DEPLOY.md) for the full runbook
(`fly launch` → `fly secrets set` → `fly deploy` → `fly scale count 1`).
`Dockerfile`, `fly.toml`, and a `Procfile` (Railway fallback) are included.
Vercel **cannot** host the poller (serverless: timeouts, no persistent state) —
it's only for the optional dashboard. See `DECISIONS.md` for the cost breakdown
of every PRD §28 open question.

## Tests

```bash
npm test          # state-machine + URL-resolution smoke tests
npm run typecheck
```
