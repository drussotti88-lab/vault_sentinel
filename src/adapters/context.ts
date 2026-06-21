import { HttpClient } from '../lib/http.js';
import { RateLimiter } from '../lib/rateLimiter.js';
import { randomUserAgent } from '../lib/userAgents.js';
import type { Logger } from '../lib/logger.js';
import type { AdapterContext } from './types.js';
import type { Retailer } from '../db/types.js';
import { loadConfig } from '../lib/config.js';

/**
 * Builds the AdapterContext for a retailer: a proxy-aware HTTP client, a
 * per-retailer rate limiter (shared across that retailer's watches, PRD §16),
 * a UA rotator, a logger, and the retailer's structured config.
 *
 * One context per retailer is created and reused so the rate limiter actually
 * throttles the whole retailer rather than each watch independently.
 */
export function buildAdapterContext(retailer: Retailer, baseLogger: Logger): AdapterContext {
  const cfg = loadConfig();
  const logger = baseLogger.child({ retailer: retailer.name, adapter: retailer.adapter_type });

  // Proxy: prefer a per-retailer override, else the global pool URL.
  const proxyUrl =
    (typeof retailer.config.proxyUrl === 'string' && retailer.config.proxyUrl) ||
    cfg.proxyPoolUrl ||
    undefined;

  const http = new HttpClient({ proxyUrl, logger });

  // Minimum spacing derived from the retailer's default cadence, with jitter so
  // requests don't form a fixed-frequency pattern.
  const minIntervalMs = Math.max(250, (retailer.default_interval_sec * 1000) / 4);
  const rateLimiter = new RateLimiter({ minIntervalMs, jitterPct: cfg.engine.jitterPct });

  return {
    http,
    rateLimiter,
    logger,
    config: retailer.config,
    userAgent: randomUserAgent,
  };
}
