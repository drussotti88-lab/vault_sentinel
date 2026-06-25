import { getAdapterForUrl } from "../retailers/registry";
import type { AssistInfo, BackgroundMessage, CheckoutProfile, ProductData, WatchedProduct } from "../types";
import { productKey, profileHasData } from "../types";
import { getProducts, getProfile, getSettings, saveProduct } from "../shared/storage";
import { generateId } from "../utils/id";
import { formatPrice } from "../utils/format";

/**
 * Content script (all supported retailer pages).
 *
 * 1. On product pages, extracts live product data once the page has hydrated
 *    and pushes it to the background worker (keeps watchlist data fresh).
 * 2. Proxy Assist Mode: if the background has flagged this product as an
 *    opportunity, shows a banner and highlights the purchase buttons.
 *    It never clicks anything — the user completes the purchase.
 */

const EXTRACT_ATTEMPT_DELAYS_MS = [1200, 2500, 5000];

function sendToBackground<T>(message: BackgroundMessage): Promise<T | undefined> {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (response) => {
        // Swallow "receiving end does not exist" errors.
        void chrome.runtime.lastError;
        resolve(response as T | undefined);
      });
    } catch {
      resolve(undefined);
    }
  });
}

// ---------------------------------------------------------------------------
// Live extraction
// ---------------------------------------------------------------------------

/** Latest extraction for the current page, served to the side panel on demand. */
let lastExtraction: ProductData | null = null;
let lastExtractionUrl = "";

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "GET_LIVE_DATA") return false;
  sendResponse(lastExtraction && lastExtractionUrl === location.href ? lastExtraction : null);
  return false;
});

async function extractAndReport(url: string): Promise<void> {
  const adapter = getAdapterForUrl(url);
  if (!adapter) return;

  // Resolve the product identity once. Fall back to DOM inspection if the URL
  // alone doesn't carry the id (e.g. short links or client-side navigations).
  let productId = await adapter.extractProductId(url);

  for (const delay of EXTRACT_ATTEMPT_DELAYS_MS) {
    await new Promise((resolve) => setTimeout(resolve, delay));
    if (location.href !== url) return; // user navigated away
    if (!productId) productId = await adapter.extractProductId(url, document);
    if (!productId) continue;
    try {
      const data = await adapter.extractProductData(document, productId, url);
      const gotSomething = data.currentPrice != null || data.availabilityStatus !== "unknown";
      if (gotSomething) {
        lastExtraction = data;
        lastExtractionUrl = url;
        await sendToBackground({ type: "LIVE_PRODUCT_DATA", data });
        await maybeOfferWatch(data);
        return;
      }
    } catch {
      // Retry on next delay.
    }
  }
}

// ---------------------------------------------------------------------------
// "Watch this item?" prompt
// ---------------------------------------------------------------------------

const PROMPT_ID = "proxy-shopper-watch-prompt";
const PROMPT_STYLE_ID = "proxy-shopper-prompt-style";

function dismissedKey(normalizedUrl: string): string {
  return `proxy-shopper-dismissed:${normalizedUrl}`;
}

function removeWatchPrompt(): void {
  document.getElementById(PROMPT_ID)?.remove();
}

