import type { ProductData } from "./product";

/** Messages handled by the background service worker. */
export type BackgroundMessage =
  | { type: "CHECK_ALL_NOW" }
  /** id here is the WatchedProduct.id (the stored entry), not the TCIN. */
  | { type: "CHECK_PRODUCT"; watchedId: string }
  /** Sent by the content script with data extracted from a live page. */
  | { type: "LIVE_PRODUCT_DATA"; data: ProductData }
  /** Content script asks whether Proxy Assist should activate for this product. */
  | { type: "GET_ASSIST_INFO"; retailerId: string; productId: string }
  /**
   * A Queue-it waiting room was detected ("waiting"), or the user just cleared
   * one and landed back on the retailer with a queue token ("passed"). Sent by
   * the queue detector / retailer content scripts so the background can alert.
   */
  | {
      type: "QUEUE_EVENT";
      phase: "waiting" | "passed";
      host: string;
      pageUrl: string;
      targetUrl?: string;
      retailerName?: string;
    };

/** Message handled by the content script (sent via chrome.tabs.sendMessage). */
export interface GetLiveDataMessage {
  type: "GET_LIVE_DATA";
}

/** Message handled by the offscreen document (DOM parsing). */
export interface ParseHtmlMessage {
  target: "offscreen";
  type: "PARSE_PRODUCT_HTML";
  html: string;
  url: string;
  retailerId: string;
  productId: string;
}

export interface CheckResponse {
  ok: boolean;
  error?: string;
}

export interface ParseHtmlResponse {
  ok: boolean;
  data?: ProductData;
  error?: string;
}

export interface AssistInfo {
  active: boolean;
  productId?: string;
  productName?: string;
  targetPrice?: number;
  /** Why assist was triggered, e.g. "Price hit your target". */
  reason?: string;
}
