import type { AssistInfo, UserSettings, WatchedProduct } from "../types";
import { productKey } from "../types";
import { getAdapterById } from "../retailers/registry";
import type { Alert } from "./notifications";
import { isWithinQuietHours } from "../utils/quietHours";

/**
 * Proxy Assist Mode: when an opportunity fires, remember it (and optionally
 * open the product page). The content script asks via GET_ASSIST_INFO with the
 * product's identity (retailerId + productId) and highlights / Express-Lanes
 * the purchase actions when a pending assist target matches.
 *
 * Assist never submits an order — it only navigates, adds to cart, and
 * highlights. The final purchase click is always the user's.
 */

const ASSIST_KEY = "assistTargets";
const ASSIST_TTL_MS = 15 * 60 * 1000;

interface AssistTarget {
  /** The WatchedProduct.id of the stored entry. */
  watchedId: string;
  productName?: string;
  targetPrice: number;
  reason: string;
  expiresAt: number;
}

type AssistMap = Record<string, AssistTarget>;

async function getAssistMap(): Promise<AssistMap> {
  const result = await chrome.storage.session.get(ASSIST_KEY);
  const map = (result[ASSIST_KEY] as AssistMap | undefined) ?? {};
  // Drop expired entries on every read.
  const now = Date.now();
  let dirty = false;
  for (const key of Object.keys(map)) {
    if (map[key].expiresAt < now) {
      delete map[key];
      dirty = true;
    }
  }
  if (dirty) await chrome.storage.session.set({ [ASSIST_KEY]: map });
  return map;
}

const ASSIST_REASONS: Record<string, string> = {
  target_hit: "Price hit your target",
  restock: "Back in stock",
};

/** Returns true when this alert kind warrants Proxy Assist. */
export function alertTriggersAssist(alert: Alert): boolean {
  return alert.kind === "target_hit" || alert.kind === "restock";
}

/** Register an assist target and optionally auto-open the product page. */
export async function activateAssist(
  product: WatchedProduct,
  alert: Alert,
  settings: UserSettings,
): Promise<void> {
  if (!settings.enableProxyAssist || !alertTriggersAssist(alert)) return;

  const map = await getAssistMap();
  map[productKey(product.retailerId, product.productId)] = {
    watchedId: product.id,
    productName: product.productName,
    targetPrice: product.targetPrice,
    reason: ASSIST_REASONS[alert.kind] ?? alert.title,
    expiresAt: Date.now() + ASSIST_TTL_MS,
  };
  await chrome.storage.session.set({ [ASSIST_KEY]: map });

  if (settings.assistAutoOpenTab && !isWithinQuietHours(settings)) {
    const adapter = getAdapterById(product.retailerId);
    const url = adapter?.buildProductUrl(product.productId) ?? product.lastKnownUrl;
    if (url) await chrome.tabs.create({ url, active: false });
  }
}

/** Content-script query: is there a pending assist target for this product? */
export async function getAssistInfo(retailerId: string, productId: string): Promise<AssistInfo> {
  const map = await getAssistMap();
  const target = map[productKey(retailerId, productId)];
  if (!target) return { active: false };
  return {
    active: true,
    productId,
    productName: target.productName,
    targetPrice: target.targetPrice,
    reason: target.reason,
  };
}
