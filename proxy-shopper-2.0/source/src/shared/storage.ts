import type { CheckoutProfile, UserSettings, WatchedProduct } from "../types";
import { DEFAULT_SETTINGS, EMPTY_PROFILE } from "../types";
import { getAdapterForUrl } from "../retailers/registry";

const PRODUCTS_KEY = "watchedProducts";
const SETTINGS_KEY = "userSettings";
const PROFILE_KEY = "checkoutProfile";

type ProductMap = Record<string, WatchedProduct>;

// ---------------------------------------------------------------------------
// Watched products
// ---------------------------------------------------------------------------

/**
 * Migrate any pre-identifier-architecture records (which stored `productUrl`
 * instead of `productId`) in place. Runs cheaply on read; only writes when it
 * actually changes something. Records whose TCIN can't be recovered are
 * dropped, since they can no longer be monitored.
 */
function migrateProductMap(map: Record<string, unknown>): { map: ProductMap; changed: boolean } {
  let changed = false;
  const out: ProductMap = {};
  for (const [id, raw] of Object.entries(map)) {
    const p = raw as WatchedProduct & { productUrl?: string };
    if (p.productId) {
      out[id] = p;
      continue;
    }
    const url = p.productUrl;
    const adapter = url ? getAdapterForUrl(url) : undefined;
    const tcin = url ? url.match(/\bA-(\d{4,})\b/i)?.[1] : undefined;
    if (adapter && tcin) {
      const { productUrl, ...rest } = p;
      out[id] = { ...rest, retailerId: adapter.retailerId, productId: tcin, lastKnownUrl: productUrl };
      changed = true;
    } else {
      changed = true; // unmigratable record dropped
    }
  }
  return { map: out, changed };
}

async function getProductMap(): Promise<ProductMap> {
  const result = await chrome.storage.local.get(PRODUCTS_KEY);
  const stored = (result[PRODUCTS_KEY] as Record<string, unknown> | undefined) ?? {};
  const { map, changed } = migrateProductMap(stored);
  if (changed) await chrome.storage.local.set({ [PRODUCTS_KEY]: map });
  return map;
}

/** Find a watched product by its retailer + product id, if present. */
export async function getProductByIdentity(
  retailerId: string,
  productId: string,
): Promise<WatchedProduct | undefined> {
  const map = await getProductMap();
  return Object.values(map).find((p) => p.retailerId === retailerId && p.productId === productId);
}

