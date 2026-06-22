import type {
  RetailerAdapter,
  CheckResult,
  AdapterContext,
  ResolveResult,
  DiscoveredProduct,
} from './types.js';
import { errorResult, DISCOVER_PREFIX, isDiscoverDirective } from './types.js';
import { browserHeaders } from '../lib/userAgents.js';
import { HttpError } from '../lib/http.js';
import type { Watch } from '../db/types.js';

/**
 * Target — reliability: HIGH (PRD §11.1).
 *
 * Method: Target's internal RedSky data service (redsky.target.com), the same
 * JSON backend the site's own frontend calls. No HTML scraping.
 * Identifier: `tcin`, resolved from the product URL.
 * Stock signal: fulfillment endpoint returns structured availability =>
 *   confidence "exact". Quick links: add-to-cart deep link via cart URL.
 *
 * Config (retailer.config):
 *   apiKey  — RedSky web API key (the key Target's frontend embeds)
 *   storeId — preferred store id for store-level availability
 *   zip     — optional zip for location-scoped fulfillment
 */

const REDSKY_BASE = 'https://redsky.target.com/redsky_aggregations/v1/web';

/**
 * RedSky's edge (Akamai) commonly 403s requests that don't look like a real
 * browser XHR from target.com — so pair the browser UA with an Origin/Referer
 * of the site plus the modern client-hint + fetch-metadata headers Chrome sends.
 */
function redskyHeaders(ua: string): Record<string, string> {
  return {
    ...browserHeaders(ua),
    Origin: 'https://www.target.com',
    Referer: 'https://www.target.com/',
    'sec-ch-ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-site',
  };
}

function tcinFromUrl(url: string): string | null {
  // .../p/<slug>/-/A-91234567  (also tolerates a bare numeric id)
  const m = url.match(/\/A-(\d+)/i) ?? url.match(/(?:^|\/)(\d{6,})(?:\?|$)/);
  return m?.[1] ?? null;
}

interface RedskyConfig {
  apiKey: string;
  storeId: string;
  zip?: string;
}

function readConfig(ctx: AdapterContext): RedskyConfig {
  const apiKey = String(ctx.config.apiKey ?? '');
  const storeId = String(ctx.config.storeId ?? '');
  if (!apiKey) throw new Error('Target adapter requires config.apiKey (RedSky web key)');
  const cfg: RedskyConfig = { apiKey, storeId };
  if (typeof ctx.config.zip === 'string') cfg.zip = ctx.config.zip;
  return cfg;
}

function addToCartUrl(tcin: string): string {
  return `https://www.target.com/co-cart?tcin=${tcin}&qty=1`;
}