function injectPromptStyles(): void {
  if (document.getElementById(PROMPT_STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = PROMPT_STYLE_ID;
  style.textContent = `
    #${PROMPT_ID} {
      position: fixed; right: 18px; bottom: 18px; z-index: 2147483646;
      width: 320px; max-width: calc(100vw - 36px);
      background: linear-gradient(180deg, #1b2129, #161a21); color: #ece6d6;
      border: 1px solid #b8881f; border-radius: 14px;
      box-shadow: 0 10px 34px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(230, 180, 80, 0.12);
      font: 13px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif;
      overflow: hidden;
      animation: proxy-shopper-prompt-in 0.25s ease-out;
    }
    @keyframes proxy-shopper-prompt-in {
      from { transform: translateY(12px); opacity: 0; }
      to { transform: translateY(0); opacity: 1; }
    }
    #${PROMPT_ID} .psp-head {
      display: flex; align-items: center; justify-content: space-between;
      padding: 9px 12px;
      background: linear-gradient(125deg, #20283400, #11151c);
      border-bottom: 1px solid #b8881f; color: #e6b450;
      font-weight: 800; letter-spacing: 0.3px;
    }
    #${PROMPT_ID} .psp-close {
      background: none; border: none; color: #97a0b0; font-size: 16px;
      cursor: pointer; padding: 0 2px; line-height: 1;
    }
    #${PROMPT_ID} .psp-body { padding: 12px; display: flex; flex-direction: column; gap: 9px; }
    #${PROMPT_ID} .psp-name { font-weight: 600; margin: 0; }
    #${PROMPT_ID} .psp-price { color: #97a0b0; margin: 0; }
    #${PROMPT_ID} .psp-row { display: flex; gap: 8px; }
    #${PROMPT_ID} .psp-row input {
      flex: 1; min-width: 0; padding: 7px 9px; background: #0e1014; color: #ece6d6;
      border: 1px solid #2b3240; border-radius: 8px; font-size: 13px;
    }
    #${PROMPT_ID} .psp-watch {
      background: linear-gradient(180deg, #f0c75e, #e6b450); border: 1px solid #b8881f; color: #20180a;
      border-radius: 8px; padding: 7px 14px; font-weight: 700; cursor: pointer;
    }
    #${PROMPT_ID} .psp-done { padding: 16px 12px; text-align: center; font-weight: 700; color: #51d88a; }
    #${WATCHING_BADGE_ID} {
      position: fixed; right: 18px; bottom: 18px; z-index: 2147483646;
      display: flex; align-items: center; gap: 7px;
      padding: 8px 13px; border-radius: 999px;
      background: linear-gradient(180deg, #1b2129, #161a21); color: #e6b450;
      border: 1px solid #b8881f;
      box-shadow: 0 6px 20px rgba(0, 0, 0, 0.45);
      font: 700 12.5px/1 system-ui, -apple-system, "Segoe UI", sans-serif;
      letter-spacing: 0.3px;
      animation: proxy-shopper-prompt-in 0.25s ease-out;
    }
    #${WATCHING_BADGE_ID} .psw-dot {
      width: 8px; height: 8px; border-radius: 50%; background: #51d88a;
      box-shadow: 0 0 8px #51d88a;
    }
  `;
  document.head.appendChild(style);
}

const WATCHING_BADGE_ID = "proxy-shopper-watching-badge";

function removeWatchingBadge(): void {
  document.getElementById(WATCHING_BADGE_ID)?.remove();
}

/** A small "✓ Watching" chip shown when the page's product is already watched. */
function showWatchingBadge(): void {
  injectPromptStyles();
  if (document.getElementById(WATCHING_BADGE_ID)) return;
  const badge = document.createElement("div");
  badge.id = WATCHING_BADGE_ID;
  const dot = document.createElement("span");
  dot.className = "psw-dot";
  const label = document.createElement("span");
  label.textContent = "Proxy Shopper · Watching this item";
  badge.append(dot, label);
  document.body.appendChild(badge);
}

/**
 * If the product on this page isn't watched yet, offer to add it.
 * Dismissals are remembered per product for this tab session.
 */
async function maybeOfferWatch(data: ProductData): Promise<void> {
  const key = productKey(data.retailerId, data.productId);
  try {
    if (sessionStorage.getItem(dismissedKey(key))) return;
  } catch {
    /* sessionStorage may be blocked; prompt anyway */
  }

  const products = await getProducts();
  const alreadyWatched = products.some(
    (p) => p.retailerId === data.retailerId && p.productId === data.productId,
  );
  removeWatchPrompt();
  if (alreadyWatched) {
    // Already watching — show a status chip instead of an add prompt.
    showWatchingBadge();
    return;
  }
  removeWatchingBadge();

  injectPromptStyles();

  const prompt = document.createElement("div");
  prompt.id = PROMPT_ID;

  const head = document.createElement("div");
  head.className = "psp-head";
  const headLabel = document.createElement("span");
  headLabel.textContent = "Proxy Shopper";
  const close = document.createElement("button");
  close.className = "psp-close";
  close.setAttribute("aria-label", "Dismiss");
  close.textContent = "✕";
  close.addEventListener("click", () => {
    try {
      sessionStorage.setItem(dismissedKey(key), "1");
    } catch {
      /* ignore */
    }
    removeWatchPrompt();
  });
  head.append(headLabel, close);

  const body = document.createElement("div");
  body.className = "psp-body";
  const name = document.createElement("p");
  name.className = "psp-name";
  name.textContent = `Watch this item? ${data.productName}`;
  const price = document.createElement("p");
  price.className = "psp-price";
  price.textContent =
    data.currentPrice != null ? `Current price: ${formatPrice(data.currentPrice)}` : "Price unknown";

  const row = document.createElement("div");
  row.className = "psp-row";
  const input = document.createElement("input");
  input.type = "number";
  input.min = "0.01";
  input.step = "0.01";
  input.placeholder = "Desired price ($)";
  if (data.currentPrice != null) input.value = String(data.currentPrice);
  const watch = document.createElement("button");
  watch.className = "psp-watch";
  watch.textContent = "Watch";
  watch.addEventListener("click", async () => {
    const targetPrice = Number(input.value);
    if (!Number.isFinite(targetPrice) || targetPrice <= 0) {
      input.focus();
      return;
    }
    const now = new Date().toISOString();
    const product: WatchedProduct = {
      id: generateId(),
      retailerId: data.retailerId,
      productId: data.productId,
      lastKnownUrl: location.href,
      productName: data.productName,
      imageUrl: data.imageUrl,
      targetPrice,
      lastSeenPrice: data.currentPrice,
      lastSeenOriginalPrice: data.originalPrice,
      availabilityStatus: data.availabilityStatus,
      shippingAvailable: data.shippingAvailable,
      pickupAvailable: data.pickupAvailable,
      notifyOnPriceDrop: true,
      notifyOnRestock: true,
      createdAt: now,
      updatedAt: now,
      lastCheckedAt: data.lastCheckedAt,
    };
    try {
      await saveProduct(product);
    } catch {
      // Another surface added it first — treat as already watching.
      removeWatchPrompt();
      showWatchingBadge();
      return;
    }
    body.replaceChildren(Object.assign(document.createElement("div"), {
      className: "psp-done",
      textContent: "✓ Added to your watchlist",
    }));
    setTimeout(() => {
      removeWatchPrompt();
      showWatchingBadge();
    }, 2200);
  });
  row.append(input, watch);

  body.append(name, price, row);
  prompt.append(head, body);
  document.body.appendChild(prompt);
}

// ---------------------------------------------------------------------------
// Proxy Assist Mode
// ---------------------------------------------------------------------------

const ASSIST_STYLE_ID = "proxy-shopper-assist-style";
const ASSIST_BANNER_ID = "proxy-shopper-assist-banner";
const HIGHLIGHT_CLASS = "proxy-shopper-highlight";

function injectAssistStyles(): void {
  if (document.getElementById(ASSIST_STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = ASSIST_STYLE_ID;
  style.textContent = `
    @keyframes proxy-shopper-pulse {
      0%, 100% { box-shadow: 0 0 0 3px rgba(230, 180, 80, 0.95), 0 0 18px 4px rgba(230, 180, 80, 0.55); }
      50% { box-shadow: 0 0 0 6px rgba(230, 180, 80, 0.5), 0 0 26px 8px rgba(230, 180, 80, 0.35); }
    }
    .${HIGHLIGHT_CLASS} {
      animation: proxy-shopper-pulse 1.4s ease-in-out infinite;
      border-radius: 8px;
      position: relative;
      z-index: 2;
    }
    #${ASSIST_BANNER_ID} {
      position: fixed; top: 0; left: 0; right: 0; z-index: 2147483647;
      display: flex; align-items: center; justify-content: center; gap: 12px;
      padding: 10px 16px;
      background: linear-gradient(90deg, #1d2531, #11151c);
      border-bottom: 2px solid #e6b450;
      color: #ece6d6; font: 600 14px/1.4 system-ui, sans-serif;
      box-shadow: 0 2px 16px rgba(0,0,0,0.5);
    }
    #${ASSIST_BANNER_ID} button {
      background: rgba(230,180,80,0.16); color: #e6b450; border: 1px solid #b8881f;
      border-radius: 6px; padding: 4px 10px; font: 600 13px system-ui, sans-serif; cursor: pointer;
    }
  `;
  document.head.appendChild(style);
}

function findPurchaseButtons(): Element[] {
  const buttons: Element[] = [];
  for (const selector of [
    '[data-test="shippingButton"]',
    '[data-test="orderPickupButton"]',
    '[data-test="scheduledDeliveryButton"]',
  ]) {
    const el = document.querySelector(selector);
    if (el) buttons.push(el);
  }
  if (buttons.length === 0) {
    const generic = Array.from(document.querySelectorAll("button")).find((b) =>
      /add to cart/i.test(b.textContent ?? ""),
    );
    if (generic) buttons.push(generic);
  }
  return buttons;
}

function setBanner(message: string): void {
  injectAssistStyles();
  let banner = document.getElementById(ASSIST_BANNER_ID);
  if (!banner) {
    banner = document.createElement("div");
    banner.id = ASSIST_BANNER_ID;
    const text = document.createElement("span");
    text.className = "psa-text";
    const dismiss = document.createElement("button");
    dismiss.textContent = "Dismiss";
    dismiss.addEventListener("click", () => {
      banner?.remove();
      document
        .querySelectorAll(`.${HIGHLIGHT_CLASS}`)
        .forEach((el) => el.classList.remove(HIGHLIGHT_CLASS));
    });
    banner.append(text, dismiss);
    document.body.prepend(banner);
  }
  const span = banner.querySelector(".psa-text");
  if (span) span.textContent = message;
}

function highlightAndScroll(buttons: Element[]): void {
  buttons.forEach((b) => b.classList.add(HIGHLIGHT_CLASS));
  if (buttons.length > 0) buttons[0].scrollIntoView({ behavior: "smooth", block: "center" });
}

const FILL_BTN_ID = "proxy-shopper-fill-btn";

/** Add a "Fill my info" button to the banner (checkout pages only). */
function ensureFillButton(): void {
  const banner = document.getElementById(ASSIST_BANNER_ID);
  if (!banner || document.getElementById(FILL_BTN_ID)) return;
  const btn = document.createElement("button");
  btn.id = FILL_BTN_ID;
  btn.textContent = "Fill my info";
  btn.addEventListener("click", () => void handleFillClick());
  // Insert before the Dismiss button (last child).
  banner.insertBefore(btn, banner.lastChild);
}

function showAssist(info: AssistInfo): void {
  setBanner(
    `Proxy Shopper — ${info.reason ?? "Opportunity"}: ${info.productName ?? "your watched product"}. Complete your purchase below.`,
  );
  // Buttons render late on hydrated pages — retry highlighting for a while.
  let attempts = 0;
  const tryHighlight = () => {
    const buttons = findPurchaseButtons();
    highlightAndScroll(buttons);
    if (buttons.length === 0 && attempts++ < 10) setTimeout(tryHighlight, 1000);
  };
  tryHighlight();
}

// --- Express Lane -----------------------------------------------------------
//
// Speeds you to a ready-to-confirm purchase: auto-clicks "Add to cart", then
// opens the cart. It deliberately STOPS before the final "Place order" — that
// click is always yours. Proxy Shopper never submits an order unattended.

const PLACED_FLAG = "proxy-shopper-expresslane-added";

function findAddToCartButton(): HTMLButtonElement | null {
  for (const selector of [
    '[data-test="shippingButton"]',
    '[data-test="orderPickupButton"]',
    '[data-test="scheduledDeliveryButton"]',
  ]) {
    const el = document.querySelector<HTMLButtonElement>(selector);
    if (el && !el.disabled) return el;
  }
  const generic = Array.from(document.querySelectorAll("button")).find(
    (b) => /add to cart/i.test(b.textContent ?? "") && !(b as HTMLButtonElement).disabled,
  );
  return (generic as HTMLButtonElement) ?? null;
}

function runExpressLane(info: AssistInfo): void {
  // Only act once per product page load.
  try {
    if (sessionStorage.getItem(PLACED_FLAG) === location.href) return;
  } catch {
    /* ignore */
  }

  let attempts = 0;
  const tryAdd = () => {
    const button = findAddToCartButton();
    if (!button) {
      if (attempts++ < 12) setTimeout(tryAdd, 1000);
      return;
    }
    try {
      sessionStorage.setItem(PLACED_FLAG, location.href);
    } catch {
      /* ignore */
    }
    setBanner(
      `Proxy Shopper Express Lane — adding ${info.productName ?? "your item"} to cart…`,
    );
    button.click();
    // Give Target's cart mutation a moment, then go to the cart so the
    // "Place order" button is one tap away. We stop here — you confirm.
    setTimeout(() => {
      setBanner("Proxy Shopper — item in your cart. Review and place your order when ready.");
      window.location.assign("https://www.target.com/cart");
    }, 2500);
  };
  tryAdd();
}

// --- Checkout field filling (contact + shipping only) -----------------------
//
// Fills NON-SENSITIVE fields from the user's saved profile when they click
// "Fill my info". It never touches payment fields (card number, CVV, etc.) —
// those are matched by PAYMENT_FIELD_RE and explicitly skipped. Card data is
// left entirely to the user's Target account / Chrome autofill.

const PAYMENT_FIELD_RE =
  /(card|cc-|cardnumber|creditcard|cvv|cvc|security[-_ ]?code|expir|exp-|password|passwd)/i;

/** Set a value on a React-controlled input so the framework registers it. */
function setNativeValue(el: HTMLInputElement, value: string): void {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  setter ? setter.call(el, value) : (el.value = value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

/** Identifying text for a field, from its attributes + associated label. */
function fieldSignature(el: HTMLInputElement): string {
  const label = el.id ? document.querySelector(`label[for="${el.id}"]`)?.textContent ?? "" : "";
  return [
    el.getAttribute("autocomplete"),
    el.getAttribute("name"),
    el.id,
    el.getAttribute("placeholder"),
    el.getAttribute("aria-label"),
    label,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

interface FieldRule {
  value: string;
  /** Matches in priority order; first matching, empty field is filled. */
  match: RegExp;
}

function fillCheckoutFields(profile: CheckoutProfile): number {
  const rules: FieldRule[] = [
    { value: profile.email, match: /email/ },
    { value: profile.phone, match: /(phone|tel\b|mobile)/ },
    { value: profile.firstName, match: /(given-name|first[-_ ]?name|fname)/ },
    { value: profile.lastName, match: /(family-name|last[-_ ]?name|lname|surname)/ },
    { value: profile.address2, match: /(address-line2|address[-_ ]?2|apt|suite|unit)/ },
    { value: profile.address1, match: /(address-line1|address[-_ ]?1|street|addr)/ },
    { value: profile.city, match: /(address-level2|\bcity\b|town)/ },
    { value: profile.state, match: /(address-level1|\bstate\b|province|region)/ },
    { value: profile.zip, match: /(postal-code|\bzip\b|postcode|postal)/ },
  ];

  const inputs = Array.from(
    document.querySelectorAll<HTMLInputElement>("input, textarea, select"),
  ).filter((el) => {
    if (el.disabled || el.readOnly || el.type === "hidden") return false;
    const sig = fieldSignature(el);
    return !PAYMENT_FIELD_RE.test(sig); // never fill payment / password fields
  });

  let filled = 0;
  for (const rule of rules) {
    if (!rule.value.trim()) continue;
    const target = inputs.find((el) => el.value.trim() === "" && rule.match.test(fieldSignature(el)));
    if (target) {
      setNativeValue(target, rule.value);
      filled++;
    }
  }
  return filled;
}

async function handleFillClick(): Promise<void> {
  const profile = await getProfile();
  if (!profileHasData(profile)) {
    setBanner("Proxy Shopper — add your contact & shipping info in Options first, then Fill my info.");
    return;
  }
  const count = fillCheckoutFields(profile);
  setBanner(
    count > 0
      ? `Proxy Shopper — filled ${count} field${count === 1 ? "" : "s"}. Review everything, then place your order.`
      : "Proxy Shopper — no matching fields found on this page to fill.",
  );
}

// --- Auto-advance intermediate checkout steps -------------------------------
//
// Clicks ONLY non-committal "continue"-style buttons to move through Target's
// multi-step checkout. The final order-submitting button is matched by
// FINAL_ORDER_RE and is NEVER clicked here — that action stays the user's.

/** Buttons that submit/charge the order. Never auto-clicked. Checked FIRST. */
const FINAL_ORDER_RE =
  /(place\s*(your)?\s*order|submit\s*order|pay\s*now|complete\s*(your)?\s*(purchase|order)|buy\s*now|confirm\s*(and\s*)?pay)/i;

/** Non-committal step-advance buttons that are safe to auto-click. */
const INTERMEDIATE_RE =
  /(save\s*(and|&)\s*continue|continue\s*to\s*\w+|continue|review\s*(your)?\s*order|proceed|next\s*step|^next$|go\s*to\s*checkout|check\s*out)/i;

const FINAL_ORDER_SELECTORS = [
  '[data-test="placeOrderButton"]',
  '[data-test="place-order-button"]',
  '[data-test="completeOrderButton"]',
];

function buttonText(el: Element): string {
  return (el.textContent ?? "").replace(/\s+/g, " ").trim();
}

function isVisible(el: HTMLElement): boolean {
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 && el.offsetParent !== null;
}

/** True if this element is (or is inside) a known final-order control. */
function isFinalOrderControl(el: Element): boolean {
  if (FINAL_ORDER_SELECTORS.some((sel) => el.closest(sel))) return true;
  return FINAL_ORDER_RE.test(buttonText(el));
}

/** The next safe intermediate button to click, or null. */
function findIntermediateButton(): HTMLElement | null {
  const candidates = Array.from(
    document.querySelectorAll<HTMLElement>('button, [role="button"], a[data-test]'),
  );
  for (const el of candidates) {
    if (el instanceof HTMLButtonElement && el.disabled) continue;
    if (el.getAttribute("aria-disabled") === "true") continue;
    if (!isVisible(el)) continue;
    const text = buttonText(el);
    if (!text) continue;
    // Safety: skip anything that looks like the final submit, always.
    if (isFinalOrderControl(el)) continue;
    if (INTERMEDIATE_RE.test(text)) return el;
  }
  return null;
}

const MAX_AUTO_ADVANCES = 6;
let advancesDone = 0;
let advanceTimer: number | undefined;
const clickedButtons = new WeakSet<Element>();

/**
 * Walk forward through intermediate steps. Re-arms itself after each click and
 * stops as soon as the final order button is on screen (or the cap is hit).
 */
function autoAdvanceCheckout(): void {
  window.clearTimeout(advanceTimer);

  // Stop the moment the final submit screen is reached — highlight, don't click.
  const finalButton =
    FINAL_ORDER_SELECTORS.map((s) => document.querySelector<HTMLElement>(s)).find(Boolean) ??
    Array.from(document.querySelectorAll<HTMLElement>('button, [role="button"]')).find(
      (b) => isVisible(b) && FINAL_ORDER_RE.test(buttonText(b)),
    );
  if (finalButton) {
    setBanner("Proxy Shopper — final step reached. Review, then press the highlighted button to buy.");
    ensureFillButton();
    highlightAndScroll([finalButton]);
    return;
  }

  if (advancesDone >= MAX_AUTO_ADVANCES) {
    setBanner("Proxy Shopper — auto-advance paused. Continue manually from here.");
    return;
  }

  const button = findIntermediateButton();
  if (button && !clickedButtons.has(button)) {
    clickedButtons.add(button);
    advancesDone++;
    setBanner(`Proxy Shopper — advancing checkout (“${buttonText(button)}”)…`);
    button.click();
  }
  // Checkout re-renders async; check again shortly whether we clicked or not.
  advanceTimer = window.setTimeout(autoAdvanceCheckout, 1500);
}

/** On the cart/checkout page, highlight (never click) the final order button. */
function highlightCheckout(): void {
  let attempts = 0;
  const tryHighlight = () => {
    const button =
      document.querySelector('[data-test="checkout-button"]') ??
      document.querySelector('[data-test="placeOrderButton"]') ??
      Array.from(document.querySelectorAll("button")).find((b) =>
        /place order|checkout/i.test(b.textContent ?? ""),
      );
    if (button) {
      setBanner("Proxy Shopper — review your details, then press the highlighted button to buy.");
      ensureFillButton();
      highlightAndScroll([button]);
    } else if (attempts++ < 10) {
      setTimeout(tryHighlight, 1000);
    }
  };
  // Show the banner + Fill button right away; keep retrying for the buy button.
  setBanner("Proxy Shopper — checkout ready. Use “Fill my info”, then place your order.");
  ensureFillButton();
  tryHighlight();
}

async function checkAssist(url: string): Promise<void> {
  // Cart / checkout pages: highlight the final confirm button.
  try {
    const parsed = new URL(url);
    if (parsed.hostname.endsWith("target.com") && /\/(cart|checkout)/.test(parsed.pathname)) {
      highlightCheckout();
      const settings = await getSettings();
      // Auto-advance only on checkout itself, not the cart page.
      if (
        settings.enableProxyAssist &&
        settings.assistAutoAdvanceCheckout &&
        /\/checkout/.test(parsed.pathname)
      ) {
        autoAdvanceCheckout();
      }
      return;
    }
  } catch {
    /* ignore */
  }

  const adapter = getAdapterForUrl(url);
  if (!adapter) return;
  const productId = await adapter.extractProductId(url, document);
  if (!productId) return;
  const info = await sendToBackground<AssistInfo>({
    type: "GET_ASSIST_INFO",
    retailerId: adapter.retailerId,
    productId,
  });
  if (!info?.active) return;

  showAssist(info);
  const settings = await getSettings();
  if (settings.enableProxyAssist && settings.assistAutoAddToCart) {
    runExpressLane(info);
  }
}

// ---------------------------------------------------------------------------
// "Through the queue" detection
// ---------------------------------------------------------------------------
//
// When Queue-it lets you out of a waiting room it sends you back to the
// retailer with a `queueittoken` on the URL. Landing here with that token means
// you just cleared the line — time to buy. We report it once per token so the
// background can ping you; we never touch the token or the queue itself.

function maybeReportQueuePassed(url: string): void {
  let token: string | null = null;
  try {
    token = new URL(url).searchParams.get("queueittoken");
  } catch {
    /* not parseable — nothing to do */
  }
  if (!token) return;

  const seenKey = `proxy-shopper-queue-passed:${token.slice(0, 24)}`;
  try {
    if (sessionStorage.getItem(seenKey)) return;
    sessionStorage.setItem(seenKey, "1");
  } catch {
    /* sessionStorage blocked — background dedupe still guards against spam */
  }

  void sendToBackground({
    type: "QUEUE_EVENT",
    phase: "passed",
    host: location.hostname,
    pageUrl: location.href,
    retailerName: getAdapterForUrl(url)?.retailerName,
  });
}

// ---------------------------------------------------------------------------
// Boot + SPA navigation handling
// ---------------------------------------------------------------------------

let currentUrl = "";

function onPageEnter(): void {
  const url = location.href;
  currentUrl = url;
  removeWatchPrompt();
  removeWatchingBadge();
  // Leaving checkout: stop any pending auto-advance and reset its budget so a
  // future checkout visit starts clean.
  if (!/\/checkout/.test(url)) {
    window.clearTimeout(advanceTimer);
    advancesDone = 0;
  }
  maybeReportQueuePassed(url);
  void extractAndReport(url);
  void checkAssist(url);
}

onPageEnter();

// Target navigates client-side; poll for URL changes cheaply.
setInterval(() => {
  if (location.href !== currentUrl) onPageEnter();
}, 2000);
