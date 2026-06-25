import type { BackgroundMessage, CheckResponse } from "../types";
import { getProduct, getSettings, onSettingsChanged } from "../shared/storage";
import { getAdapterById } from "../retailers/registry";
import { checkAllProducts, checkProduct, applyLiveData, updateBadge } from "./monitor";
import { productIdFromNotification, showQueueAlert } from "./notifications";
import { getAssistInfo } from "./assist";

const CHECK_ALARM = "proxy-shopper-check";

// ---------------------------------------------------------------------------
// Queue-it events (dedupe so a refreshing waiting room can't spam alerts)
// ---------------------------------------------------------------------------

const QUEUE_DEDUPE_KEY = "queueLastAlert";
const QUEUE_DEDUPE_MS = 90_000;

async function handleQueueEvent(
  message: Extract<BackgroundMessage, { type: "QUEUE_EVENT" }>,
): Promise<void> {
  const dedupeId = `${message.phase}|${message.host}`;
  const store = await chrome.storage.local.get(QUEUE_DEDUPE_KEY);
  const last = (store[QUEUE_DEDUPE_KEY] as Record<string, number> | undefined) ?? {};
  const now = Date.now();
  if (last[dedupeId] && now - last[dedupeId] < QUEUE_DEDUPE_MS) return;

  // Prune stale entries so the map can't grow without bound, then record this one.
  for (const [key, ts] of Object.entries(last)) {
    if (now - ts > QUEUE_DEDUPE_MS) delete last[key];
  }
  last[dedupeId] = now;
  await chrome.storage.local.set({ [QUEUE_DEDUPE_KEY]: last });

  const settings = await getSettings();
  await showQueueAlert(
    {
      phase: message.phase,
      host: message.host,
      pageUrl: message.pageUrl,
      targetUrl: message.targetUrl,
      retailerName: message.retailerName,
    },
    settings,
  );
}

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

async function scheduleMonitoring(): Promise<void> {
  const settings = await getSettings();
  const periodInMinutes = Math.max(1, settings.checkIntervalMinutes);
  await chrome.alarms.create(CHECK_ALARM, { periodInMinutes, delayInMinutes: 1 });
}

chrome.runtime.onInstalled.addListener(() => {
  void scheduleMonitoring();
  void updateBadge();
  // Clicking the toolbar icon opens the side panel (the watchlist UI).
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

chrome.runtime.onStartup.addListener(() => {
  void scheduleMonitoring();
  void updateBadge();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === CHECK_ALARM) void checkAllProducts();
});

// Reschedule when the user changes the interval.
onSettingsChanged(() => {
  void scheduleMonitoring();
});

// ---------------------------------------------------------------------------
// Messages from popup / content scripts
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message: BackgroundMessage & { target?: string }, _sender, sendResponse) => {
  // Offscreen-parser messages are handled by the offscreen document.
  if (message?.target === "offscreen") return false;

  switch (message?.type) {
    case "CHECK_ALL_NOW": {
      checkAllProducts()
        .then(() => sendResponse({ ok: true } satisfies CheckResponse))
        .catch((error) =>
          sendResponse({ ok: false, error: String(error) } satisfies CheckResponse),
        );
      return true;
    }
    case "CHECK_PRODUCT": {
      checkProduct(message.watchedId)
        .then(() => sendResponse({ ok: true } satisfies CheckResponse))
        .catch((error) =>
          sendResponse({ ok: false, error: String(error) } satisfies CheckResponse),
        );
      return true;
    }
    case "LIVE_PRODUCT_DATA": {
      applyLiveData(message.data)
        .then(() => sendResponse({ ok: true } satisfies CheckResponse))
        .catch((error) =>
          sendResponse({ ok: false, error: String(error) } satisfies CheckResponse),
        );
      return true;
    }
    case "GET_ASSIST_INFO": {
      getAssistInfo(message.retailerId, message.productId)
        .then(sendResponse)
        .catch(() => sendResponse({ active: false }));
      return true;
    }
    case "QUEUE_EVENT": {
      handleQueueEvent(message)
        .then(() => sendResponse({ ok: true } satisfies CheckResponse))
        .catch((error) =>
          sendResponse({ ok: false, error: String(error) } satisfies CheckResponse),
        );
      return true;
    }
    default:
      return false;
  }
});

// ---------------------------------------------------------------------------
// Notification interactions → open the product page
// ---------------------------------------------------------------------------

async function openProductFromNotification(notificationId: string): Promise<void> {
  const productId = productIdFromNotification(notificationId);
  if (!productId) return;
  const product = await getProduct(productId);
  if (product) {
    const url =
      getAdapterById(product.retailerId)?.buildProductUrl(product.productId) ?? product.lastKnownUrl;
    if (url) await chrome.tabs.create({ url });
  }
  await chrome.notifications.clear(notificationId);
}

chrome.notifications.onClicked.addListener((id) => void openProductFromNotification(id));
chrome.notifications.onButtonClicked.addListener((id) => void openProductFromNotification(id));
