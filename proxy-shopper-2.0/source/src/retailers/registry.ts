import type { RetailerAdapter } from "./RetailerAdapter";
import { targetAdapter } from "./target/targetAdapter";

/**
 * Central adapter registry. To support a new retailer, implement
 * RetailerAdapter and add the instance here — nothing else changes.
 */
const adapters: RetailerAdapter[] = [targetAdapter];

export function getAllAdapters(): RetailerAdapter[] {
  return adapters;
}

export function getAdapterForUrl(url: string): RetailerAdapter | undefined {
  return adapters.find((adapter) => adapter.matchesUrl(url));
}

export function getAdapterById(retailerId: string): RetailerAdapter | undefined {
  return adapters.find((adapter) => adapter.retailerId === retailerId);
}
