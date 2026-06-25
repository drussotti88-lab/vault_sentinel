import type { RetailerAdapter } from "../RetailerAdapter";
import type { AvailabilityStatus, ProductData } from "../../types";
import { parsePrice } from "../../utils/format";

/**
 * Target.com adapter.
 *
 * Identity is the TCIN (Target Catalog Item Number). The adapter extracts it
 * from any Target product URL shape, can recover it from a live page's DOM,
 * and rebuilds navigation URLs from it. Price/availability extraction is
 * layered so that a redesign of any single surface degrades gracefully:
 *
 *   1. Background: Target's own public product API (redsky), keyed by TCIN.
 *   2. Live DOM selectors (data-test attributes) — most accurate on a
 *      hydrated page.
 *   3. JSON-LD (<script type="application/ld+json">).
 *   4. Embedded state (__TGT_DATA__) — scanned with targeted regexes.
 *   5. Open Graph meta tags — name and image fallback.
 *
 * Every field falls back independently; anything undeterminable becomes
 * undefined / "unknown" rather than an exception.
 */

const RETAILER_ID = "target";
const PRODUCT_PATH_RE = /^\/p\//i;
// TCIN appears as "A-<digits>" in every URL shape. Digit-length-agnostic.
const TCIN_URL_RE = /\bA-(\d{4,})\b/i;
const FALLBACK_API_KEY = "9f36aeafbe60771e321a7cc95a78140772ab3e96";

function isTargetHost(hostname: string): boolean {
  return hostname === "target.com" || hostname.endsWith(".target.com");
}

// --- TCIN extraction --------------------------------------------------------

function tcinFromUrl(url: string): string | null {
  // Try the structured path first, then a loose scan (handles query strings,
  // ?preselect=, deep links, etc.).
  try {
    const parsed = new URL(url);
    const fromPath = parsed.pathname.match(TCIN_URL_RE);
    if (fromPath) return fromPath[1];
  } catch {
    /* fall through to loose scan */
  }
  return url.match(TCIN_URL_RE)?.[1] ?? null;
}

function tcinFromDocument(doc: Document): string | null {
  // Canonical link is the most reliable: <link rel="canonical" href=".../A-12345">
  const canonical = doc.querySelector('link[rel="canonical"]')?.getAttribute("href");
  const fromCanonical = canonical ? tcinFromUrl(canonical) : null;
  if (fromCanonical) return fromCanonical;

  // Known meta / data attributes.
  const metaTcin =
    doc.querySelector('meta[itemprop="productID"]')?.getAttribute("content") ??
    doc.querySelector("[data-tcin]")?.getAttribute("data-tcin");
  if (metaTcin) {
    const digits = metaTcin.match(/(\d{4,})/);
    if (digits) return digits[1];
  }

  // Last resort: scan embedded JSON for a "tcin" field.
  for (const script of Array.from(doc.querySelectorAll("script:not([src])"))) {
    const text = script.textContent ?? "";
    if (!text.includes("tcin")) continue;
    const m = text.match(/"tcin"\s*:\s*"?(\d{4,})"?/);
    if (m) return m[1];
  }
  return null;
}

// --- Layer: JSON-LD ---------------------------------------------------------

function mapSchemaAvailability(value: unknown): AvailabilityStatus | undefined {
  if (typeof value !== "string") return undefined;
  const v = value.toLowerCase();
  if (v.includes("instock") || v.includes("preorder") || v.includes("limitedavailability")) {
    return "in_stock";
  }
  if (v.includes("outofstock") || v.includes("soldout") || v.includes("discontinued")) {
    return "out_of_stock";
  }
  return undefined;
}

function findProductNode(node: unknown): Record<string, unknown> | undefined {
  if (node == null || typeof node !== "object") return undefined;
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findProductNode(item);
      if (found) return found;
    }
    return undefined;
  }
  const obj = node as Record<string, unknown>;
  const type = obj["@type"];
  const types = Array.isArray(type) ? type : [type];
  if (types.some((t) => typeof t === "string" && t.toLowerCase() === "product")) {
    return obj;
  }
  if (obj["@graph"]) return findProductNode(obj["@graph"]);
  return undefined;
}

