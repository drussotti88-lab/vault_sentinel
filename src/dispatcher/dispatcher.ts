import { HttpClient } from '../lib/http.js';
import { buildRestockEmbed, buildQueueEmbed, type WebhookPayload } from './embeds.js';
import type { CheckResult } from '../adapters/types.js';
import type { Watch, Retailer } from '../db/types.js';
import type { MarketPrice } from '../market/marketPrice.js';
import type { Logger } from '../lib/logger.js';
import type { AlertKind } from '../core/stateMachine.js';

/**
 * Dispatcher (PRD §9.1, FR-14..17). Formats normalized results into embeds and
 * posts them to the retailer's channel via webhook (low latency; the bot owns
 * commands/setup). Alerts go out via webhook for speed.
 */
export class Dispatcher {
  private readonly http: HttpClient;
  private readonly logger: Logger;

  constructor(opts: { logger: Logger; http?: HttpClient }) {
    this.logger = opts.logger;
    this.http = opts.http ?? new HttpClient({ logger: opts.logger });
  }

  async dispatch(
    kind: AlertKind,
    watch: Watch,
    retailer: Retailer,
    result: CheckResult,
    market: MarketPrice | null,
  ): Promise<void> {
    if (!retailer.webhook_url) {
      this.logger.warn('no webhook configured for retailer; skipping post', {
        retailer: retailer.name,
      });
      return;
    }
    const payload =
      kind === 'queue'
        ? buildQueueEmbed(watch, retailer, result)
        : buildRestockEmbed(watch, retailer, result, market);

    await this.postWebhook(retailer.webhook_url, payload);
    this.logger.info('alert posted', {
      kind,
      watchId: watch.id,
      retailer: retailer.name,
      price: result.price,
    });
  }

  /** Post a raw message to a Discord webhook (used for ops messages too). */
  async postWebhook(webhookUrl: string, payload: WebhookPayload | { content: string }): Promise<void> {
    await this.http.post(webhookUrl, JSON.stringify(payload), {
      headers: { 'Content-Type': 'application/json' },
      // Discord webhooks are reliable; a couple retries cover transient 5xx/429.
      retries: 3,
    });
  }
}
