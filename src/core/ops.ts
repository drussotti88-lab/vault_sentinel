import type { DiscordRest } from '../lib/discordRest.js';
import type { Logger } from '../lib/logger.js';

/**
 * Ops / observability reporter (PRD §6 tenet "fail loud internally, stay quiet
 * externally"; FR-20..22, §19). Posts adapter failures, rate-limit hits,
 * circuit-breaker trips/recoveries, queue-state changes, and a daily heartbeat
 * to a private #ops channel — throttled so failures never spam.
 */
export class OpsReporter {
  private readonly rest: DiscordRest;
  private readonly opsChannelId: string;
  private readonly logger: Logger;
  /** key -> last-sent epoch ms, for throttling repeated messages. */
  private lastSent = new Map<string, number>();
  private readonly throttleMs: number;

  constructor(opts: {
    rest: DiscordRest;
    opsChannelId: string;
    logger: Logger;
    throttleMs?: number;
  }) {
    this.rest = opts.rest;
    this.opsChannelId = opts.opsChannelId;
    this.logger = opts.logger;
    this.throttleMs = opts.throttleMs ?? 5 * 60_000; // 5 min default
  }

  private async send(key: string, content: string, force = false): Promise<void> {
    if (!this.opsChannelId) {
      this.logger.debug('ops channel not configured; skipping ops post', { key });
      return;
    }
    const now = Date.now();
    const last = this.lastSent.get(key) ?? 0;
    if (!force && now - last < this.throttleMs) return;
    this.lastSent.set(key, now);
    try {
      await this.rest.postMessage(this.opsChannelId, { content });
    } catch (err) {
      this.logger.error('failed to post ops message', { error: (err as Error).message });
    }
  }

  adapterFailure(retailer: string, code: string, message: string): Promise<void> {
    return this.send(`fail:${retailer}:${code}`, `⚠️ **${retailer}** adapter error \`${code}\`: ${message}`);
  }

  rateLimited(retailer: string): Promise<void> {
    return this.send(`ratelimit:${retailer}`, `🐢 **${retailer}** is being rate-limited; backing off.`);
  }

  circuitTripped(retailer: string): Promise<void> {
    return this.send(
      `circuit:${retailer}:open`,
      `🛑 **${retailer}** circuit breaker tripped — polling paused temporarily.`,
      true,
    );
  }

  circuitRecovered(retailer: string): Promise<void> {
    return this.send(
      `circuit:${retailer}:close`,
      `✅ **${retailer}** circuit breaker recovered — polling resumed.`,
      true,
    );
  }

  queueStateChanged(retailer: string, active: boolean, position?: number): Promise<void> {
    const pos = position !== undefined ? ` (position ~${position})` : '';
    const msg = active
      ? `🔵 **${retailer}** queue is now ACTIVE — a drop is happening${pos}.`
      : `⚪ **${retailer}** queue is now idle.`;
    return this.send(`queue:${retailer}`, msg, true);
  }

  heartbeat(summary: string): Promise<void> {
    return this.send('heartbeat', `💓 ${summary}`, true);
  }
}
