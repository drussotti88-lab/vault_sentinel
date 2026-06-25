import type { RetailerAdapter } from "../RetailerAdapter";
import type { AvailabilityStatus, ProductData } from "../../types";
import { parsePrice } from "../../utils/format";

/**
 * Pokémon Center adapter.
 *
 * Identity is the product id in the URL path: /product/<id>/<slug>.
 *
 * Pokémon Center sits behind Cloudflare, so a background fetch from the service
 * worker is blocked (403). There is intentionally no fetchProductData(): the
 * reliable path is the content script reading the *live* page in the user's own
 * browser — which Cloudflare serves normally — so monitoring works while a PC
 * product tab is open. Background checks simply error out without clobbering the
 * live state. Extraction is layered (JSON-LD → __NEXT_DATA__ → live DOM → Open
 * Graph) and degrades to "unknown" rather than throwing.
 */

const RETAILER_ID = "pokemon_center";
const PRODUCT_PATH_RE = /\/product\//i;
const PRODUCT_ID_RE = /\/product\/([^/?#]+)/i;

function isPokemonCenterHost(hostname: string): boolean {
  return hostname === "pokemoncenter.com" || hostname.endsWith(".pokemoncenter.com");
}

function idFromUrl(url: string): string | null {
  try {
    const m = new URL(url).pathname.match(PRODUCT_ID_RE);
    if (m) return decodeURIComponent(m[1]);
  } catch {
    /* fall through to loose scan */
  }
  return url.match(PRODUCT_ID_RE)?.[1] ?? null;
}

function idFromDocument(doc: Document): string | null {
  const canonical = doc.querySelector('link[rel="canonical"]')?.getAttribute("href");
  return canonical ? idFromUrl(canonical) : null;
}

interface PartialExtraction {
  productName?: string;
  imageUrl?: string;
  currentPrice?: number;
  availabilityStatus?: AvailabilityStatus;
}

function mapSchemaAvailability(value: unknown): AvailabilityStatus | undefined {
  if (typeof value !== "string") return undefined;
  const v = value.toLowerCase();
  if (
    v.includes("instock") ||
    v.includes("preorder") ||
    v.includes("limitedavailability") ||
    v.includes("backorder")
  ) {
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
  if (types.some((t) => typeof t === "string" && t.toLowerCase() === "product")) return obj;
  if (obj["@graph"]) return findProductNode(obj["@graph"]);
  return undefined;
}

// --- Layer: JSON-LD ---------------------------------------------------------

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

// --- Layer: __NEXT_DATA__ (Elastic Path Cortex) -----------------------------

function extractFromNextData(doc: Document): PartialExtraction {
  const out: PartialExtraction = {};
  const text = doc.querySelector("#__NEXT_DATA__")?.textContent ?? "";
  if (!text) return out;
  // Cortex exposes availability as a `state` of available / not_available.
  if (/"state"\s*:\s*"available"/i.test(text)) out.availabilityStatus = "in_stock";
  else if (/"state"\s*:\s*"not_available"/i.test(text)) out.availabilityStatus = "out_of_stock";
  // A formatted price like "display":"$19.99".
  const display = text.match(/"display"\s*:\s*"(\$[\d.,]+)"/i)?.[1];
  if (display) out.currentPrice = parsePrice(display);
  return out;
}

// --- Layer: live DOM --------------------------------------------------------

function buttonIsUsable(button: Element | null): boolean {
  return !!button && !(button as HTMLButtonElement).disabled;
}

function extractFromLiveDom(doc: Document): PartialExtraction {
  const out: PartialExtraction = {};

  const heading = doc.querySelector("h1");
  if (heading?.textContent?.trim()) out.productName = heading.textContent.trim();

  const priceEl = doc.querySelector('[data-testid*="price" i], [class*="price" i], [itemprop="price"]');
  const price = parsePrice(priceEl?.textContent) ?? parsePrice(priceEl?.getAttribute("content"));
  if (price != null) out.currentPrice = price;

  const addToCart = Array.from(doc.querySelectorAll("button")).find((b) =>
    /add to cart|add to bag/i.test(b.textContent ?? ""),
  );
  if (buttonIsUsable(addToCart ?? null)) {
    out.availabilityStatus = "in_stock";
  } else if (/sold out|out of stock|notify me|currently unavailable/i.test(doc.body?.textContent ?? "")) {
    out.availabilityStatus = "out_of_stock";
  } else if (addToCart) {
    out.availabilityStatus = "out_of_stock"; // present but disabled
  }
  return out;
}

// --- Layer: Open Graph ------------------------------------------------------

function extractFromMeta(doc: Document): PartialExtraction {
  const out: PartialExtraction = {};
  const title = doc.querySelector('meta[property="og:title"]')?.getAttribute("content");
  if (title) out.productName = title.replace(/\s*[|:]\s*Pok[eé]mon Center.*$/i, "").trim();
  const image = doc.querySelector('meta[property="og:image"]')?.getAttribute("content");
  if (image) out.imageUrl = image;
  return out;
}

function pick<K extends keyof PartialExtraction>(key: K, layers: PartialExtraction[]): PartialExtraction[K] {
  for (const layer of layers) {
    const value = layer[key];
    if (value !== undefined && value !== "unknown") return value;
  }
  return undefined;
}

function buildPokemonCenterUrl(productId: string): string {
  return `https://www.pokemoncenter.com/product/${productId}`;
}

export const pokemonCenterAdapter: RetailerAdapter = {
  retailerId: RETAILER_ID,
  retailerName: "Pokémon Center",

  matchesUrl(url: string): boolean {
    try {
      const parsed = new URL(url);
      return isPokemonCenterHost(parsed.hostname) && PRODUCT_PATH_RE.test(parsed.pathname);
    } catch {
      return false;
    }
  },

  async extractProductId(url: string, doc?: Document): Promise<string | null> {
    return idFromUrl(url) ?? (doc ? idFromDocument(doc) : null);
  },

  buildProductUrl: buildPokemonCenterUrl,

  async extractProductData(doc: Document, productId: string): Promise<ProductData> {
    const layers: PartialExtraction[] = [];
    for (const extract of [extractFromJsonLd, extractFromNextData, extractFromLiveDom, extractFromMeta]) {
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
      availabilityStatus: pick("availabilityStatus", layers) ?? "unknown",
      lastCheckedAt: new Date().toISOString(),
    };
  },
};