interface PartialExtraction {
  productName?: string;
  imageUrl?: string;
  currentPrice?: number;
  originalPrice?: number;
  availabilityStatus?: AvailabilityStatus;
  shippingAvailable?: boolean;
  pickupAvailable?: boolean;
}

function extractFromJsonLd(doc: Document): PartialExtraction {
  const out: PartialExtraction = {};
  for (const script of Array.from(doc.querySelectorAll('script[type="application/ld+json"]'))) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(script.textContent ?? "");
    } catch {
      continue;
    }
    const product = findProductNode(parsed);
    if (!product) continue;

    if (typeof product.name === "string") out.productName = product.name;
    const image = product.image;
    if (typeof image === "string") out.imageUrl = image;
    else if (Array.isArray(image) && typeof image[0] === "string") out.imageUrl = image[0];

    const offersRaw = product.offers;
    const offers = Array.isArray(offersRaw) ? offersRaw : [offersRaw];
    for (const offer of offers) {
      if (offer == null || typeof offer !== "object") continue;
      const o = offer as Record<string, unknown>;
      const price = o.price ?? o.lowPrice;
      if (out.currentPrice == null && (typeof price === "number" || typeof price === "string")) {
        const value = Number(price);
        if (Number.isFinite(value)) out.currentPrice = value;
      }
      if (out.availabilityStatus == null) out.availabilityStatus = mapSchemaAvailability(o.availability);
    }
    break;
  }
  return out;
}

// --- Layer: embedded state --------------------------------------------------

function extractFromEmbeddedState(doc: Document): PartialExtraction {
  const out: PartialExtraction = {};
  for (const script of Array.from(doc.querySelectorAll("script:not([src])"))) {
    const text = script.textContent ?? "";
    if (text.length < 500 || !text.includes("current_retail")) continue;
    if (out.currentPrice == null) {
      const m = text.match(/"current_retail"\s*:\s*(\d+(?:\.\d+)?)/);
      if (m) out.currentPrice = Number(m[1]);
    }
    if (out.originalPrice == null) {
      const m = text.match(/"reg_retail"\s*:\s*(\d+(?:\.\d+)?)/);
      if (m) out.originalPrice = Number(m[1]);
    }
    if (out.availabilityStatus == null) {
      const statuses = Array.from(
        text.matchAll(/"availability_status"\s*:\s*"([A-Z_]+)"/g),
        (match) => match[1],
      );
      if (statuses.length > 0) {
        const sellable = statuses.filter(
          (s) => s === "IN_STOCK" || s === "PRE_ORDER_SELLABLE" || s === "BACKORDER_SELLABLE",
        );
        out.availabilityStatus = sellable.length > 0 ? "in_stock" : "out_of_stock";
      }
    }
    if (out.currentPrice != null && out.availabilityStatus != null) break;
  }
  return out;
}

// --- Layer: Open Graph ------------------------------------------------------

function extractFromMeta(doc: Document): PartialExtraction {
  const out: PartialExtraction = {};
  const title = doc.querySelector('meta[property="og:title"]')?.getAttribute("content");
  if (title) out.productName = title.replace(/\s*:\s*Target\s*$/i, "").trim();
  const image = doc.querySelector('meta[property="og:image"]')?.getAttribute("content");
  if (image) out.imageUrl = image;
  return out;
}

// --- Layer: live DOM --------------------------------------------------------

function buttonIsUsable(button: Element | null): boolean {
  return !!button && !(button as HTMLButtonElement).disabled;
}

