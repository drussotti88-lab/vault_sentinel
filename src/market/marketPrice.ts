import { HttpClient } from '../lib/http.js';
import { loadConfig } from '../lib/config.js';
import { priceCache } from '../db/repositories.js';
import { EbayClient } from '../adapters/ebayClient.js';
import type { Logger } from '../lib/logger.js';

/**
 * Market-price subsystem (PRD §12). Its own thing because it's shared with DNA
 * Card Vault and has a different cadence/caching than stock checks. Resolves a
 * TCG SKU to a current secondary-market value with a cache TTL (market price
 * doesn't move per-minute).
 *
 * Sources (PRD §12):
 *   - PriceCharting (strong sealed + graded coverage, has an API) — primary.
 *   - eBay active-listing median — fallback / ground truth on real transacted
 *     value. (Sold/completed data needs elevated eBay access; we plan for
 *     active-listing medians as the fallback if sold access isn't granted.)
 *
 * TCGplayer is intentionally NOT used (API access closed/deprecated, PRD §12).
 *
 * Interface: getMarketPrice(tcgSku) -> { value, currency, source, asOf, sampleSize? }
 */

export interface MarketPrice {
  value: number;
  currency: string;
  source: string;
  asOf: string;
  sampleSize?: number;
}

export class MarketPriceService {
  private readonly http: HttpClient;
  private readonly ebay: EbayClient;
  private readonly logger?: Logger;

  constructor(opts: { logger?: Logger; http?: HttpClient; ebay?: EbayClient } = {}) {
    this.http = opts.http ?? new HttpClient({ logger: opts.logger });
    this.ebay = opts.ebay ?? new EbayClient({ logger: opts.logger });
    this.logger = opts.logger;
  }

  /**
   * Returns a cached value when fresh, otherwise resolves a new one and caches
   * it. Returns null when no source can produce a value — callers must degrade
   * gracefully (PRD §19: a dead market-price source never blocks a stock alert).
   */
  async getMarketPrice(tcgSku: string): Promise<MarketPrice | null> {
    const cached = await this.readFreshCache(tcgSku);
    if (cached) return cached;

    const resolved = (await this.fromPriceCharting(tcgSku)) ?? (await this.fromEbayActive(tcgSku));
    if (!resolved) {
      this.logger?.warn('market price unavailable', { tcgSku });
      return null;
    }

    await this.writeCache(tcgSku, resolved);
    return resolved;
  }

  private async readFreshCache(tcgSku: string): Promise<MarketPrice | null> {
    try {
      const row = await priceCache.get(tcgSku);
      if (!row || row.value === null) return null;
      if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) return null;
      const out: MarketPrice = {
        value: row.value,
        currency: row.currency,
        source: row.source ?? 'cache',
        asOf: row.as_of ?? new Date().toISOString(),
      };
      if (row.sample_size !== null) out.sampleSize = row.sample_size;
      return out;
    } catch (err) {
      this.logger?.warn('price cache read failed', { tcgSku, error: (err as Error).message });
      return null;
    }
  }

  private async writeCache(tcgSku: string, price: MarketPrice): Promise<void> {
    const ttlSec = loadConfig().marketPrice.cacheTtlSec;
    try {
      await priceCache.upsert({
        tcg_sku: tcgSku,
        value: price.value,
        currency: price.currency,
        source: price.source,
        sample_size: price.sampleSize ?? null,
        as_of: price.asOf,
        expires_at: new Date(Date.now() + ttlSec * 1000).toISOString(),
      });
    } catch (err) {
      this.logger?.warn('price cache write failed', { tcgSku, error: (err as Error).message });
    }
  }

  /** PriceCharting lookup. `tcgSku` is treated as a PriceCharting product id. */
  private async fromPriceCharting(tcgSku: string): Promise<MarketPrice | null> {
    const key = loadConfig().marketPrice.priceChartingApiKey;
    if (!key) return null;
    try {
      const url = `https://www.pricecharting.com/api/product?t=${encodeURIComponent(key)}&id=${encodeURIComponent(tcgSku)}`;
      const res = await this.http.get(url, { headers: { Accept: 'application/json' } });
      const body = res.json<PriceChartingProduct>();
      // PriceCharting returns prices in pennies; prefer "new/sealed" price.
      const pennies = body['new-price'] ?? body['loose-price'] ?? null;
      if (typeof pennies !== 'number' || pennies <= 0) return null;
      return {
        value: pennies / 100,
        currency: 'USD',
        source: 'pricecharting',
        asOf: new Date().toISOString(),
      };
    } catch (err) {
      this.logger?.warn('pricecharting lookup failed', {
        tcgSku,
        error: (err as Error).message,
      });
      return null;
    }
  }

  /** eBay active-listing median fallback. `tcgSku` is treated as a search query. */
  private async fromEbayActive(tcgSku: string): Promise<MarketPrice | null> {
    try {
      const summaries = await this.ebay.search(tcgSku, { limit: 20 });
      const prices = summaries
        .map((s) => s.price)
        .filter((p): p is number => typeof p === 'number' && p > 0)
        .sort((a, b) => a - b);
      if (prices.length === 0) return null;
      const median = medianOf(prices);
      return {
        value: round2(median),
        currency: summaries[0]?.currency ?? 'USD',
        source: 'ebay_active_median',
        asOf: new Date().toISOString(),
        sampleSize: prices.length,
      };
    } catch (err) {
      this.logger?.warn('ebay market fallback failed', {
        tcgSku,
        error: (err as Error).message,
      });
      return null;
    }
  }
}

interface PriceChartingProduct {
  'new-price'?: number;
  'loose-price'?: number;
  'product-name'?: string;
}

function medianOf(sorted: number[]): number {
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) return (sorted[mid - 1]! + sorted[mid]!) / 2;
  return sorted[mid]!;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