export const targetAdapter: RetailerAdapter = {
  type: 'target',
  capabilities: {
    exactStockQty: true,
    addToCartDeepLink: true,
    requiresProxy: false,
    queueAware: false,
    marketPriceMapping: true,
  },

  async resolve(url: string, ctx: AdapterContext): Promise<ResolveResult> {
    // Catalog-discovery watch (e.g. `discover:category:abc` or `discover:keyword:pokemon`).
    if (isDiscoverDirective(url)) {
      const directive = url.slice(DISCOVER_PREFIX.length).trim();
      return { productId: `${DISCOVER_PREFIX}${directive}`, displayName: `Discovery: ${directive}` };
    }

    const tcin = tcinFromUrl(url);
    if (!tcin) throw new Error(`Could not extract a tcin from URL: ${url}`);

    const cfg = readConfig(ctx);
    await ctx.rateLimiter.acquire();
    const ua = ctx.userAgent();
    const endpoint =
      `${REDSKY_BASE}/pdp_client_v1?key=${encodeURIComponent(cfg.apiKey)}` +
      `&tcin=${tcin}&store_id=${encodeURIComponent(cfg.storeId)}&pricing_store_id=${encodeURIComponent(cfg.storeId)}`;

    const res = await ctx.http.get(endpoint, { headers: redskyHeaders(ua) });
    const body = res.json<RedskyPdpResponse>();
    const item = body?.data?.product?.item;
    const name = item?.product_description?.title;
    const image = item?.enrichment?.images?.primary_image_url ?? undefined;

    const result: ResolveResult = { productId: tcin };
    if (name) result.displayName = decodeEntities(name);
    if (image) result.image = image;
    return result;
  },

  async check(watch: Watch, ctx: AdapterContext): Promise<CheckResult> {
    const tcin = watch.product_id;
    let cfg: RedskyConfig;
    try {
      cfg = readConfig(ctx);
    } catch (err) {
      return errorResult(watch.source_url, 'config', (err as Error).message, false);
    }

    await ctx.rateLimiter.acquire();
    const ua = ctx.userAgent();
    const headers = redskyHeaders(ua);

    try {
      // Product detail (name, price, image) + fulfillment (availability) in parallel.
      const pdpUrl =
        `${REDSKY_BASE}/pdp_client_v1?key=${encodeURIComponent(cfg.apiKey)}` +
        `&tcin=${tcin}&store_id=${encodeURIComponent(cfg.storeId)}&pricing_store_id=${encodeURIComponent(cfg.storeId)}`;
      const fulfillUrl =
        `${REDSKY_BASE}/pdp_fulfillment_v1?key=${encodeURIComponent(cfg.apiKey)}` +
        `&tcin=${tcin}&store_id=${encodeURIComponent(cfg.storeId)}&pricing_store_id=${encodeURIComponent(cfg.storeId)}` +
        (cfg.zip ? `&zip=${encodeURIComponent(cfg.zip)}` : '');

      const [pdpRes, fulfillRes] = await Promise.all([
        ctx.http.get(pdpUrl, { headers }),
        ctx.http.get(fulfillUrl, { headers }),
      ]);

      const pdp = pdpRes.json<RedskyPdpResponse>();
      const fulfill = fulfillRes.json<RedskyFulfillResponse>();

      const item = pdp?.data?.product?.item;
      const priceBlock = pdp?.data?.product?.price;
      const name = decodeEntities(item?.product_description?.title ?? watch.display_name ?? '');
      const image =
        item?.enrichment?.images?.primary_image_url ?? watch.image_url ?? null;
      const price =
        priceBlock?.current_retail ??
        priceBlock?.formatted_current_price_num ??
        null;

      const fulfillment = fulfill?.data?.product?.fulfillment;
      const shipping = fulfillment?.shipping_options;
      const network = fulfillment?.scheduled_delivery;

      // Online availability is the primary signal; store pickup as secondary.
      const shipStatus = shipping?.availability_status;
      const availableToShip = shipStatus === 'IN_STOCK' || shipStatus === 'LIMITED_STOCK';
      const qty = shipping?.available_to_promise_quantity ?? null;

      const inStock = availableToShip || network?.availability_status === 'IN_STOCK';

      return {
        inStock,
        confidence: 'exact',
        price: typeof price === 'number' ? price : null,
        currency: 'USD',
        name,
        image,
        url: watch.source_url,
        addToCartUrl: addToCartUrl(tcin),
        stockQty: typeof qty === 'number' ? qty : null,
        queue: null,
        raw: { shipStatus, qty },
      };
    } catch (err) {
      if (err instanceof HttpError) {
        return errorResult(
          watch.source_url,
          `http_${err.status}`,
          err.message,
          err.retryable,
        );
      }
      return errorResult(watch.source_url, 'unknown', (err as Error).message, true);
    }
  },

  /**
   * Catalog discovery via RedSky PLP search (`plp_search_v2`) — the same public
   * JSON the site's own search uses. Directive is `category:<id>` or
   * `keyword:<term>`; returns the current page of products so the engine can spot
   * newly-listed TCINs (often live before a product is publicly linked/buyable).
   */
  async discover(watch: Watch, ctx: AdapterContext): Promise<DiscoveredProduct[]> {
    const cfg = readConfig(ctx); // throws a clear error if apiKey is missing
    const directive = watch.product_id.slice(DISCOVER_PREFIX.length);
    const sep = directive.indexOf(':');
    const kind = sep === -1 ? directive : directive.slice(0, sep);
    const value = sep === -1 ? '' : directive.slice(sep + 1);
    if (!value) throw new Error('Target discovery needs `category:<id>` or `keyword:<term>`');

    await ctx.rateLimiter.acquire();
    const params = new URLSearchParams({
      key: cfg.apiKey,
      channel: 'WEB',
      count: '48',
      offset: '0',
      default_purchasability_filter: 'true',
    });
    if (cfg.storeId) {
      params.set('pricing_store_id', cfg.storeId);
      params.set('store_ids', cfg.storeId);
    }
    if (kind === 'keyword') params.set('keyword', value);
    else if (kind === 'category') params.set('category', value);
    else throw new Error(`Unknown Target discovery type "${kind}" (use category:<id> or keyword:<term>)`);

    const res = await ctx.http.get(`${REDSKY_BASE}/plp_search_v2?${params.toString()}`, {
      headers: redskyHeaders(ctx.userAgent()),
    });
    const body = res.json<RedskyPlpResponse>();
    const products = body?.data?.search?.products ?? [];
    const out: DiscoveredProduct[] = [];
    for (const p of products) {
      if (!p.tcin) continue;
      const tcin = String(p.tcin);
      out.push({
        productId: tcin,
        name: decodeEntities(p.item?.product_description?.title ?? `Target ${tcin}`),
        url: `https://www.target.com/p/-/A-${tcin}`,
        image: p.item?.enrichment?.images?.primary_image_url ?? null,
        price: p.price?.current_retail ?? null,
      });
    }
    return out;
  },
};

// --- Minimal typings for the RedSky payloads we read (defensive/optional). ---

interface RedskyPdpResponse {
  data?: {
    product?: {
      item?: {
        product_description?: { title?: string };
        enrichment?: { images?: { primary_image_url?: string } };
      };
      price?: {
        current_retail?: number;
        formatted_current_price_num?: number;
      };
    };
  };
}

interface RedskyPlpResponse {
  data?: {
    search?: {
      products?: Array<{
        tcin?: string;
        item?: {
          product_description?: { title?: string };
          enrichment?: { images?: { primary_image_url?: string } };
        };
        price?: { current_retail?: number };
      }>;
    };
  };
}

interface RedskyFulfillResponse {
  data?: {
    product?: {
      fulfillment?: {
        shipping_options?: {
          availability_status?: string;
          available_to_promise_quantity?: number;
        };
        scheduled_delivery?: { availability_status?: string };
      };
    };
  };
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}
