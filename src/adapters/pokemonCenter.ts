import type {
  RetailerAdapter,
  CheckResult,
  AdapterContext,
  ResolveResult,
  DiscoveredProduct,
} from './types.js';
import { errorResult, DISCOVER_PREFIX, isDiscoverDirective, parseDiscover } from './types.js';
import { browserHeaders } from '../lib/userAgents.js';
import { HttpError } from '../lib/http.js';
import type { Watch } from '../db/types.js';

/**
 * Pokémon Center — reliability: BEST-EFFORT + QUEUE-AWARE (PRD §11.4).
 *
 * Design stance: detect-and-notify ONLY. This adapter NEVER tries to sit in,
 * bypass, or fast-forward the virtual queue. Doing so is against ToS,
 * technically fragile, and exactly the behavior PC's anti-bot is built to
 * punish (PRD §24). It senses two things:
 *
 *   1. Queue idle  -> poll product availability -> normal stock signal.
 *   2. Queue active -> emit a situational-awareness alert ("a drop is
 *      happening, get in line manually"). Queue-active is itself the news.
 *
 * Cadence is gentle (60s idle); on queue-active it drops to a low-frequency
 * status poll and signals the scheduler not to escalate (PRD §16).
 *
 * Config (retailer.config):
 *   inventoryUrl — URL template for product availability ({slug} placeholder)
 *   queueStatusUrl — optional Queue-it status endpoint for this drop
 */

