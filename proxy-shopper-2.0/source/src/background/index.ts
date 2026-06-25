import type { BackgroundMessage, CheckResponse } from "../types";
import { getProduct, getSettings, onSettingsChanged } from "../shared/storage";
import { getAdapterById } from "../retailers/registry";
import { checkAllProducts, checkProduct, applyLiveData, updateBadge } from "./monitor";
import { productIdFromNotification } from "./notifications";
import { getAssistInfo } from "./assist";

const CHECK_ALARM = "proxy-shopper-check";

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
