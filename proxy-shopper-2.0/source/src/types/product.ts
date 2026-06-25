/** Availability states the system can detect. */
export type AvailabilityStatus = "in_stock" | "out_of_stock" | "unknown";

/**
 * A snapshot of product information as extracted from a retailer page or API.
 * Produced by a RetailerAdapter; never persisted directly (it is merged into
 * a WatchedProduct). Identified by retailer + product id, never by URL.
 */
export interface ProductData {
  retailerId: string;
  productId: string;

  productName: string;
  imageUrl?: string;

  currentPrice?: number;
  originalPrice?: number;

  availabilityStatus: AvailabilityStatus;

  shippingAvailable?: boolean;
  pickupAvailable?: boolean;

  /** ISO-8601 timestamp of when this snapshot was taken. */
  lastCheckedAt: string;
}

/**
 * A product the user is monitoring. Persisted in chrome.storage.local.
 *
 * Identity is (retailerId, productId) — e.g. ("target", "<TCIN>"). The URL a
 * product was added from is not part of its identity; the adapter rebuilds a
 * navigation URL from the id on demand. `lastKnownUrl` is kept only as a
 * cosmetic fallback for navigation if a build ever fails.
 */
export interface WatchedProduct {
  id: string;

  retailerId: string;
  productId: string;

  productName?: string;
  imageUrl?: string;

  /** Notify when currentPrice falls to or below this. */
  targetPrice: number;

  lastSeenPrice?: number;
  /** Original / regular price, when the retailer shows a sale price. */
  lastSeenOriginalPrice?: number;

  availabilityStatus: AvailabilityStatus;
  shippingAvailable?: boolean;
  pickupAvailable?: boolean;

  notifyOnPriceDrop: boolean;
  notifyOnRestock: boolean;

  /** Cosmetic navigation fallback; not part of product identity. */
  lastKnownUrl?: string;

  /** Human-readable description of the last failed check, if any. */
  lastError?: string;

  createdAt: string;
  updatedAt: string;
  lastCheckedAt?: string;
}

/** Stable composite key for a product across the system. */
export function productKey(retailerId: string, productId: string): string {
  return `${retailerId}:${productId}`;
}
