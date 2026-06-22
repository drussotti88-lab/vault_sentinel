import type { Logger } from '../lib/logger.js';
import type { RateLimiter } from '../lib/rateLimiter.js';
import type { HttpClient } from '../lib/http.js';
import type { Watch, AdapterType } from '../db/types.js';

/**
 * The adapter contract — the extensibility core of the system (PRD §10).
 * Adding a retailer = implement RetailerAdapter + register it. Nothing in the
 * engine changes; the core never knows what a "Target" is.
 */

export type StockConfidence = 'exact' | 'inferred' | 'queue_gated' | 'unknown';

/**
 * Marker prefix for a catalog-discovery watch. Its `product_id` is
 * `discover:<directive>` (e.g. `discover:category:abc`), which the engine routes
 * to the adapter's `discover()` instead of the normal stock `check()`.
 */
export const DISCOVER_PREFIX = 'discover:';

export function isDiscoverDirective(s: string): boolean {
  return s.startsWith(DISCOVER_PREFIX);
}

/**
 * Parse a discovery product_id into its adapter directive and an optional
 * keyword filter. Syntax: `discover:<directive>~kw1,kw2,...` — e.g.
 * `discover:sitemap~booster,elite trainer,tin`. The engine applies the filters
 * (case-insensitive substring match on a product's name/url) so a catalog scan
 * can be narrowed to, say, TCG products only.
 */
export function parseDiscover(productId: string): { directive: string; filters: string[] } {
  const raw = productId.startsWith(DISCOVER_PREFIX)
    ? productId.slice(DISCOVER_PREFIX.length)
    : productId;
  const i = raw.indexOf('~');
  if (i === -1) return { directive: raw.trim(), filters: [] };
  const filters = raw
    .slice(i + 1)
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return { directive: raw.slice(0, i).trim(), filters };
}

export interface AdapterCapabilities {
  /** Adapter can report an exact remaining quantity. */
  exactStockQty: boolean;
  /** Adapter can produce an add-to-cart deep link. */
  addToCartDeepLink: boolean;
  /** Adapter must route requests through the proxy pool. */
  requiresProxy: boolean;
  /** Adapter understands virtual-queue / waiting-room state (Pokémon Center). */
  queueAware: boolean;
  /** Adapter can map the product to a TCG SKU for market-price enrichment. */
  marketPriceMapping: boolean;
}

export interface QueueState {
  active: boolean;
  position?: number;
  estimatedWaitSec?: number;
}

/** Normalized output of a single poll. The engine speaks only this shape. */
export interface CheckResult {
  inStock: boolean;
  confidence: StockConfidence;
  price: number | null; // current retail price
  currency: string; // "USD"
  name: string;
  image: string | null;
  url: string; // canonical product URL
  addToCartUrl: string | null; // deep link, if supported
  stockQty: number | null; // when confidence === "exact"
  queue?: QueueState | null; // populated only by queue-aware adapters
  raw?: unknown; // adapter-specific payload for debugging
  error?: { code: string; retryable: boolean; message: string };
}

export interface ResolveResult {
  productId: string;
  displayName?: string;
  image?: string;
}

/**
 * A product surfaced by catalog discovery (a "new-product watcher" source).
 * The engine diffs these against existing watches to spot brand-new SKUs.
 */
export interface DiscoveredProduct {
  productId: string;
  name: string;
  url: string;
  image?: string | null;
  price?: number | null;
}

/** Shared services handed to every adapter call. */
export interface AdapterContext {
  http: HttpClient;
  rateLimiter: RateLimiter;
  logger: Logger;
  /** Per-retailer structured config (api keys, store ids, proxy ref, cadence). */
  config: Record<string, unknown>;
  /** Returns a realistic, rotating User-Agent string. */
  userAgent(): string;
}

export interface RetailerAdapter {
  type: AdapterType;
  capabilities: AdapterCapabilities;

  /** Turn a user-supplied URL into the stable identifier this adapter polls on. */
  resolve(url: string, ctx: AdapterContext): Promise<ResolveResult>;

  /** The hot path. Called every poll cycle. */
  check(watch: Watch, ctx: AdapterContext): Promise<CheckResult>;

  /**
   * Optional catalog discovery (PRD §21 stretch: pre-drop visibility). Given a
   * discovery watch (`product_id` like `discover:<directive>`), return the
   * current set of products in that listing/category/sitemap. The engine diffs
   * the result against existing watches and surfaces brand-new SKUs. Read-only.
   */
  discover?(watch: Watch, ctx: AdapterContext): Promise<DiscoveredProduct[]>;
}

/** Helper for adapters to return a uniform error CheckResult. */
export function errorResult(
  url: string,
  code: string,
  message: string,
  retryable = true,
): CheckResult {
  return {
    inStock: false,
    confidence: 'unknown',
    price: null,
    currency: 'USD',
    name: '',
    image: null,
    url,
    addToCartUrl: null,
    stockQty: null,
    queue: null,
    error: { code, retryable, message },
  };
}
