import { HttpClient } from '../lib/http.js';
import { loadConfig } from '../lib/config.js';
import type { Logger } from '../lib/logger.js';

/**
 * Shared eBay Browse API client (PRD §11.2). Used by both the eBay stock
 * adapter and the market-price subsystem (active listings). Handles OAuth
 * client-credentials token acquisition + refresh, and exposes typed helpers.
 */

const HOSTS = {
  production: { api: 'https://api.ebay.com', auth: 'https://api.ebay.com' },
  sandbox: { api: 'https://api.sandbox.ebay.com', auth: 'https://api.sandbox.ebay.com' },
} as const;

const BROWSE_SCOPE = 'https://api.ebay.com/oauth/api_scope';

export interface EbayItem {
  itemId: string;
  legacyItemId?: string;
  title: string;
  price: number | null;
  currency: string;
  image: string | null;
  url: string;
  quantityAvailable: number | null;
  availabilityStatus: string | null; // e.g. IN_STOCK / OUT_OF_STOCK
}

export interface EbaySummary {
  itemId: string;
  legacyItemId: string | null;
  title: string;
  price: number | null;
  currency: string;
  url: string;
  image: string | null;
}

export class EbayClient {
  private readonly http: HttpClient;
  private readonly logger?: Logger;
  private token: { value: string; expiresAt: number } | null = null;

  constructor(opts: { http?: HttpClient; logger?: Logger } = {}) {
    this.http = opts.http ?? new HttpClient({ logger: opts.logger });
    this.logger = opts.logger;
  }

  private hosts() {
    const env = loadConfig().ebay.env;
    return HOSTS[env];
  }

  /** Application access token via client-credentials grant, cached until expiry. */
  private async accessToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expiresAt - 60_000) {
      return this.token.value;
    }
    const cfg = loadConfig().ebay;
    if (!cfg.clientId || !cfg.clientSecret) {
      throw new Error('eBay adapter requires EBAY_CLIENT_ID and EBAY_CLIENT_SECRET');
    }
    const basic = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64');
    const res = await this.http.post(
      `${this.hosts().auth}/identity/v1/oauth2/token`,
      `grant_type=client_credentials&scope=${encodeURIComponent(BROWSE_SCOPE)}`,
      {
        headers: {
          Authorization: `Basic ${basic}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      },
    );
    const body = res.json<{ access_token: string; expires_in: number }>();
    this.token = {
      value: body.access_token,
      expiresAt: Date.now() + body.expires_in * 1000,
    };
    this.logger?.debug('refreshed eBay token', { expiresInSec: body.expires_in });
    return this.token.value;
  }

  private async authedGet<T>(path: string): Promise<T> {
    const token = await this.accessToken();
    const res = await this.http.get(`${this.hosts().api}${path}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
        Accept: 'application/json',
      },
    });
    return res.json<T>();
  }

  /** Fetch a single listing by its legacy (web) item id. */
  async getItemByLegacyId(legacyItemId: string): Promise<EbayItem> {
    const raw = await this.authedGet<RawItem>(
      `/buy/browse/v1/item/get_item_by_legacy_id?legacy_item_id=${encodeURIComponent(legacyItemId)}`,
    );
    return normalizeItem(raw, legacyItemId);
  }

  /**
   * Search active listings (used by market price + "new listing under $X"
   * saved-search watches). Returns summaries sorted by price ascending.
   * An optional `maxPrice` filters server-side (PRD §11.2: filter by price
   * server-side).
   */
  async search(
    query: string,
    opts: { limit?: number; maxPrice?: number } = {},
  ): Promise<EbaySummary[]> {
    const limit = opts.limit ?? 20;
    let path =
      `/buy/browse/v1/item_summary/search?q=${encodeURIComponent(query)}` +
      `&limit=${limit}&sort=price`;
    if (typeof opts.maxPrice === 'number') {
      path += `&filter=${encodeURIComponent(`price:[..${opts.maxPrice}],priceCurrency:USD`)}`;
    }
    const raw = await this.authedGet<RawSearch>(path);
    return (raw.itemSummaries ?? []).map((s) => ({
      itemId: s.itemId,
      legacyItemId: s.legacyItemId ?? null,
      title: s.title,
      price: s.price ? Number(s.price.value) : null,
      currency: s.price?.currency ?? 'USD',
      url: s.itemWebUrl ?? `https://www.ebay.com/itm/${s.legacyItemId ?? s.itemId}`,
      image: s.image?.imageUrl ?? s.thumbnailImages?.[0]?.imageUrl ?? null,
    }));
  }
}

// ----------------------------- raw payloads ---------------------------------

interface RawPrice {
  value: string;
  currency: string;
}

interface RawItem {
  itemId: string;
  legacyItemId?: string;
  title: string;
  price?: RawPrice;
  image?: { imageUrl?: string };
  itemWebUrl?: string;
  estimatedAvailabilities?: Array<{
    estimatedAvailabilityStatus?: string;
    estimatedAvailableQuantity?: number;
    availabilityThreshold?: number;
  }>;
}

interface RawSearch {
  itemSummaries?: Array<{
    itemId: string;
    legacyItemId?: string;
    title: string;
    price?: RawPrice;
    itemWebUrl?: string;
    image?: { imageUrl?: string };
    thumbnailImages?: Array<{ imageUrl?: string }>;
  }>;
}

function normalizeItem(raw: RawItem, legacyItemId: string): EbayItem {
  const avail = raw.estimatedAvailabilities?.[0];
  const qty =
    avail?.estimatedAvailableQuantity ?? avail?.availabilityThreshold ?? null;
  const status = avail?.estimatedAvailabilityStatus ?? null;
  return {
    itemId: raw.itemId,
    legacyItemId: raw.legacyItemId ?? legacyItemId,
    title: raw.title,
    price: raw.price ? Number(raw.price.value) : null,
    currency: raw.price?.currency ?? 'USD',
    image: raw.image?.imageUrl ?? null,
    url: raw.itemWebUrl ?? `https://www.ebay.com/itm/${legacyItemId}`,
    quantityAvailable: typeof qty === 'number' ? qty : null,
    availabilityStatus: status,
  };
}