function extractFromLiveDom(doc: Document): PartialExtraction {
  const out: PartialExtraction = {};
  const title = doc.querySelector('[data-test="product-title"]');
  if (title?.textContent?.trim()) out.productName = title.textContent.trim();

  out.currentPrice = parsePrice(doc.querySelector('[data-test="product-price"]')?.textContent);
  out.originalPrice = parsePrice(doc.querySelector('[data-test="product-regular-price"]')?.textContent);

  const image = doc.querySelector<HTMLImageElement>(
    '[data-test="image-gallery-item-0"] img, [data-test^="image-gallery"] img, picture img',
  );
  if (image?.src) out.imageUrl = image.src;

  const shipping = doc.querySelector('[data-test="shippingButton"]');
  const pickup = doc.querySelector('[data-test="orderPickupButton"]');
  const delivery = doc.querySelector('[data-test="scheduledDeliveryButton"]');
  const genericAddToCart = Array.from(doc.querySelectorAll("button")).find((b) =>
    /add to cart/i.test(b.textContent ?? ""),
  );

  const shippingOk = buttonIsUsable(shipping);
  const pickupOk = buttonIsUsable(pickup);
  const anyOk = shippingOk || pickupOk || buttonIsUsable(delivery) || buttonIsUsable(genericAddToCart ?? null);

  if (shipping) out.shippingAvailable = shippingOk;
  if (pickup) out.pickupAvailable = pickupOk;

  if (anyOk) {
    out.availabilityStatus = "in_stock";
  } else if (
    doc.querySelector('[data-test*="outOfStock" i]') ||
    /\bout of stock\b/i.test(
      doc.querySelector('[data-test="fulfillment-section"], [data-test="fulfillment"]')?.textContent ?? "",
    )
  ) {
    out.availabilityStatus = "out_of_stock";
  } else if (shipping || pickup || delivery || genericAddToCart) {
    out.availabilityStatus = "out_of_stock";
  }
  return out;
}

// --- Background fetch (redsky API, keyed by TCIN) ---------------------------

interface JsonScan {
  currentPrice?: number;
  originalPrice?: number;
  availabilityStatus?: AvailabilityStatus;
  shippingAvailable?: boolean;
  pickupAvailable?: boolean;
  title?: string;
  imageUrl?: string;
}

function scanRedskyJson(node: unknown, out: JsonScan, path: string[] = []): void {
  if (node == null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) scanRedskyJson(item, out, path);
    return;
  }
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === "current_retail" && typeof value === "number" && out.currentPrice == null) {
      out.currentPrice = value;
    } else if (key === "reg_retail" && typeof value === "number" && out.originalPrice == null) {
      out.originalPrice = value;
    } else if (key === "availability_status" && typeof value === "string") {
      const sellable = value === "IN_STOCK" || value === "PRE_ORDER_SELLABLE" || value === "BACKORDER_SELLABLE";
      if (sellable) out.availabilityStatus = "in_stock";
      else if (out.availabilityStatus == null) out.availabilityStatus = "out_of_stock";
      if (path.includes("shipping_options")) out.shippingAvailable = sellable || out.shippingAvailable === true;
      if (path.includes("store_options") || path.includes("order_pickup")) {
        out.pickupAvailable = sellable || out.pickupAvailable === true;
      }
    } else if (key === "is_out_of_stock_in_all_online_locations" && value === true) {
      out.availabilityStatus = "out_of_stock";
    } else if (key === "title" && typeof value === "string" && out.title == null && path.includes("product_description")) {
      out.title = value;
    } else if (key === "primary_image_url" && typeof value === "string" && out.imageUrl == null) {
      out.imageUrl = value;
    } else {
      scanRedskyJson(value, out, [...path, key]);
    }
  }
}

function ogContent(html: string, property: string): string | undefined {
  const re = new RegExp(
    `<meta[^>]+(?:property=["']${property}["'][^>]+content=["']([^"']*)["']|content=["']([^"']*)["'][^>]+property=["']${property}["'])`,
    "i",
  );
  const match = html.match(re);
  return match ? (match[1] ?? match[2]) : undefined;
}

