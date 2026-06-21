/**
 * Jittered, per-retailer rate limiter (PRD §10, §18). Serializes calls through
 * a minimum spacing with ±jitter so polls don't form a detectable fixed-frequency
 * pattern, and so all watches on one retailer share one polite tempo.
 *
 * "A polite scraper survives; a greedy one gets blocked."
 */
export interface RateLimiterOptions {
  /** Minimum milliseconds between the start of consecutive calls. */
  minIntervalMs: number;
  /** Fractional jitter applied to the interval, e.g. 0.2 => ±20%. */
  jitterPct?: number;
}

export class RateLimiter {
  private readonly minIntervalMs: number;
  private readonly jitterPct: number;
  private queue: Promise<void> = Promise.resolve();
  private lastStart = 0;

  constructor(opts: RateLimiterOptions) {
    this.minIntervalMs = Math.max(0, opts.minIntervalMs);
    this.jitterPct = Math.max(0, opts.jitterPct ?? 0);
  }

  /** Acquire a slot; resolves when the caller is allowed to proceed. */
  acquire(): Promise<void> {
    // Chain onto the previous acquisition so calls are strictly serialized.
    const result = this.queue.then(() => this.waitForSlot());
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async waitForSlot(): Promise<void> {
    const now = Date.now();
    const interval = this.jitter(this.minIntervalMs);
    const earliest = this.lastStart + interval;
    const delay = Math.max(0, earliest - now);
    if (delay > 0) await sleep(delay);
    this.lastStart = Date.now();
  }

  private jitter(ms: number): number {
    if (this.jitterPct === 0) return ms;
    const span = ms * this.jitterPct;
    return ms + (Math.random() * 2 - 1) * span;
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
