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
const QUEUE_NOTIFICATION_PREFIX = "psq__";

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

/** POST a raw message to the configured Discord webhook, if any. */
async function postRawToDiscord(content: string, settings: UserSettings): Promise<void> {
  const webhook = settings.discordWebhookUrl?.trim();
  if (!webhook || !webhook.startsWith("https://")) return;
  try {
    await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    });
  } catch {
    /* Webhook unreachable — the browser notification still fired. */
  }
}

/** Mirror an alert to a Discord channel via webhook, if one is configured. */
async function postToDiscord(
  product: WatchedProduct,
  alert: Alert,
  settings: UserSettings,
): Promise<void> {
  const url = product.lastKnownUrl ?? getAdapterById(product.retailerId)?.buildProductUrl(product.productId);
  await postRawToDiscord(`**${alert.title}**\n${alert.message}${url ? `\n${url}` : ""}`, settings);
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
  if (notificationId.startsWith(QUEUE_NOTIFICATION_PREFIX)) return undefined;
  return notificationId.slice(NOTIFICATION_PREFIX.length).split("__")[0];
}

// ---------------------------------------------------------------------------
// Queue-it waiting-room alerts
// ---------------------------------------------------------------------------

export interface QueueAlert {
  /** "waiting" = a drop is live and you're in line; "passed" = you're through. */
  phase: "waiting" | "passed";
  /** The queue-it.net host (waiting) or retailer host (passed). */
  host: string;
  /** The page the alert links to. */
  pageUrl: string;
  /** The drop's destination (the product/landing URL), when known. */
  targetUrl?: string;
  /** Friendly retailer name, when it could be derived. */
  retailerName?: string;
}

/** Best-effort friendly label for where the queue belongs. */
function queueLabel(event: QueueAlert): string {
  if (event.retailerName) return event.retailerName;
  // Works for both a queue-it subdomain (walmart.queue-it.net) and a retailer
  // host (www.walmart.com) by matching on a known substring either way.
  const host = event.host.replace(/^www\./, "");
  if (host.includes("pokemoncenter")) return "Pokémon Center";
  if (host.includes("walmart")) return "Walmart";
  if (host.includes("target")) return "Target";
  const sub = host.split(".")[0];
  return sub && sub !== "queue-it" && sub !== "static" ? sub : "a retailer";
}

/**
 * Alert the user about a Queue-it waiting room. These are rare and
 * time-critical — a drop is happening *right now* — so they deliberately
 * bypass quiet hours. We only ever report the queue's existence; we never
 * bypass, skip, or automate it.
 */
export async function showQueueAlert(event: QueueAlert, settings: UserSettings): Promise<void> {
  if (!settings.enableNotifications) return;

  const where = queueLabel(event);
  const title =
    event.phase === "waiting" ? "🎟️ Drop is live — you're in the queue" : "✅ You're through the queue!";
  const message =
    event.phase === "waiting"
      ? `A Queue-it waiting room opened for ${where}. A drop is happening right now — keep this tab open and it will advance you automatically.`
      : `You just cleared the ${where} queue. Buy now — checkout while your spot is good.`;

  const id = `${QUEUE_NOTIFICATION_PREFIX}${event.phase}__${Date.now()}`;
  await chrome.notifications.create(id, {
    type: "basic",
    iconUrl: chrome.runtime.getURL("icons/icon128.png"),
    title,
    message,
    priority: 2,
  });

  const link = event.phase === "passed" ? event.pageUrl : event.targetUrl ?? event.pageUrl;
  await postRawToDiscord(`**${title}**\n${message}${link ? `\n${link}` : ""}`, settings);
}
