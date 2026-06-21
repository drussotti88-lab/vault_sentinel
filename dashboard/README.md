# Sentinel dashboard (Vercel)

Optional **read-only** web view of Sentinel's state — retailers, watches, and
recent alerts — pulled live from Supabase (PRD §21 stretch goal). This is the one
piece that fits Vercel; the poller itself runs on Fly.io (see `../DEPLOY.md`).

All writes still happen through Discord slash commands. This app never mutates
anything and uses a **read-only** Supabase key (never the worker's service key).

## Local dev

```bash
cd sentinel/dashboard
npm install
cp .env.example .env.local   # SUPABASE_URL + SUPABASE_READONLY_KEY
npm run dev                  # http://localhost:3000
```

## Deploy on Vercel

Deploy as a **separate Vercel project** from your DFW demo:

1. New Project → import this repo.
2. **Root Directory:** `sentinel/dashboard`.
3. Environment variables: `SUPABASE_URL`, `SUPABASE_READONLY_KEY`.
4. Deploy.

Framework preset auto-detects Next.js; no extra build config needed.

## The read-only key

v1 has no RLS, so give the dashboard a key that can only *read*:

- Simplest: grant `select` on `retailers`, `watches`, `alerts` to the `anon`
  role and use the anon key, **or**
- Create a dedicated read-only Postgres role + key.

Either way, do **not** put the worker's `SUPABASE_SERVICE_KEY` here (PRD §20).
The key is used only in server components, so it never reaches the browser — but
a least-privilege key is still the right call.