/** All watched products, newest first. */
export async function getProducts(): Promise<WatchedProduct[]> {
  const map = await getProductMap();
  return Object.values(map).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function getProduct(id: string): Promise<WatchedProduct | undefined> {
  const map = await getProductMap();
  return map[id];
}

/** Thrown by saveProduct when a different entry already watches this product. */
export class DuplicateWatchError extends Error {
  constructor() {
    super("You're already watching this product.");
    this.name = "DuplicateWatchError";
  }
}

/**
 * Insert or update a product. Always refreshes updatedAt.
 *
 * Enforces one-watch-per-product atomically: a product's identity is
 * (retailerId, productId). Inserting a new record whose identity already
 * belongs to a *different* entry is rejected, so no race between the side
 * panel, the on-page prompt, and the add form can ever create a duplicate.
 * Updates to an existing entry (same id) always pass.
 */
export async function saveProduct(product: WatchedProduct): Promise<WatchedProduct> {
  const map = await getProductMap();
  const isInsert = !map[product.id];
  if (isInsert) {
    const clash = Object.values(map).some(
      (p) => p.retailerId === product.retailerId && p.productId === product.productId,
    );
    if (clash) throw new DuplicateWatchError();
  }
  const saved = { ...product, updatedAt: new Date().toISOString() };
  map[product.id] = saved;
  await chrome.storage.local.set({ [PRODUCTS_KEY]: map });
  return saved;
}

export async function removeProduct(id: string): Promise<void> {
  const map = await getProductMap();
  delete map[id];
  await chrome.storage.local.set({ [PRODUCTS_KEY]: map });
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export async function getSettings(): Promise<UserSettings> {
  const result = await chrome.storage.local.get(SETTINGS_KEY);
  const stored = (result[SETTINGS_KEY] as Partial<UserSettings> | undefined) ?? {};
  return { ...DEFAULT_SETTINGS, ...stored };
}

export async function saveSettings(settings: UserSettings): Promise<void> {
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
}

// ---------------------------------------------------------------------------
// Checkout profile (non-sensitive contact + shipping only)
// ---------------------------------------------------------------------------

export async function getProfile(): Promise<CheckoutProfile> {
  const result = await chrome.storage.local.get(PROFILE_KEY);
  const stored = (result[PROFILE_KEY] as Partial<CheckoutProfile> | undefined) ?? {};
  return { ...EMPTY_PROFILE, ...stored };
}

export async function saveProfile(profile: CheckoutProfile): Promise<void> {
  await chrome.storage.local.set({ [PROFILE_KEY]: profile });
}

// ---------------------------------------------------------------------------
// Change subscriptions (popup/options live updates)
// ---------------------------------------------------------------------------

export function onProductsChanged(callback: (products: WatchedProduct[]) => void): () => void {
  const listener = (
    changes: Record<string, chrome.storage.StorageChange>,
    area: string,
  ) => {
    if (area !== "local" || !(PRODUCTS_KEY in changes)) return;
    const map = (changes[PRODUCTS_KEY].newValue as ProductMap | undefined) ?? {};
    callback(Object.values(map).sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}

export function onSettingsChanged(callback: (settings: UserSettings) => void): () => void {
  const listener = (
    changes: Record<string, chrome.storage.StorageChange>,
    area: string,
  ) => {
    if (area !== "local" || !(SETTINGS_KEY in changes)) return;
    const stored = (changes[SETTINGS_KEY].newValue as Partial<UserSettings> | undefined) ?? {};
    callback({ ...DEFAULT_SETTINGS, ...stored });
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}

// ---------------------------------------------------------------------------
// Export / import / clear
// ---------------------------------------------------------------------------

interface ExportPayload {
  app: string;
  version: number;
  exportedAt: string;
  products: WatchedProduct[];
  settings: UserSettings;
  profile?: CheckoutProfile;
}

export async function exportData(): Promise<string> {
  const payload: ExportPayload = {
    app: "proxy-shopper",
    version: 1,
    exportedAt: new Date().toISOString(),
    products: await getProducts(),
    settings: await getSettings(),
    profile: await getProfile(),
  };
  return JSON.stringify(payload, null, 2);
}

/** Import a previously exported payload. Merges products by id. */
export async function importData(json: string): Promise<{ imported: number }> {
  let payload: ExportPayload;
  try {
    payload = JSON.parse(json);
  } catch {
    throw new Error("File is not valid JSON.");
  }
  if (payload?.app !== "proxy-shopper" || !Array.isArray(payload.products)) {
    throw new Error("File is not a Proxy Shopper export.");
  }

  const map = await getProductMap();
  let imported = 0;
  for (const product of payload.products) {
    // Accept both new (productId) and legacy (productUrl) records; the latter
    // are normalized by migrateProductMap on the next read.
    const legacyUrl = (product as { productUrl?: string }).productUrl;
    if (!product?.id || (!product.productId && !legacyUrl)) continue;
    map[product.id] = product;
    imported++;
  }
  await chrome.storage.local.set({ [PRODUCTS_KEY]: map });

  if (payload.settings && typeof payload.settings === "object") {
    await saveSettings({ ...DEFAULT_SETTINGS, ...payload.settings });
  }
  if (payload.profile && typeof payload.profile === "object") {
    await saveProfile({ ...EMPTY_PROFILE, ...payload.profile });
  }
  return { imported };
}

export async function clearAllData(): Promise<void> {
  await chrome.storage.local.remove([PRODUCTS_KEY, SETTINGS_KEY, PROFILE_KEY]);
}
