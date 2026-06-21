import type { RetailerAdapter } from './types.js';
import type { AdapterType } from '../db/types.js';
import { targetAdapter } from './target.js';
import { ebayAdapter } from './ebay.js';
import { walmartAdapter } from './walmart.js';
import { pokemonCenterAdapter } from './pokemonCenter.js';

/**
 * Adapter registry — the single place the core learns which retailers exist.
 * Adding a retailer is: implement RetailerAdapter, then register it here.
 */
const ADAPTERS: Record<AdapterType, RetailerAdapter> = {
  target: targetAdapter,
  ebay: ebayAdapter,
  walmart: walmartAdapter,
  pokemon_center: pokemonCenterAdapter,
};

export function getAdapter(type: AdapterType): RetailerAdapter {
  const adapter = ADAPTERS[type];
  if (!adapter) throw new Error(`No adapter registered for type "${type}"`);
  return adapter;
}

export function listAdapterTypes(): AdapterType[] {
  return Object.keys(ADAPTERS) as AdapterType[];
}
