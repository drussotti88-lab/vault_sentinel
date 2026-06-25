import { useCallback, useEffect, useRef, useState } from "react";
import type { ProductData, WatchedProduct } from "../types";
import { getAdapterForUrl } from "../retailers/registry";

/** How often the panel re-asks the active tab what product it's showing. */
const POLL_INTERVAL_MS = 2500;

interface ActiveProduct {
  /** Product detected on the active tab that isn't on the watchlist yet. */
  detected: ProductData | null;
  refresh(): void;
}

/**
 * Watches the active tab and surfaces the product it is showing, so the side
 * panel can offer to watch it. Handles tabs that were opened before the
 * extension loaded by injecting the content script on demand, and polls while
 * the panel is open (extraction takes a moment on hydrated pages).
 */
export function useActiveTabProduct(watched: WatchedProduct[]): ActiveProduct {
  const [detected, setDetected] = useState<ProductData | null>(null);
  // Tabs we've already tried injecting into — once per tab is enough.
  const injectedTabs = useRef(new Set<number>());

  const refresh = useCallback(() => {
    void (async () => {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id || !tab.url || !getAdapterForUrl(tab.url)) {
          setDetected(null);
          return;
        }

        let data = (await chrome.tabs
          .sendMessage(tab.id, { type: "GET_LIVE_DATA" })
          .catch(() => undefined)) as ProductData | null | undefined;

        // No listener responded — the tab predates the extension (re)load.
        // Inject the content script once and let the next poll pick it up.
        if (data === undefined && !injectedTabs.current.has(tab.id)) {
          injectedTabs.current.add(tab.id);
          await chrome.scripting
            .executeScript({ target: { tabId: tab.id }, files: ["content.js"] })
            .catch(() => {});
          data = null;
        }

        if (!data) {
          setDetected(null);
          return;
        }
        const product = data;
        const alreadyWatched = watched.some(
          (p) => p.retailerId === product.retailerId && p.productId === product.productId,
        );
        setDetected(alreadyWatched ? null : product);
      } catch {
        setDetected(null);
      }
    })();
  }, [watched]);

  useEffect(() => {
    refresh();
    // Poll while the panel is open: extraction finishes a beat after page
    // load, and prices can change under us.
    const interval = setInterval(refresh, POLL_INTERVAL_MS);
    const onActivated = () => refresh();
    const onUpdated = (_id: number, info: chrome.tabs.TabChangeInfo) => {
      if (info.status === "complete" || info.url) refresh();
    };
    chrome.tabs.onActivated.addListener(onActivated);
    chrome.tabs.onUpdated.addListener(onUpdated);
    return () => {
      clearInterval(interval);
      chrome.tabs.onActivated.removeListener(onActivated);
      chrome.tabs.onUpdated.removeListener(onUpdated);
    };
  }, [refresh]);

  return { detected, refresh };
}
