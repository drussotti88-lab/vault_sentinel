# Proxy Shopper 2.0

An intelligent purchase assistant, packaged as a Chrome extension. It continuously monitors products you care about, alerts you when price or stock conditions are met, and assists you through the buying process — without ever bypassing retailer protections or completing checkout for you.

**Phase 1 retailer:** Target.com. The retailer adapter architecture is designed so new retailers (Walmart, TCGplayer, Pokémon Center, Best Buy, Amazon, …) can be added without touching core logic.

---

## Quick start

```powershell
npm install
npm run build
```

Then load it into Chrome:

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select the **`dist/`** folder (not the project root).
4. Pin "Proxy Shopper 2.0" to the toolbar for easy access.

After every `npm run build`, click the ↻ reload button on the extension card in `chrome://extensions`.

> Requires Chrome 116+ (uses the Offscreen Documents API).

## Scripts

| Script | Purpose |
| --- | --- |
| `npm run build` | Type-check, then build everything into `dist/` |
| `npm run typecheck` | TypeScript check only |
| `npm run icons` | Regenerate the PNG icons into `public/icons/` |

---

## How it works

```
┌─────────────┐   alarms (every N min)   ┌──────────────────────────────┐
│  Background  │ ───────────────────────▶ │ monitor: per watched product │
│  service     │                          │  1. adapter.fetchProductData │
│  worker      │                          │  2. fallback: fetch HTML +   │
└──────┬──────┘                           │     offscreen DOMParser +    │
       │                                  │     adapter.extractProductData│
       │ compare old vs new state         └──────────────────────────────┘
       ▼
  notifications (quiet-hours aware) ──▶ Proxy Assist (flag URL, optionally
       │                                 open tab; content script highlights
       ▼                                 purchase buttons — never clicks them)
  chrome.storage.local (watchlist + settings) ◀──▶ popup / options (React)
```

### Identifier-first architecture

The core system stores and reasons about products as **(retailerId, productId)** pairs — never URLs. For Target the `productId` is the **TCIN** (Target Catalog Item Number), the `A-<number>` in every product URL. Each adapter is the only component that knows how to translate between the two:

```
retailer URL  →  adapter.extractProductId()  →  productId (TCIN)
productId      →  adapter.buildProductUrl()   →  navigation URL (slug is cosmetic)
```

This makes the extension resilient to URL/slug changes, faster (the TCIN is the cache/dedup key), and trivial to extend — a new retailer just maps *its* URLs to *its* product id (Walmart Item ID, TCGplayer Product ID, Pokémon Center SKU, …). Watchlist records persisted by an older URL-based build are migrated to the id-based shape automatically on first read.

- **Watchlist + settings** live in `chrome.storage.local`; the popup and options pages subscribe to `storage.onChanged`, so every surface updates live.
- **Background checks** run on a `chrome.alarms` schedule (user-configurable interval). Products are checked sequentially with a delay between requests to stay polite.
- **Target specifics:** Target renders price/availability client-side, so fetched HTML alone doesn't contain them. The adapter therefore makes the same call the product page itself makes — Target's public product API (`redsky.target.com`) with the public API key embedded in the page HTML. No credentials, no protected endpoints, no rate-limit evasion. If that fails, it falls back to parsing the fetched HTML (name/image via Open Graph, price/stock where present) via the offscreen document.
- **Live page updates:** when you browse a watched product on Target, the content script extracts data from the hydrated DOM (the most accurate source) and silently refreshes the stored state.
- **Proxy Assist Mode:** when a target-price hit or restock fires, the product is flagged (and optionally a tab is opened in the background). When you land on that page, the content script shows a banner and pulse-highlights the shipping/pickup buttons and scrolls them into view. It never adds to cart or checks out.

## File-by-file guide

### Tooling & configuration

