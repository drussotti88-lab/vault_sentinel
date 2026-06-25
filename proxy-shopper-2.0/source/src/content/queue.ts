import type { BackgroundMessage } from "../types";

/**
 * Queue-it waiting-room detector (runs on *.queue-it.net).
 *
 * When a retailer puts a drop behind Queue-it, the browser is redirected into a
 * waiting room on {customerId}.queue-it.net. That redirect is itself the
 * earliest reliable, public signal that a drop is LIVE right now — so the
 * instant we land here we tell the background worker, which fires a browser
 * notification and (if configured) a Discord ping.
 *
 * We only ever report that a queue exists. We do not bypass, skip, reorder, or
 * automate it — Queue-it's fairness is respected; we just put you at the
 * keyboard at the right moment.
 */

const FIRED_KEY = "proxy-shopper-queue-fired";

/** Fire at most once per waiting-room session in this tab. */
function claimFire(): boolean {
  try {
    if (sessionStorage.getItem(FIRED_KEY)) return false;
    sessionStorage.setItem(FIRED_KEY, "1");
  } catch {
    /* sessionStorage blocked — lean on the background dedupe window */
  }
  return true;
}

/** The drop's real destination, from Queue-it's `t` param or the referrer. */
function deriveTargetUrl(): string | undefined {
  try {
    const t = new URL(location.href).searchParams.get("t");
    if (t) return decodeURIComponent(t);
  } catch {
    /* not parseable — fall through */
  }
  return document.referrer || undefined;
}

/** A friendly retailer name, derived from the destination or referrer host. */
function deriveRetailerName(): string | undefined {
  const candidates = [deriveTargetUrl(), document.referrer].filter(Boolean) as string[];
  for (const candidate of candidates) {
    let host: string;
    try {
      host = new URL(candidate).hostname.replace(/^www\./, "");
    } catch {
      continue;
    }
    if (host.includes("pokemoncenter")) return "Pokémon Center";
    if (host.includes("walmart")) return "Walmart";
    if (host.includes("target")) return "Target";
    if (host && !host.includes("queue-it")) return host;
  }
  return undefined;
}

function send(message: BackgroundMessage): void {
  try {
    chrome.runtime.sendMessage(message, () => void chrome.runtime.lastError);
  } catch {
    /* Service worker asleep / context torn down — nothing else to do. */
  }
}

function detect(): void {
  // Asset/CDN frames (e.g. static.queue-it.net) aren't a waiting room.
  if (location.hostname.startsWith("static.")) return;
  if (!claimFire()) return;
  send({
    type: "QUEUE_EVENT",
    phase: "waiting",
    host: location.hostname,
    pageUrl: location.href,
    targetUrl: deriveTargetUrl(),
    retailerName: deriveRetailerName(),
  });
}

// Being on a queue-it.net waiting-room host is the signal; fire immediately.
// A couple of cheap retries cover the brief "redirecting…" interstitial that
// some queues show before the real waiting room renders (claimFire dedupes).
detect();
setTimeout(detect, 1500);
setTimeout(detect, 4000);
