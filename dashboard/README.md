# Sentinel dashboard (Vercel)

A password-gated **control panel** for Sentinel — view retailers, watches, and
recent alerts, and **manage the watch list** (add / remove / pause / resume
items, adjust threshold + interval) from the web. Reads come straight from
Supabase with a read-only key; every *change* is sent server-side to the
worker's control API, so the browser never holds a write credential (PRD §20).
Alerts keep firing in your Discord channels exactly as before.

## How it fits together

```
You (browser) --login--> Dashboard (Vercel) --server-side, bearer token--> Worker control API (Railway)
                              |                                                   |
                       read-only Supabase key (page data)                 service key + adapters
```

## Environment variables

| Variable | Where | Purpose |
| --- | --- | --- |
| `SUPABASE_URL` | reads | Your Supabase project URL |
| `SUPABASE_READONLY_KEY` | reads | A **read-only** key (never the worker's service key) |
| `CONTROL_API_URL` | writes | The worker's public URL, e.g. `https://worker-production-xxxx.up.railway.app` |
| `CONTROL_API_TOKEN` | writes | Must match the worker's `CONTROL_API_TOKEN` |
| `DASHBOARD_ACCESS_CODE` | login | The code you type to sign in |

Without `CONTROL_API_URL` / `CONTROL_API_TOKEN` the panel runs view-only.
Without `DASHBOARD_ACCESS_CODE` the site stays locked (fails closed).

## Local dev

```bash
cd dashboard
npm install
cp .env.example .env.local   # fill in the variables above
npm run dev                  # http://localhost:3000
```

## Deploy on Vercel

Deploy as a **separate Vercel project** from the worker:

1. New Project → import this repo.
2. **Root Directory:** `dashboard`.
3. Add the environment variables from the table above.
4. Deploy.

Framework preset auto-detects Next.js; no extra build config needed.

## The read-only key

v1 has no RLS, so give the dashboard a key that can only *read*. Simplest: use
the project's `anon` key (Supabase → Project Settings → API). Never put the
worker's `SUPABASE_SERVICE_KEY` here — writes go through the control API, which
holds the service key on the worker side (PRD §20).
