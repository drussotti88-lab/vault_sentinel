import type { RetailerAdapter, CheckResult, AdapterContext, ResolveResult } from './types.js';
import { errorResult } from './types.js';
import { browserHeaders } from '../lib/userAgents.js';
import { HttpError } from '../lib/http.js';
import type { Watch } from '../db/types.js';

/**
 * Walmart — reliability: BEST-EFFORT / LOW (PRD §11.3). Heavy bot mitigation
 * (HUMAN/PerimeterX-class); the internal API is guarded and plain HTML scraping
 * is blocked quickly. Stock signal is typically "inferred" (available/
 * unavailable), rarely exact qty. Conservative cadence to avoid burning proxies.
 *
 * Options, in order of preference (PRD §11.3):
 *   1. A reputable third-party stock/price API (config.stockApiUrl) — most
 *      reliable, least maintenance. Preferred.
 *   2. Stealth fetch through residential rotating proxies (requiresProxy) —
 *      higher maintenance, breaks on site changes. Fallback.
 *
 * Config (retailer.config):
 *   stockApiUrl — third-party API template with {itemId}; returns
 *                 { inStock, price, name, image }
 *   apiKey      — third-party API key (sent as ?apiKey= / Bearer per provider)
 */

function itemIdFromUrl(url: string): string | null {
  // https://www.walmart.com/ip/<slug>/123456789
  const m = url.match(/\/ip\/(?:[^/]+\/)?(\d{6,})/);
  return m?.[1] ?? null;
}

interface WalmartConfig {
  stockApiUrl?: string;
  apiKey?: string;
}

function readConfig(ctx: AdapterContext): WalmartConfig {
  const cfg: WalmartConfig = {};
  if (typeof ctx.config.stockApiUrl === 'string') cfg.stockApiUrl = ctx.config.stockApiUrl;
  if (typeof ctx.config.apiKey === 'string') cfg.apiKey = ctx.config.apiKey;
  return cfg;
}

export const walmartAdapter: RetailerAdapter = {
  type: 'walmart',
  capabilities: {
    exactStockQty: false,
    addToCartDeepLink: false,
    requiresProxy: true,
    queueAware: false,
    marketPriceMapping: true,
  },

  async resolve(url: string): Promise<ResolveResult> {
    const itemId = itemIdFromUrl(url);
    if (!itemId) throw new Error(`Could not extract a Walmart item id from URL: ${url}`);
    return { productId: itemId };
  },

  async check(watch: Watch, ctx: AdapterContext): Promise<CheckResult> {
    const cfg = readConfig(ctx);
    await ctx.rateLimiter.acquire();

    // Preferred path: third-party stock/price API.
    if (cfg.stockApiUrl) {
      const url = cfg.stockApiUrl
        .replace('{itemId}', encodeURIComponent(watch.product_id))
        .replace('{apiKey}', encodeURIComponent(cfg.apiKey ?? ''));
      try {
        const headers: Record<string, string> = { Accept: 'application/json' };
        if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
        const res = await ctx.http.get(url, { headers });
        const body = res.json<WalmartApiResponse>();
        const inStock = Boolean(body.inStock ?? body.available);
        return {
          inStock,
          confidence: 'inferred',
          price: typeof body.price === 'number' ? body.price : watch.last_price,
          currency: 'USD',
          name: body.name ?? watch.display_name ?? 'Walmart item',
          image: body.image ?? watch.image_url ?? null,
          url: watch.source_url,
          addToCartUrl: null,
          stockQty: null,
          queue: null,
          raw: body,
        };
      } catch (err) {
        if (err instanceof HttpError) {
          return errorResult(watch.source_url, `http_${err.status}`, err.message, err.retryable);
        }
        return errorResult(watch.source_url, 'unknown', (err as Error).message, true);
      }
    }

    // Fallback: stealth fetch of the product page through proxies. Best-effort;
    // if mitigation blocks us we surface an honest, retryable error.
    try {
      const res = await ctx.http.get(watch.source_url, {
        headers: browserHeaders(ctx.userAgent()),
        retries: 1,
      });
      const blocked = /captcha|px-captcha|access denied|robot or human/i.test(res.text);
      if (blocked) {
        return errorResult(watch.source_url, 'bot_mitigation', 'Blocked by bot mitigation', true);
      }
      // Look for the embedded JSON availability hint in the page.
      const inStock = /"availabilityStatus"\s*:\s*"IN_STOCK"/i.test(res.text);
      const priceMatch = res.text.match(/"price"\s*:\s*([0-9]+(?:\.[0-9]+)?)/);
      const price = priceMatch ? Number(priceMatch[1]) : watch.last_price;
      return {
        inStock,
        confidence: 'inferred',
        price,
        currency: 'USD',
        name: watch.display_name ?? 'Walmart item',
        image: watch.image_url ?? null,
        url: watch.source_url,
        addToCartUrl: null,
        stockQty: null,
        queue: null,
      };
    } catch (err) {
      if (err instanceof HttpError) {
        return errorResult(watch.source_url, `http_${err.status}`, err.message, err.retryable);
      }
      return errorResult(watch.source_url, 'unknown', (err as Error).message, true);
    }
  },
};

interface WalmartApiResponse {
  inStock?: boolean;
  available?: boolean;
  price?: number;
  name?: string;
  image?: string;
}
