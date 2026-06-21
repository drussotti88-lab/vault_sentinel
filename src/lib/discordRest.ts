import { HttpClient } from './http.js';
import type { Logger } from './logger.js';

/**
 * Tiny Discord REST helper for the worker side — posting ops messages, creating
 * channels/webhooks under the Stock Checkers category. The gateway bot lives in
 * src/bot; this keeps the worker able to talk to Discord without a gateway
 * connection. Uses the bot token (least-privilege, single guild — PRD §20).
 */
const API = 'https://discord.com/api/v10';

export class DiscordRest {
  private readonly http: HttpClient;
  private readonly token: string;
  private readonly logger?: Logger;

  constructor(token: string, opts: { logger?: Logger } = {}) {
    this.token = token;
    this.logger = opts.logger;
    this.http = new HttpClient({ logger: opts.logger });
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bot ${this.token}`,
      'Content-Type': 'application/json',
    };
  }

  async postMessage(channelId: string, payload: Record<string, unknown>): Promise<void> {
    await this.http.post(`${API}/channels/${channelId}/messages`, JSON.stringify(payload), {
      headers: this.headers(),
      retries: 2,
    });
  }

  /** Create a text channel under a category (FR-2: auto-create on /add-retailer). */
  async createTextChannel(
    guildId: string,
    name: string,
    parentId?: string,
  ): Promise<{ id: string }> {
    const body: Record<string, unknown> = { name, type: 0 };
    if (parentId) body.parent_id = parentId;
    const res = await this.http.post(`${API}/guilds/${guildId}/channels`, JSON.stringify(body), {
      headers: this.headers(),
    });
    return res.json<{ id: string }>();
  }

  /** Create a webhook on a channel for fast posts (FR-17). */
  async createWebhook(channelId: string, name = 'Sentinel'): Promise<{ url: string; id: string }> {
    const res = await this.http.post(
      `${API}/channels/${channelId}/webhooks`,
      JSON.stringify({ name }),
      { headers: this.headers() },
    );
    const wh = res.json<{ id: string; token: string }>();
    return { id: wh.id, url: `${API}/webhooks/${wh.id}/${wh.token}` };
  }
}
