import { loadConfig } from '../lib/config.js';
import { createLogger, type Logger } from '../lib/logger.js';
import { HttpClient, HttpError } from '../lib/http.js';
import { browserHeaders, randomUserAgent } from '../lib/userAgents.js';
import { sleep } from '../lib/rateLimiter.js';
import { retailers as retailerRepo } from '../db/repositories.js';

/**
 * Pokémon Center site-state monitor — the "PokeHunt backend watcher" analog.
 *
 * There is no privileged backend access to PC; what community monitors actually
 * do is poll a public page fast and watch for the tell-tale changes that precede
 * a drop. This does exactly that, politely: one homepage request per interval,
 * classified into a coarse site state, alerting only on *transitions*:
 *
 *   → maintenance   PC put the site into maintenance (a drop is often staged).
 *   maintenance → normal   Back online — a drop may be going live now.
 *   → queue         The Queue-it waiting room is live right now.
 *
 * It is detect-and-notify ONLY. It never enters, bypasses, or fast-forwards the
 * queue.
 *
 * PC sits behind Cloudflare, which 403s datacenter IPs — so on startup this runs
 * a direct-vs-proxy self-test and logs the verdict, making it obvious from the
 * Railway logs whether server-side watching actually works here (it needs a
 * residential PROXY_POOL_URL) or whether the browser-extension path is required.
 */

export type SiteState = 'normal' | 'maintenance' | 'queue' | 'blocked' | 'unreachable' | 'unknown';

const QUEUE_RE = /queue-it\.net|queue\.it|waiting.?room|you are now in line/i;
const MAINTENANCE_RE =
  /(under|scheduled|site|for) maintenance|maintenance mode|we'?ll be (right )?back|be right back|temporarily (unavailable|down)|down for maintenance/i;
const CHALLENGE_RE =
  /just a moment|challenge-platform|cf-chl|cf-mitigated|attention required|enable javascript and cookies to continue/i;
const NORMAL_RE = /__NEXT_DATA__|pokemoncenter|add to cart|id="__next"/i;

/**
 * Classify a fetched page into a coarse site state. Pure and order-sensitive:
 * the highest-value signals (queue, maintenance) are checked before the
 * ambiguous ones (challenge, normal). Exported for unit testing.
 */
export function classifySiteState(status: number, body: string): SiteState {
  if (!status) return 'unreachable';
  const b = body ?? '';
  if (QUEUE_RE.test(b)) return 'queue';
  if (MAINTENANCE_RE.test(b)) return 'maintenance';
  if (CHALLENGE_RE.test(b)) return 'blocked';
  if (status === 200 && NORMAL_RE.test(b)) return 'normal';
  if (status === 403 || status === 429 || status === 503) return 'blocked';
  if (status === 200) return 'normal';
  return 'unknown';
}

interface Probe {
  status: number;
  body: string;
}

