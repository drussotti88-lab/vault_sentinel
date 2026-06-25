import type { ProductData } from "../types";

/**
 * Contract every retailer integration must fulfil.
 *
 * The architecture is identifier-first: the core system stores and reasons
 * about products as (retailerId, productId) pairs and never depends on
 * retailer URLs. Each adapter is the only thing that knows how to translate
 *
 *     retailer URL  →  retailer product id  →  navigation URL
 *
 * so new retailers are added by implementing this interface and registering
 * the instance in registry.ts — no core changes required.
 */
export interface RetailerAdapter {
  retailerId: string;
  retailerName: string;

  /** Does this URL belong to a product page on this retailer? */
  matchesUrl(url: string): boolean;

  /**
   * Resolve a retailer product id from a URL and/or a live page. For Target
   * this is the TCIN. Returns null if no id can be determined. The document
   * is optional — when present (a live product page), the adapter may inspect
   * the DOM as a fallback when the URL alone is insufficient.
   */
  extractProductId(url: string, document?: Document): Promise<string | null>;

  /**
   * Build a navigation URL for a product id. The slug is cosmetic; only the
   * id portion is load-bearing.
   */
  buildProductUrl(productId: string): string;

  /**
   * Extract product information from a parsed page. The document may be a
   * live, hydrated page (content script) or the parsed raw HTML of a fetched
   * page (offscreen document) — adapters must tolerate both and degrade to
   * "unknown" instead of throwing. `productId` is supplied so the result can
   * be stamped with identity even when the page itself is ambiguous.
   */
  extractProductData(document: Document, productId: string, url?: string): Promise<ProductData>;

  /**
   * Optional richer background check, used by the monitor in preference to
   * fetch + extractProductData when present. Needed for retailers (like
   * Target) that render price/availability client-side, so the raw HTML of a
   * fetched page does not contain them. Implementations should only call the
   * same public endpoints the retailer's own product page calls. Runs in the
   * service worker — no DOM. May throw; the monitor then falls back to
   * fetch + offscreen parsing.
   */
  fetchProductData?(productId: string): Promise<ProductData>;
}
