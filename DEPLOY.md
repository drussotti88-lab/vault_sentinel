# Deploying Sentinel to Fly.io

The worker (engine + Discord bot) is a **persistent process** — it must run 24/7,
not on serverless cron (PRD §21). Fly.io is the cheapest persistent host. The
optional read-only dashboard can still live on Vercel separately (it reads the
same Supabase); only the poller can't be serverless.

## Prerequisites

- A Fly.io account + `flyctl` installed (`curl -L https://fly.io/install.sh | sh`)
- A Supabase project with `supabase/schema.sql` applied
- A Discord application + bot (token, client id), invited to your guild with
  **Manage Channels** + **Manage Webhooks**
- (Optional) eBay developer keys, PriceCharting key, Walmart 3rd-party API key

## Steps

```bash
cd sentinel

# 1. Create the app (uses the committed fly.toml + Dockerfile). Don't deploy yet.
fly launch --no-deploy --copy-config --name sentinel

# 2. Set secrets (everything from .env.example EXCEPT the tuning vars already
#    in fly.toml's [env]). Secrets never go in the repo (PRD §20).
fly secrets set \
  DISCORD_BOT_TOKEN=... \
  DISCORD_CLIENT_ID=... \
  DISCORD_GUILD_ID=... \
  DISCORD_CATEGORY_ID=... \
  DISCORD_OPS_CHANNEL_ID=... \
  SUPABASE_URL=... \
  SUPABASE_SERVICE_KEY=... \
  EBAY_CLIENT_ID=... \
  EBAY_CLIENT_SECRET=...
# Optional extras when you fund them:
#   PRICECHARTING_API_KEY=...  PROXY_POOL_URL=...

# 3. Register the slash commands once (run locally with the same .env, or via
#    `fly ssh console` after first deploy):
npm run register-commands

# 4. Deploy and pin to exactly one always-on machine.
fly deploy
fly scale count 1

# 5. Watch it boot and start polling.
fly logs
```

## Operating

- **Logs**: `fly logs` (structured JSON; grep by `watchId` / `adapter`).
- **Restart**: `fly apps restart sentinel` (it also auto-restarts on crash).
- **Memory**: starts at 256MB. If it OOMs, `fly scale memory 512`.
- **Secrets rotation**: `fly secrets set EBAY_CLIENT_SECRET=...` redeploys.
- **Health**: the worker posts a heartbeat to `#ops`; `/status` shows per-adapter
  state from Discord.

## Cost note (be honest with yourself)

Fly's old always-free allowance has thinned over time; a single always-on
`shared-cpu-1x` 256MB machine is the cheapest option but may incur a small charge
(on the order of a couple dollars a month) depending on Fly's current pricing.
If you already run a VPS (e.g. for DNA Card Vault), co-locating there is the only
true $0 path and lets you share the `price_cache` table.
