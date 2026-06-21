import type { RetailerAdapter, CheckResult, AdapterContext, ResolveResult } from './types.js';
import { errorResult } from './types.js';
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
      headers: browserHeaders(ctx.userAgent()),
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
    const slug = slugFromUrl(url);
    if (!slug) throw new Error(`Could not extract a Pokémon Center product id from URL: ${url}`);
    return { productId: slug };
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

interface PcInventoryResponse {
  available?: boolean;
  inStock?: boolean;
  price?: number;
  name?: string;
  image?: string;
}
