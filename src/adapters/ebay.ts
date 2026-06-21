import type { RetailerAdapter, CheckResult, AdapterContext, ResolveResult } from './types.js';
import { errorResult } from './types.js';
import { HttpError } from '../lib/http.js';
import { EbayClient } from './ebayClient.js';
import type { Watch } from '../db/types.js';

/**
 * eBay — reliability: HIGH (PRD §11.2). Official Browse API (Buy APIs):
 * legitimate, keyed, documented. Reads `quantityAvailable` => confidence
 * "exact". No anti-detection needed; quotas are the constraint, not detection.
 *
 * The same client also feeds the market-price subsystem (active listings).
 */

const SEARCH_PREFIX = 'search:';

function legacyIdFromUrl(url: string): string | null {
  // https://www.ebay.com/itm/123456789012  or  /itm/<slug>/123456789012
  const m = url.match(/\/itm\/(?:[^/]+\/)?(\d{9,})/);
  return m?.[1] ?? null;
}

/**
 * A saved-search watch ("new listing under $X", PRD §11.2 / §7 US?). Detected
 * from an eBay search URL (/sch/...&_nkw=) or an explicit `search:<query>` URL.
 * Returns the search query, or null for a normal listing watch.
 */
function searchQueryFromUrl(url: string): string | null {
  if (url.startsWith(SEARCH_PREFIX)) return url.slice(SEARCH_PREFIX.length).trim();
  const m = url.match(/[?&]_nkw=([^&]+)/);
  if (m?.[1]) return decodeURIComponent(m[1].replace(/\+/g, ' '));
  return null;
}

// One shared client per process is fine — it owns its own token cache.
let sharedClient: EbayClient | null = null;
function client(ctx: AdapterContext): EbayClient {
  if (!sharedClient) sharedClient = new EbayClient({ logger: ctx.logger });
  return sharedClient;
}

export const ebayAdapter: RetailerAdapter = {
  type: 'ebay',
  capabilities: {
    exactStockQty: true,
    addToCartDeepLink: false,
    requiresProxy: false,
    queueAware: false,
    marketPriceMapping: true,
  },

  async resolve(url: string, ctx: AdapterContext): Promise<ResolveResult> {
    // Saved-search watch: store the query, no per-item resolve needed.
    const query = searchQueryFromUrl(url);
    if (query) {
      return { productId: `${SEARCH_PREFIX}${query}`, displayName: `Search: ${query}` };
    }

    const legacyId = legacyIdFromUrl(url);
    if (!legacyId) throw new Error(`Could not extract an eBay item id from URL: ${url}`);

    await ctx.rateLimiter.acquire();
    const item = await client(ctx).getItemByLegacyId(legacyId);
    const result: ResolveResult = { productId: legacyId, displayName: item.title };
    if (item.image) result.image = item.image;
    return result;
  },

  async check(watch: Watch, ctx: AdapterContext): Promise<CheckResult> {
    if (watch.product_id.startsWith(SEARCH_PREFIX)) {
      return checkSearch(watch, ctx);
    }
    const legacyId = watch.product_id;
    await ctx.rateLimiter.acquire();
    try {
      const item = await client(ctx).getItemByLegacyId(legacyId);
      const qty = item.quantityAvailable;
      const inStock =
        item.availabilityStatus === 'IN_STOCK' || (typeof qty === 'number' && qty > 0);
      return {
        inStock,
        confidence: 'exact',
        price: item.price,
        currency: item.currency,
        name: item.title || watch.display_name || '',
        image: item.image ?? watch.image_url ?? null,
        url: item.url,
        addToCartUrl: null,
        stockQty: qty,
        queue: null,
        raw: { availabilityStatus: item.availabilityStatus },
      };
    } catch (err) {
      if (err instanceof HttpError) {
        return errorResult(watch.source_url, `http_${err.status}`, err.message, err.retryable);
      }
      return errorResult(watch.source_url, 'unknown', (err as Error).message, true);
    }
  },
};

/**
 * Saved-search watch poll. Finds the lowest-price active listing for the query
 * (filtered server-side by the watch threshold) and returns it as the current
 * "best buy". The state machine then alerts when a qualifying listing appears
 * (out -> in) and re-alerts when the best price drops further — i.e. a new,
 * cheaper listing under your threshold. No extra dedup state required.
 */
async function checkSearch(watch: Watch, ctx: AdapterContext): Promise<CheckResult> {
  const query = watch.product_id.slice(SEARCH_PREFIX.length);
  await ctx.rateLimiter.acquire();
  try {
    const opts: { limit: number; maxPrice?: number } = { limit: 10 };
    if (watch.threshold !== null) opts.maxPrice = watch.threshold;
    const results = await client(ctx).search(query, opts);
    const best = results
      .filter((r) => typeof r.price === 'number')
      .sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity))[0];

    if (!best) {
      // No qualifying listing right now -> "out" (no alert).
      return {
        inStock: false,
        confidence: 'inferred',
        price: null,
        currency: 'USD',
        name: watch.display_name ?? `Search: ${query}`,
        image: watch.image_url ?? null,
        url: watch.source_url,
        addToCartUrl: null,
        stockQty: null,
        queue: null,
      };
    }

    return {
      inStock: true,
      confidence: 'exact',
      price: best.price,
      currency: best.currency,
      name: best.title || watch.display_name || `Search: ${query}`,
      image: best.image ?? watch.image_url ?? null,
      url: best.url,
      addToCartUrl: null,
      stockQty: null,
      queue: null,
      raw: { query, candidates: results.length, bestItemId: best.itemId },
    };
  } catch (err) {
    if (err instanceof HttpError) {
      return errorResult(watch.source_url, `http_${err.status}`, err.message, err.retryable);
    }
    return errorResult(watch.source_url, 'unknown', (err as Error).message, true);
  }
}
