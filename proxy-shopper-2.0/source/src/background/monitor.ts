import type { ProductData, UserSettings, WatchedProduct } from "../types";
import { getProduct, getProductByIdentity, getProducts, getSettings, saveProduct } from "../shared/storage";
import { getAdapterById } from "../retailers/registry";
import { parseProductHtml } from "./offscreenClient";
import { evaluateAlert, showAlert } from "./notifications";
import { activateAssist } from "./assist";

/** Delay between consecutive product checks — be polite to the retailer. */
const BETWEEN_CHECKS_MS = 1500;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Fold a fresh ProductData snapshot into the stored product. */
export function mergeProductData(product: WatchedProduct, data: ProductData): WatchedProduct {
  return {
    ...product,
    productName:
      data.productName && data.productName !== "Unknown product"
        ? data.productName
        : product.productName,
    imageUrl: data.imageUrl ?? product.imageUrl,
    lastSeenPrice: data.currentPrice ?? product.lastSeenPrice,
    lastSeenOriginalPrice: data.originalPrice ?? product.lastSeenOriginalPrice,
    availabilityStatus: data.availabilityStatus,
    shippingAvailable: data.shippingAvailable ?? product.shippingAvailable,
    pickupAvailable: data.pickupAvailable ?? product.pickupAvailable,
    lastCheckedAt: data.lastCheckedAt,
    lastError: undefined,
  };
}

/**
 * Persist updated state and fire notification / Proxy Assist when the change
 * warrants it. `notify` is false for live-page updates (the user is already
 * looking at the product).
 */
async function applyUpdate(
  previous: WatchedProduct,
  updated: WatchedProduct,
  settings: UserSettings,
  notify: boolean,
): Promise<void> {
  await saveProduct(updated);
  if (notify) {
    const alert = evaluateAlert(previous, updated, settings);
    if (alert) {
      await showAlert(updated, alert, settings);
      await activateAssist(updated, alert, settings);
    }
  }
  await updateBadge();
}

/** Check one watched product by its stored entry id. */
export async function checkProduct(watchedId: string): Promise<void> {
  const product = await getProduct(watchedId);
  if (!product) return;
  const settings = await getSettings();
  await checkOne(product, settings);
}

async function checkOne(product: WatchedProduct, settings: UserSettings): Promise<void> {
  const adapter = getAdapterById(product.retailerId);
  const now = new Date().toISOString();
  try {
    if (!adapter) throw new Error(`No adapter for retailer "${product.retailerId}"`);
    let data: ProductData | undefined;

    // Preferred path: the adapter's own background fetch, keyed by product id.
    if (adapter.fetchProductData) {
      try {
        data = await adapter.fetchProductData(product.productId);
      } catch {
        data = undefined;
      }
    }
    // Fallback: fetch the built navigation URL and parse it via the offscreen
    // document. The slug is cosmetic; the built URL resolves by product id.
    if (!data) {
      const url = adapter.buildProductUrl(product.productId);
      const response = await fetch(url, {
        credentials: "omit",
        cache: "no-store",
        headers: { accept: "text/html" },
      });
      if (!response.ok) throw new Error(`Page returned HTTP ${response.status}`);
      const html = await response.text();
      data = await parseProductHtml(html, url, product.retailerId, product.productId);
    }
    await applyUpdate(product, mergeProductData(product, data), settings, true);
  } catch (error) {
    // Never crash the monitoring loop — record the failure on the product.
    await saveProduct({
      ...product,
      lastCheckedAt: now,
      lastError: error instanceof Error ? error.message : String(error),
    });
  }
}

let checkRunning = false;

/** Check every watched product sequentially. Skips if a run is in flight. */
export async function checkAllProducts(): Promise<void> {
  if (checkRunning) return;
  checkRunning = true;
  try {
    const settings = await getSettings();
    const products = await getProducts();
    for (let i = 0; i < products.length; i++) {
      if (i > 0) await sleep(BETWEEN_CHECKS_MS);
      await checkOne(products[i], settings);
    }
  } finally {
    checkRunning = false;
  }
}

/** Live data pushed by the content script — update silently, matched by id. */
export async function applyLiveData(data: ProductData): Promise<void> {
  const product = await getProductByIdentity(data.retailerId, data.productId);
  if (!product) return;
  const settings = await getSettings();
  await applyUpdate(product, mergeProductData(product, data), settings, false);
}

/** Badge shows how many watched products currently meet their conditions. */
export async function updateBadge(): Promise<void> {
  const products = await getProducts();
  const hot = products.filter(
    (p) =>
      p.availabilityStatus === "in_stock" &&
      p.lastSeenPrice != null &&
      p.lastSeenPrice <= p.targetPrice,
  ).length;
  await chrome.action.setBadgeBackgroundColor({ color: "#7c3aed" });
  await chrome.action.setBadgeText({ text: hot > 0 ? String(hot) : "" });
}
