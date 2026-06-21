import { loadConfig } from '../lib/config.js';
import { createLogger } from '../lib/logger.js';
import { retailers as retailerRepo, watches as watchRepo } from '../db/repositories.js';
import { getAdapter } from '../adapters/registry.js';
import { buildAdapterContext } from '../adapters/context.js';
import type { Retailer, Watch } from '../db/types.js';

/**
 * Watch-list actions shared by every front-end (the Discord slash commands and
 * the web control API). Keeping the logic here means there's a single source of
 * truth: both surfaces resolve URLs, create watches, and toggle state the exact
 * same way. These functions are transport-agnostic — they take plain inputs and
 * return rows/ids, never anything Discord- or HTTP-specific.
 */

const logger = createLogger(loadConfig().logLevel, { component: 'service' });

export interface AddItemInput {
  retailer: string;
  url: string;
  threshold?: number | null;
  name?: string | null;
  interval?: number | null;
  tcgSku?: string | null;
}

/** Resolve a URL through the retailer's adapter and insert a watch (FR add-item). */
export async function addItem(input: AddItemInput): Promise<Watch> {
  const retailer = await retailerRepo.getByName(input.retailer);
  if (!retailer) {
    throw new Error(`No retailer named "${input.retailer}". Add it with /add-retailer first.`);
  }
  const adapter = getAdapter(retailer.adapter_type);
  const ctx = buildAdapterContext(retailer, logger);
  const resolved = await adapter.resolve(input.url, ctx);

  return watchRepo.create({
    retailer_id: retailer.id,
    product_id: resolved.productId,
    source_url: input.url,
    display_name: input.name ?? resolved.displayName ?? null,
    image_url: resolved.image ?? null,
    threshold: input.threshold ?? null,
    tcg_sku: input.tcgSku ?? null,
    interval_sec: input.interval ?? null,
  });
}

/** Accept a full id or a short 8-char prefix (as shown in list output). */
export async function resolveWatchId(idPrefix: string): Promise<string> {
  const direct = await watchRepo.get(idPrefix);
  if (direct) return direct.id;
  const all = await watchRepo.listAll();
  const match = all.find((w) => w.id.startsWith(idPrefix));
  if (!match) throw new Error(`No watch matching id "${idPrefix}".`);
  return match.id;
}

export async function removeItem(idPrefix: string): Promise<string> {
  const id = await resolveWatchId(idPrefix);
  await watchRepo.remove(id);
  return id;
}

export async function setItemEnabled(idPrefix: string, enabled: boolean): Promise<string> {
  const id = await resolveWatchId(idPrefix);
  await watchRepo.setEnabled(id, enabled);
  return id;
}

export async function setItemThreshold(idPrefix: string, value: number | null): Promise<string> {
  const id = await resolveWatchId(idPrefix);
  await watchRepo.setThreshold(id, value);
  return id;
}

export async function setItemInterval(idPrefix: string, seconds: number | null): Promise<string> {
  const id = await resolveWatchId(idPrefix);
  await watchRepo.setInterval(id, seconds);
  return id;
}

export async function listWatches(retailerName?: string): Promise<Watch[]> {
  if (retailerName) {
    const retailer = await retailerRepo.getByName(retailerName);
    if (!retailer) throw new Error(`No retailer named "${retailerName}".`);
    return watchRepo.listByRetailer(retailer.id);
  }
  return watchRepo.listAll();
}

export async function listRetailers(): Promise<Retailer[]> {
  return retailerRepo.list();
}
