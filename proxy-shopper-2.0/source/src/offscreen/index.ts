import { getAdapterById } from "../retailers/registry";
import type { ParseHtmlMessage, ParseHtmlResponse } from "../types";

/**
 * Offscreen document: parses raw HTML fetched by the background service
 * worker (which has no DOMParser) and runs the retailer adapter against it.
 */
chrome.runtime.onMessage.addListener(
  (message: ParseHtmlMessage, _sender, sendResponse: (response: ParseHtmlResponse) => void) => {
    if (message?.target !== "offscreen" || message.type !== "PARSE_PRODUCT_HTML") {
      return false;
    }
    (async () => {
      const adapter = getAdapterById(message.retailerId);
      if (!adapter) {
        throw new Error(`No adapter registered for retailer "${message.retailerId}"`);
      }
      const doc = new DOMParser().parseFromString(message.html, "text/html");
      const data = await adapter.extractProductData(doc, message.productId, message.url);
      sendResponse({ ok: true, data });
    })().catch((error) => {
      sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
    });
    return true; // async sendResponse
  },
);