async function fetchTargetProductData(productId: string): Promise<ProductData> {
  const url = buildTargetUrl(productId);

  // 1. Product page HTML: name + image via Open Graph, plus the API key.
  const pageResponse = await fetch(url, {
    credentials: "omit",
    cache: "no-store",
    headers: { accept: "text/html" },
  });
  if (!pageResponse.ok) throw new Error(`Product page returned HTTP ${pageResponse.status}`);
  const html = await pageResponse.text();

  const name = ogContent(html, "og:title")?.replace(/\s*:\s*Target\s*$/i, "").trim();
  const imageUrl = ogContent(html, "og:image");
  const apiKey = html.match(/apiKey\\?["']?\s*:\s*\\?["']([0-9a-f]{30,})/)?.[1] ?? FALLBACK_API_KEY;

  // 2. Price + availability from the page's own product API, keyed by TCIN.
  const scan: JsonScan = {};
  try {
    const api = new URL("https://redsky.target.com/redsky_aggregations/v1/web/pdp_client_v1");
    api.searchParams.set("key", apiKey);
    api.searchParams.set("tcin", productId);
    api.searchParams.set("is_bot", "false");
    api.searchParams.set("channel", "WEB");
    api.searchParams.set("page", `/p/A-${productId}`);
    const apiResponse = await fetch(api.toString(), {
      credentials: "omit",
      cache: "no-store",
      headers: { accept: "application/json" },
    });
    if (apiResponse.ok) scanRedskyJson(await apiResponse.json(), scan);
  } catch {
    /* API unavailable — fall through with whatever the HTML gave us. */
  }

  return {
    retailerId: RETAILER_ID,
    productId,
    productName: scan.title ?? name ?? "Unknown product",
    imageUrl: scan.imageUrl ?? imageUrl,
    currentPrice: scan.currentPrice,
    originalPrice: scan.originalPrice,
    availabilityStatus: scan.availabilityStatus ?? "unknown",
    shippingAvailable: scan.shippingAvailable,
    pickupAvailable: scan.pickupAvailable,
    lastCheckedAt: new Date().toISOString(),
  };
}

// --- Adapter ----------------------------------------------------------------

function buildTargetUrl(productId: string): string {
  // Slug is cosmetic; only A-<TCIN> is load-bearing.
  return `https://www.target.com/p/proxy-shopper/A-${productId}`;
}

function pick<K extends keyof PartialExtraction>(
  key: K,
  layers: PartialExtraction[],
): PartialExtraction[K] {
  for (const layer of layers) {
    const value = layer[key];
    if (value !== undefined && value !== "unknown") return value;
  }
  return undefined;
}

export const targetAdapter: RetailerAdapter = {
  retailerId: RETAILER_ID,
  retailerName: "Target",

  matchesUrl(url: string): boolean {
    try {
      const parsed = new URL(url);
      return isTargetHost(parsed.hostname) && PRODUCT_PATH_RE.test(parsed.pathname);
    } catch {
      return false;
    }
  },

  async extractProductId(url: string, doc?: Document): Promise<string | null> {
    return tcinFromUrl(url) ?? (doc ? tcinFromDocument(doc) : null);
  },

  buildProductUrl: buildTargetUrl,

  fetchProductData: fetchTargetProductData,

  async extractProductData(doc: Document, productId: string): Promise<ProductData> {
    const layers: PartialExtraction[] = [];
    for (const extract of [extractFromLiveDom, extractFromJsonLd, extractFromEmbeddedState, extractFromMeta]) {
      try {
        layers.push(extract(doc));
      } catch {
        /* tolerate individual layer failure */
      }
    }
    return {
      retailerId: RETAILER_ID,
      productId,
      productName: pick("productName", layers) ?? "Unknown product",
      imageUrl: pick("imageUrl", layers),
      currentPrice: pick("currentPrice", layers),
      originalPrice: pick("originalPrice", layers),
      availabilityStatus: pick("availabilityStatus", layers) ?? "unknown",
      shippingAvailable: pick("shippingAvailable", layers),
      pickupAvailable: pick("pickupAvailable", layers),
      lastCheckedAt: new Date().toISOString(),
    };
  },
};