| File | What it does |
| --- | --- |
| `package.json` | Dependencies (React 18, Vite 6, TypeScript 5) and build scripts |
| `tsconfig.json` | Strict TypeScript config with Chrome extension types |
| `vite.config.ts` | Main build: popup, options, offscreen page, background worker |
| `vite.content.config.ts` | Separate IIFE build for the content script (content scripts can't be ES modules) |
| `public/manifest.json` | Chrome Manifest V3: permissions, service worker, content script, icons |
| `scripts/generate-icons.mjs` | Generates the PNG icons programmatically (zero image dependencies) |

### Types (`src/types/`)

| File | What it does |
| --- | --- |
| `product.ts` | `ProductData` (an extraction snapshot), `WatchedProduct` (persisted watchlist entry), `AvailabilityStatus` |
| `settings.ts` | `UserSettings` + `DEFAULT_SETTINGS` |
| `messages.ts` | Typed message contracts between popup ⇄ background ⇄ content ⇄ offscreen |

### Retailer adapters (`src/retailers/`)

| File | What it does |
| --- | --- |
| `RetailerAdapter.ts` | The adapter interface every retailer implements (`matchesUrl`, `extractProductId`, `buildProductUrl`, `extractProductData`, optional `fetchProductData`) |
| `registry.ts` | The only place that knows which adapters exist. **Add a retailer = implement the interface + add one line here.** |
| `target/targetAdapter.ts` | Target adapter. Resolves the **TCIN** from any URL shape (`/-/A-123`, `/slug/A-123`, query strings) or from the live DOM (canonical link, meta, embedded JSON). DOM extraction is layered — live `data-test` selectors → JSON-LD → embedded `__TGT_DATA__` regexes → Open Graph — each field falling back independently to `undefined`/`"unknown"`. Background path uses Target's own public product API keyed by TCIN. |

### Background (`src/background/`)

| File | What it does |
| --- | --- |
| `index.ts` | Service-worker entry: alarm scheduling, message routing, notification click handling |
| `monitor.ts` | The check loop: fetch → extract → merge → save → alert. Also the toolbar badge (count of products currently meeting their conditions) |
| `notifications.ts` | Decides which alert (if any) a state change warrants — target-price hit > restock > availability change > price change — and shows it, respecting quiet hours |
| `assist.ts` | Proxy Assist bookkeeping: flags opportunity URLs in `chrome.storage.session`, optionally auto-opens the product page, answers content-script queries |
| `offscreenClient.ts` | Creates/reuses the offscreen document and asks it to parse fetched HTML (service workers have no `DOMParser`) |

### Offscreen (`src/offscreen/`)

| File | What it does |
| --- | --- |
| `offscreen.html` / `index.ts` | Invisible page that parses fetched HTML with `DOMParser` and runs the adapter against it |

### Content script (`src/content/`)

| File | What it does |
| --- | --- |
| `index.ts` | On Target product pages: extracts live data (with hydration retries) and reports it; renders the Proxy Assist banner + button highlights; handles Target's client-side navigation |

### UI (`src/popup/`, `src/options/`, `src/components/`, `src/hooks/`)

| File | What it does |
| --- | --- |
| `popup/Popup.tsx` | Popup shell: header (Check all, settings), add form, watchlist |
| `components/AddProductForm.tsx` | URL + desired-price form with validation (supported retailer, no duplicates) |
| `components/ProductCard.tsx` | Image, name, current/original/target price, status badge, last-checked time; Open / Refresh / Edit (inline) / Remove (two-click confirm) |
| `components/StatusBadge.tsx` | In stock / Out of stock / Unknown pill |
| `hooks/useWatchlist.ts` | Watchlist state + add/update/delete/refresh actions, live storage subscription |
| `hooks/useSettings.ts` | Settings state + persistence |
| `options/Options.tsx` | Monitoring interval, notification toggles, quiet hours, Proxy Assist, export/import/clear data |

### Shared & utilities

| File | What it does |
| --- | --- |
| `shared/storage.ts` | Typed CRUD over `chrome.storage.local`, change subscriptions, export/import/clear |
| `utils/format.ts` | Price/time formatting, `$`-string parsing |
| `utils/quietHours.ts` | Quiet-hours check (handles ranges spanning midnight) |
| `utils/id.ts` | Unique id generation |

---

## Testing it

1. **Add a product.** Open the popup, paste any Target product URL (`https://www.target.com/p/...`), set a desired price, click **Watch**. Within a few seconds the card should fill in with the real name, image, price, and availability.
   - To see an instant "target price hit" alert: set the desired price *above* the current price, then click **Refresh** on the card.
2. **Notifications.** Make sure Chrome notifications aren't suppressed by Windows Focus Assist. Trigger a hit as above — you should get a notification with an **Open product** button.
3. **Background monitoring.** Leave Chrome open; checks run automatically at the configured interval (Options → Monitoring). The "checked Xm ago" line on each card confirms it's running. You can inspect the service worker via `chrome://extensions` → "Inspect views: service worker".
4. **Live page sync.** Visit a watched product's page on Target; within ~5 seconds the stored price/stock silently refresh from the live DOM.
5. **Proxy Assist.** With assist enabled (Options), trigger a target-price hit, then open the product page (via the notification or popup). You should see the purple banner and pulsing highlight on the Add-to-cart/Pickup buttons. Enable "Automatically open the product page" to have a background tab opened for you on the next hit.
6. **Quiet hours.** Set a quiet range covering "now", trigger a hit — no notification should appear (the watchlist still updates).
7. **Export/import.** Options → Export downloads a JSON snapshot; Import merges it back; Clear wipes everything (two-click confirm).

## Known limitations

- **Selector/API drift.** Retailer markup and embedded data change without notice. The layered extraction degrades to "Unknown" rather than breaking, but a major Target redesign could require updating `targetAdapter.ts`.
- **Price/stock need the product API.** Target doesn't server-render price; if the `redsky` endpoint shape or key changes, background checks will show name/image but "Unknown" availability until the adapter is updated. (Live-page extraction keeps working regardless.)
- **Store-specific stock.** Availability reflects Target's general online signals; in-store pickup availability at *your* store may differ (no store is configured).
- **Chrome must be running** for alarms, checks, and notifications. The minimum check interval is 1 minute (Chrome alarms limit); checks may be delayed slightly when the service worker is asleep.
- **Notification look** depends on OS settings (Windows action-center rules apply).
- **No checkout automation, by design.** Proxy Assist navigates and highlights only.

## Recommendations for future improvements

1. **More retailers** — the adapter interface is ready; Walmart and Best Buy also expose structured data on product pages.
2. **Price history** — store a per-product time series and render a sparkline on the card.
3. **Per-store pickup** — let users pick a Target store and pass `store_id`/`pricing_store_id` for accurate pickup availability.
4. **Variant support** — size/color variants currently resolve to the page's default variant.
5. **Unit tests** — the adapter layers are pure functions over `Document`/JSON; add Vitest + fixture HTML pages to lock in extraction behavior.
6. **Sync storage / account** — `chrome.storage.sync` (or a backend) to share the watchlist across devices.
7. **Snooze & per-product quiet rules** — "don't alert me about this one until tomorrow".
8. **Badge & popup sorting** — sort hot deals to the top; richer filtering once watchlists grow.