function pcHeaders(): Record<string, string> {
  const ua = randomUserAgent();
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

const OPS_THROTTLE_MS = 15 * 60_000;

export class SiteMonitor {
  private readonly logger: Logger;
  private readonly enabled: boolean;
  private readonly intervalSec: number;
  private readonly url: string;
  private readonly proxyUrl: string;

  /** Proxy-aware client for polling PC (falls back to direct if no proxy). */
  private readonly pcClient: HttpClient;
  /** Direct (no-proxy) client, used only for the startup contrast probe. */
  private readonly directClient: HttpClient;
  /** Plain client for posting to Discord (webhook + bot REST). */
  private readonly notifyClient: HttpClient;
  private readonly botToken: string;
  private readonly opsChannelId: string;

  private running = false;
  private state: SiteState = 'unknown';
  private lastOpsPost = new Map<string, number>();

  constructor() {
    const cfg = loadConfig();
    this.logger = createLogger(cfg.logLevel, { component: 'site-monitor' });
    this.enabled = cfg.siteMonitor.enabled;
    this.intervalSec = Math.max(20, cfg.siteMonitor.intervalSec);
    this.url = cfg.siteMonitor.url;
    this.proxyUrl = cfg.proxyPoolUrl || '';
    this.botToken = cfg.discord.botToken;
    this.opsChannelId = cfg.discord.opsChannelId;

    this.pcClient = new HttpClient({
      proxyUrl: this.proxyUrl || undefined,
      logger: this.logger,
      defaultTimeoutMs: 15_000,
    });
    this.directClient = new HttpClient({ logger: this.logger, defaultTimeoutMs: 15_000 });
    this.notifyClient = new HttpClient({ logger: this.logger });
  }

  async start(): Promise<void> {
    if (!this.enabled) {
      this.logger.info('site monitor disabled (SITE_MONITOR_ENABLED=false)');
      return;
    }
    this.running = true;
    this.logger.info('site monitor starting', {
      url: this.url,
      intervalSec: this.intervalSec,
      proxy: this.proxyUrl ? 'configured' : 'none',
    });
    await this.selfTest();

    while (this.running) {
      try {
        await this.tick();
      } catch (err) {
        this.logger.warn('site monitor tick failed', { error: (err as Error).message });
      }
      // Gentle jitter so the poll isn't a fixed-frequency fingerprint.
      const jitter = 1 + (Math.random() * 2 - 1) * 0.2;
      await sleep(this.intervalSec * 1000 * jitter);
    }
  }

  stop(): void {
    this.running = false;
  }

  getState(): SiteState {
    return this.state;
  }

  // ---------------------------------------------------------------------------

  /** One-shot GET that never throws — returns status + body even on 4xx/5xx. */
  private async probe(client: HttpClient): Promise<Probe> {
    try {
      const res = await client.get(this.url, { headers: pcHeaders(), retries: 0 });
      return { status: res.status, body: res.text };
    } catch (err) {
      if (err instanceof HttpError) return { status: err.status, body: err.body ?? '' };
      return { status: 0, body: '' };
    }
  }

  /**
   * Startup reachability check. Probes the homepage both direct and (if set)
   * through the proxy, logs the verdict, and posts it once to #ops — so it is
   * unmistakable from the deploy logs whether server-side PC watching works.
   */
  private async selfTest(): Promise<void> {
    const direct = await this.probe(this.directClient);
    const directState = classifySiteState(direct.status, direct.body);

    let verdict: string;
    if (this.proxyUrl) {
      const viaProxy = await this.probe(this.pcClient);
      const proxyState = classifySiteState(viaProxy.status, viaProxy.body);
      const works = proxyState !== 'blocked' && proxyState !== 'unreachable';
      this.logger.info('site monitor self-test', {
        directStatus: direct.status,
        directState,
        proxyStatus: viaProxy.status,
        proxyState,
        serverSideWatching: works ? 'ENABLED (via proxy)' : 'BLOCKED (proxy did not get through)',
      });
      verdict =
        `🔎 **Site-monitor self-test** — direct: \`${directState}\` (HTTP ${direct.status}), ` +
        `via proxy: \`${proxyState}\` (HTTP ${viaProxy.status}). ` +
        (works
          ? 'Server-side Pokémon Center watching is **ENABLED** (proxy gets through).'
          : 'Proxy is **not** getting through — server-side watching is blocked; the browser extension is the reliable path.');
      this.state = works ? proxyState : directState;
    } else {
      const works = directState !== 'blocked' && directState !== 'unreachable';
      this.logger.info('site monitor self-test', {
        directStatus: direct.status,
        directState,
        proxy: 'none',
        serverSideWatching: works ? 'ENABLED (direct)' : 'BLOCKED (no proxy; datacenter IP is walled)',
      });
      verdict =
        `🔎 **Site-monitor self-test** — direct: \`${directState}\` (HTTP ${direct.status}), no proxy set. ` +
        (works
          ? 'Server-side Pokémon Center watching is **ENABLED**.'
          : 'Direct requests are walled (expected for a datacenter IP). Set `PROXY_POOL_URL` to a residential proxy, or rely on the browser extension.');
      this.state = works ? directState : 'blocked';
    }
    await this.postOps('selftest', verdict, true);
  }

  private async tick(): Promise<void> {
    const { status, body } = await this.probe(this.pcClient);
    const next = classifySiteState(status, body);
    this.logger.debug('site state', { status, state: next, prev: this.state });
    if (next === this.state) return;

    const prev = this.state;
    this.state = next;
    await this.onTransition(prev, next);
  }

  private async onTransition(prev: SiteState, next: SiteState): Promise<void> {
    this.logger.info('site state transition', { from: prev, to: next });

    // High-value, user-facing signals go to the Pokémon Center channel.
    if (next === 'queue') {
      await this.postUser(
        `🎟️ **Pokémon Center — drop queue is LIVE right now.** Get in line yourself: ${this.url}`,
      );
      return;
    }
    if (next === 'maintenance') {
      await this.postUser(
        `🚧 **Pokémon Center — site maintenance detected.** Drops are often staged during maintenance. Get ready — I'll ping again when it's back up.`,
      );
      return;
    }
    if (prev === 'maintenance' && next === 'normal') {
      await this.postUser(
        `✅ **Pokémon Center — back online after maintenance.** A drop may be going live now: ${this.url}`,
      );
      return;
    }
    if (prev === 'queue') {
      await this.postOps('queue', '⚪ Pokémon Center queue no longer detected server-side.');
      return;
    }

    // Low-signal / diagnostic transitions stay in #ops (throttled).
    if (next === 'blocked') {
      await this.postOps('blocked', '🧱 Pokémon Center is returning a Cloudflare wall to the server — no server-side read right now (extension still works).');
    } else if (next === 'unreachable') {
      await this.postOps('unreachable', '📡 Pokémon Center is unreachable from the server right now.');
    }
  }

  private async pcWebhook(): Promise<string | null> {
    try {
      const enabled = await retailerRepo.listEnabled();
      const pc = enabled.find((r) => r.adapter_type === 'pokemon_center' && r.webhook_url);
      return pc?.webhook_url ?? null;
    } catch (err) {
      this.logger.warn('could not load PC webhook', { error: (err as Error).message });
      return null;
    }
  }

  /** Post a user-facing alert to the PC channel (webhook), falling back to #ops. */
  private async postUser(content: string): Promise<void> {
    const webhook = await this.pcWebhook();
    if (webhook) {
      try {
        await this.notifyClient.post(webhook, JSON.stringify({ content }), {
          headers: { 'Content-Type': 'application/json' },
          retries: 3,
        });
        return;
      } catch (err) {
        this.logger.warn('site alert webhook post failed; falling back to ops', {
          error: (err as Error).message,
        });
      }
    }
    await this.postOps('userfallback', content, true);
  }

  /** Post a diagnostic message to #ops, throttled per key (except forced). */
  private async postOps(key: string, content: string, force = false): Promise<void> {
    if (!this.opsChannelId) {
      this.logger.debug('ops channel not configured; skipping site-monitor ops post', { key });
      return;
    }
    const now = Date.now();
    if (!force && now - (this.lastOpsPost.get(key) ?? 0) < OPS_THROTTLE_MS) return;
    this.lastOpsPost.set(key, now);
    try {
      await this.notifyClient.post(
        `https://discord.com/api/v10/channels/${this.opsChannelId}/messages`,
        JSON.stringify({ content }),
        { headers: { Authorization: `Bot ${this.botToken}`, 'Content-Type': 'application/json' }, retries: 2 },
      );
    } catch (err) {
      this.logger.warn('site-monitor ops post failed', { error: (err as Error).message });
    }
  }
}