function slugFromUrl(url: string): string | null {
  // https://www.pokemoncenter.com/product/<slug-or-id>
  const m = url.match(/\/product\/([^/?#]+)/i);
  return m?.[1] ?? null;
}

interface PcConfig {
  inventoryUrl?: string;
  queueStatusUrl?: string;
}

function readConfig(ctx: AdapterContext): PcConfig {
  const cfg: PcConfig = {};
  if (typeof ctx.config.inventoryUrl === 'string') cfg.inventoryUrl = ctx.config.inventoryUrl;
  if (typeof ctx.config.queueStatusUrl === 'string')
    cfg.queueStatusUrl = ctx.config.queueStatusUrl;
  return cfg;
}

/**
 * Browser-navigation header profile for fetching a product *page* (vs an XHR).
 * Cloudflare is more likely to pass a request that looks like a real navigation.
 */
function pcPageHeaders(ua: string): Record<string, string> {
  return {
    ...browserHeaders(ua),
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'sec-ch-ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'document',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-site': 'none',
    'sec-fetch-user': '?1',
    'Upgrade-Insecure-Requests': '1',
  };
}

/**
 * Read-only queue detection. Hits a configured Queue-it status endpoint if
 * present; otherwise inspects whether the product URL is redirecting to a
 * waiting room. Never interacts with the queue beyond observing it.
 */
async function detectQueue(
  url: string,
  cfg: PcConfig,
  ctx: AdapterContext,
): Promise<{ active: boolean; position?: number }> {
  if (cfg.queueStatusUrl) {
    try {
      const res = await ctx.http.get(cfg.queueStatusUrl, {
        headers: browserHeaders(ctx.userAgent()),
        retries: 0,
      });
      const body = res.json<{ active?: boolean; queuePosition?: number }>();
      const out: { active: boolean; position?: number } = { active: Boolean(body.active) };
      if (typeof body.queuePosition === 'number') out.position = body.queuePosition;
      return out;
    } catch {
      // Status endpoint unreachable -> assume idle, fall through to product poll.
      return { active: false };
    }
  }
  // Heuristic: a request that lands on a queue-it host indicates an active room.
  try {
    const res = await ctx.http.get(url, {
      headers: pcPageHeaders(ctx.userAgent()),
      retries: 0,
    });
    const onQueue = /queue-it\.net|waiting.?room/i.test(res.text);
    return { active: onQueue };
  } catch {
    return { active: false };
  }
}

export const pokemonCenterAdapter: RetailerAdapter = {
  type: 'pokemon_center',
  capabilities: {
    exactStockQty: false,
    addToCartDeepLink: false,
    requiresProxy: true,
    queueAware: true,
    marketPriceMapping: true,
  },

  async resolve(url: string): Promise<ResolveResult> {
    // Catalog-discovery watch (`discover:sitemap` or `discover:new-releases`).
    if (isDiscoverDirective(url)) {
      const directive = url.slice(DISCOVER_PREFIX.length).trim() || 'sitemap';
      return { productId: `${DISCOVER_PREFIX}${directive}`, displayName: `Discovery: ${directive}` };
    }
    const slug = slugFromUrl(url);
    if (!slug) throw new Error(`Could not extract a Pokémon Center product id from URL: ${url}`);
    return { productId: slug };
  },

  /**
   * Best-effort catalog discovery by reading the PUBLIC product sitemap (or the
   * new-releases listing) and extracting product PIDs. ToS-respecting (no auth,
   * no cart). Pokémon Center sits behind Cloudflare, so bare requests are often
   * 403'd — this becomes reliable once a residential proxy (PROXY_POOL_URL) is
   * configured; until then the engine logs the failure quietly and moves on.
   */
  async discover(watch: Watch, ctx: AdapterContext): Promise<DiscoveredProduct[]> {
    const directive = parseDiscover(watch.product_id).directive || 'sitemap';
    const listingUrl =
      directive === 'new-releases'
        ? 'https://www.pokemoncenter.com/category/new-releases'
        : 'https://www.pokemoncenter.com/sitemaps/products.xml';

    await ctx.rateLimiter.acquire();
    const res = await ctx.http.get(listingUrl, { headers: browserHeaders(ctx.userAgent()) });

    const re = /\/product\/(\d{3}-\d{5})\/([a-z0-9-]+)/gi;
    const seen = new Set<string>();
    const out: DiscoveredProduct[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(res.text)) !== null) {
      const pid = m[1];
      const slug = m[2];
      if (!pid || !slug || seen.has(pid)) continue;
      seen.add(pid);
      out.push({
        productId: pid,
        name: slug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
        url: `https://www.pokemoncenter.com/product/${pid}/${slug}`,
      });
      if (out.length >= 150) break;
    }
    return out;
  },

  async check(watch: Watch, ctx: AdapterContext): Promise<CheckResult> {
    const cfg = readConfig(ctx);
    await ctx.rateLimiter.acquire();

    // 1. Queue-active is the high-value signal — check it first.
    const queue = await detectQueue(watch.source_url, cfg, ctx);
    if (queue.active) {
      const queueState: NonNullable<CheckResult['queue']> = { active: true };
      if (queue.position !== undefined) queueState.position = queue.position;
      return {
        inStock: false, // stock is meaningless until you're through the queue
        confidence: 'queue_gated',
        price: watch.last_price,
        currency: 'USD',
        name: watch.display_name ?? 'Pokémon Center item',
        image: watch.image_url ?? null,
        url: watch.source_url,
        addToCartUrl: null, // you must go through the queue yourself
        stockQty: null,
        queue: queueState,
      };
    }

    // 2. Queue idle. With no inventory endpoint configured this is a queue-only
    // watch: stay quiet and keep sensing the queue every cycle instead of
    // erroring — so PC queue-watching runs always-on in the background with zero
    // config (no #ops spam, no circuit-breaker trips). Trade-off: no stock signal
    // while idle; set config.inventoryUrl (+ a proxy) to also detect in-stock.
    if (!cfg.inventoryUrl) {
      // No inventory endpoint configured. Probe the product page (read-only) and
      // log PC's real availability/price markup so the precise reader can be
      // calibrated; for now still return a benign out (no false alerts).
      await probePcAvailability(watch, ctx);
      return {
        inStock: false,
        confidence: 'inferred',
        price: watch.last_price,
        currency: 'USD',
        name: watch.display_name ?? 'Pokémon Center item',
        image: watch.image_url ?? null,
        url: watch.source_url,
        addToCartUrl: null,
        stockQty: null,
        queue: { active: false },
      };
    }

    const inventoryUrl = cfg.inventoryUrl.replace('{slug}', encodeURIComponent(watch.product_id));
    try {
      const res = await ctx.http.get(inventoryUrl, {
        headers: browserHeaders(ctx.userAgent()),
      });
      const body = res.json<PcInventoryResponse>();
      const available = Boolean(body.available ?? body.inStock);
      const price = typeof body.price === 'number' ? body.price : watch.last_price;
      return {
        inStock: available,
        confidence: 'inferred',
        price,
        currency: 'USD',
        name: body.name ?? watch.display_name ?? 'Pokémon Center item',
        image: body.image ?? watch.image_url ?? null,
        url: watch.source_url,
        addToCartUrl: null,
        stockQty: null,
        queue: { active: false },
        raw: body,
      };
    } catch (err) {
      if (err instanceof HttpError) {
        return errorResult(watch.source_url, `http_${err.status}`, err.message, err.retryable);
      }
      return errorResult(watch.source_url, 'unknown', (err as Error).message, true);
    }
  },
};

/**
 * Diagnostic: fetch the product page (read-only, through any proxy) and log
 * Pokémon Center's real availability/price markup so the precise stock reader
 * can be calibrated from a real response. No behavior change — the caller still
 * returns a benign out. Temporary scaffolding.
 */
async function probePcAvailability(watch: Watch, ctx: AdapterContext): Promise<void> {
  try {
    const res = await ctx.http.get(watch.source_url, { headers: pcPageHeaders(ctx.userAgent()) });
    const html = res.text;
    const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    const nd = m?.[1] ?? '';
    const around = (re: RegExp, before = 30, after = 180): string => {
      const i = nd.search(re);
      return i >= 0 ? nd.slice(Math.max(0, i - before), i + after) : '(not found)';
    };
    ctx.logger.info('pc availability probe', {
      productId: watch.product_id,
      pageLen: html.length,
      nextDataLen: nd.length,
      availabilitySnippet: around(/"availability"|"state"\s*:|availab/i),
      priceSnippet: around(/"price"|"amount"|"listPrice"|"purchasePrice"/i),
    });
  } catch (err) {
    ctx.logger.warn('pc availability probe failed', { error: (err as Error).message });
  }
}

interface PcInventoryResponse {
  available?: boolean;
  inStock?: boolean;
  price?: number;
  name?: string;
  image?: string;
}
