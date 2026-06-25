import type { UserSettings, WatchedProduct } from "../types";
import { formatPrice } from "../utils/format";
import { isWithinQuietHours } from "../utils/quietHours";
import { getAdapterById } from "../retailers/registry";

export type AlertKind = "target_hit" | "restock" | "availability_change" | "price_change";

export interface Alert {
  kind: AlertKind;
  title: string;
  message: string;
}

const NOTIFICATION_PREFIX = "ps__";

/**
 * Compare the previous and updated state of a watched product and decide
 * which single alert (highest priority first) should fire, if any.
 */
export function evaluateAlert(
  previous: WatchedProduct,
  updated: WatchedProduct,
  settings: UserSettings,
): Alert | undefined {
  if (!settings.enableNotifications) return undefined;

  const retailerName = getAdapterById(updated.retailerId)?.retailerName ?? updated.retailerId;
  const name = updated.productName ?? "Watched product";
  const price = updated.lastSeenPrice;
  const prevPrice = previous.lastSeenPrice;

  // 1. Price fell to or below the target price.
  const targetHit =
    price != null && price <= updated.targetPrice && (prevPrice == null || prevPrice > updated.targetPrice);
  if (targetHit && settings.enablePriceDropAlerts && updated.notifyOnPriceDrop) {
    return {
      kind: "target_hit",
      title: "Target price hit!",
      message: `${name}\nNow ${formatPrice(price)} (your target: ${formatPrice(updated.targetPrice)}) at ${retailerName}`,
    };
  }

  // 2. Back in stock.
  const restock =
    previous.availabilityStatus === "out_of_stock" && updated.availabilityStatus === "in_stock";
  if (restock && settings.enableRestockAlerts && updated.notifyOnRestock) {
    return {
      kind: "restock",
      title: "Back in stock!",
      message: `${name}\n${price != null ? `${formatPrice(price)} ` : ""}at ${retailerName} — act fast`,
    };
  }

  // 3. Any other definite availability change (e.g. went out of stock).
  const availabilityChanged =
    previous.availabilityStatus !== updated.availabilityStatus &&
    previous.availabilityStatus !== "unknown" &&
    updated.availabilityStatus !== "unknown";
  if (availabilityChanged && settings.enableRestockAlerts && updated.notifyOnRestock) {
    const label = updated.availabilityStatus === "in_stock" ? "now in stock" : "now out of stock";
    return {
      kind: "availability_change",
      title: "Availability changed",
      message: `${name}\n${label} at ${retailerName}`,
    };
  }

  // 4. Price moved (either direction) without hitting the target.
  const priceChanged = price != null && prevPrice != null && price !== prevPrice;
  if (priceChanged && settings.enablePriceDropAlerts && updated.notifyOnPriceDrop) {
    const direction = price < prevPrice ? "dropped" : "rose";
    return {
      kind: "price_change",
      title: `Price ${direction}`,
      message: `${name}\n${formatPrice(prevPrice)} → ${formatPrice(price)} at ${retailerName}`,
    };
  }

  return undefined;
}

/** Mirror an alert to a Discord channel via webhook, if one is configured. */
async function postToDiscord(
  product: WatchedProduct,
  alert: Alert,
  settings: UserSettings,
): Promise<void> {
  const webhook = settings.discordWebhookUrl?.trim();
  if (!webhook || !webhook.startsWith("https://")) return;

  const url = product.lastKnownUrl ?? getAdapterById(product.retailerId)?.buildProductUrl(product.productId);
  const body = `**${alert.title}**\n${alert.message}${url ? `\n${url}` : ""}`;
  try {
    await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: body }),
    });
  } catch {
    /* Webhook unreachable — the browser notification still fired. */
  }
}

/** Show a browser notification for a product, unless quiet hours apply. Also
 * mirrors the alert to Discord when a webhook is configured. */
export async function showAlert(
  product: WatchedProduct,
  alert: Alert,
  settings: UserSettings,
): Promise<void> {
  if (isWithinQuietHours(settings)) return;

  const id = `${NOTIFICATION_PREFIX}${product.id}__${Date.now()}`;
  await chrome.notifications.create(id, {
    type: "basic",
    iconUrl: chrome.runtime.getURL("icons/icon128.png"),
    title: alert.title,
    message: alert.message,
    priority: 2,
    buttons: [{ title: "Open product" }],
  });

  await postToDiscord(product, alert, settings);
}

/** Recover the watched-product id from a notification id, if it is ours. */
export function productIdFromNotification(notificationId: string): string | undefined {
  if (!notificationId.startsWith(NOTIFICATION_PREFIX)) return undefined;
  return notificationId.slice(NOTIFICATION_PREFIX.length).split("__")[0];
}
