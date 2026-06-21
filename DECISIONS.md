# Open-question decisions (PRD §28)

Policy: **free-first**, unless going free removes meaningful function. Anything
that still costs money is listed at the bottom.

| # | Question | Decision | Cost |
| --- | --- | --- | --- |
| 1 | Walmart: paid stock API vs. residential proxies | **Free best-effort stealth fallback** now (already built); paid API is a drop-in upgrade via `config.stockApiUrl` when/if funded. | Free (paid optional) |
| 2 | eBay: specific listings only, or "new listing under $X" saved searches | **Both.** Added saved-search watches — paste an eBay search URL (or `search:<query>`) into `/add-item`. The Browse API is free (quota-limited). | Free |
| 3 | Market-price granularity (sealed-only vs. singles via Scrydex) | **Sealed-first using the free eBay active-listing median** as the always-on source; PriceCharting is used automatically only if a key is present. Singles/Scrydex deferred. | Free (PriceCharting optional) |
| 4 | Monetization timing (single-user vs. multi-tenant now) | **Single-tenant v1.** Schema is already multi-tenant-*ready*; add `owner_id` + RLS only when opening to others. No cost, no function lost now. | Free |
| 5 | Hosting (Railway vs. Fly vs. VPS) | **Fly.io** (chosen). Worker config in `fly.toml`; full runbook in `DEPLOY.md`. Vercel can't host the poller (serverless: timeouts, no persistent state) — only the optional dashboard. | Cheapest persistent option; may be a couple $/mo (Fly's free allowance has thinned) |
| 6 | Channel auto-creation on `/add-retailer` | **Auto-create by default** (creates the channel under the category + a webhook). Still bindable to an existing channel by passing `channel:`. | Free |

## How free-first shows up in the code
- **Market price** tries the free eBay median whenever no PriceCharting key is
  set — a dead/absent paid source never blocks a stock alert (PRD §19).
- **Walmart** runs the free stealth path unless `config.stockApiUrl` is provided.
- **eBay** (stock + saved-search + market) runs entirely on the free,
  quota-limited Browse API.
- **Supabase** and **Discord** are on their free tiers for a single-guild v1.

## What still needs to be paid — see end of this file / chat summary.

### Still-paid items (only if you want the extra function)
1. **Hosting (the one likely unavoidable cost)** — a persistent 24/7 process.
   Free *only* if you co-locate on a VPS you already pay for (e.g. DNA Card
   Vault's host). Otherwise ~$5/mo (Railway) or Fly.io's paid usage. **Not**
   serverless — Vercel cron won't work (PRD §21).
2. **PriceCharting API** *(optional)* — better sealed/graded coverage than the
   free eBay median. The system works without it.
3. **Walmart reliability** *(optional)* — a paid 3rd-party stock API or
   residential rotating proxies. Without it, Walmart stays free best-effort/LOW.
4. **eBay sold/completed data** *(optional, later)* — needs elevated API access
   (Marketplace Insights). Free active-listing medians are the fallback.
5. **Scrydex / singles pricing** *(optional, deferred)* — only if you extend
   market price beyond sealed product.
