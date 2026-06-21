import { loadConfig } from '../lib/config.js';
import { createLogger, type Logger } from '../lib/logger.js';
import { sleep } from '../lib/rateLimiter.js';
import { Limiter } from '../lib/pool.js';
import { retailers as retailerRepo, watches as watchRepo, alerts as alertRepo } from '../db/repositories.js';
import { getAdapter } from '../adapters/registry.js';
import { buildAdapterContext } from '../adapters/context.js';
import { decide } from './stateMachine.js';
import { CircuitBreaker } from './circuitBreaker.js';
import { OpsReporter } from './ops.js';
import { Dispatcher } from '../dispatcher/dispatcher.js';
import { MarketPriceService } from '../market/marketPrice.js';
import { DiscordRest } from '../lib/discordRest.js';
import type { AdapterContext, CheckResult } from '../adapters/types.js';
import type { Retailer, Watch } from '../db/types.js';

/**
 * Core engine / worker (PRD §8.3, §9, §16). The always-on poller: stateless
 * between cycles except via Supabase. Must run as a persistent process, not
 * serverless cron (PRD §21, §22).
 *
 * Per cycle, for each due watch: resolve adapter -> rate-limited check() ->
 * normalize -> diff state -> transition? -> enrich(market price) -> emit alert /
 * update state. Per-retailer circuit breaker, bounded concurrency, and adaptive
 * cadence keep it polite and resilient.
 */

interface RetailerRuntime {
  retailer: Retailer;
  ctx: AdapterContext;
  breaker: CircuitBreaker;
  limiter: Limiter;
}

interface WatchRuntime {
  intervalSec: number;
  nextDue: number;
  hot: boolean; // recent restock activity -> tighten cadence
  inFlight: boolean;
}

const TICK_MS = 1000;
const CONFIG_REFRESH_MS = 60_000;
const HEARTBEAT_MS = 6 * 60 * 60_000; // every 6h

export class Engine {
  private readonly logger: Logger;
  private readonly ops: OpsReporter;
  private readonly dispatcher: Dispatcher;
  private readonly market: MarketPriceService;

  private runtimes = new Map<string, RetailerRuntime>(); // retailerId -> runtime
  private watchState = new Map<string, WatchRuntime>(); // watchId -> runtime
  private retailerById = new Map<string, Retailer>();
  private watchById = new Map<string, Watch>();

  private running = false;
  private lastConfigRefresh = 0;
  private lastHeartbeat = 0;

  constructor() {
    const cfg = loadConfig();
    this.logger = createLogger(cfg.logLevel, { component: 'engine' });
    const rest = new DiscordRest(cfg.discord.botToken, { logger: this.logger });
    this.ops = new OpsReporter({
      rest,
      opsChannelId: cfg.discord.opsChannelId,
      logger: this.logger,
    });
    this.dispatcher = new Dispatcher({ logger: this.logger });
    this.market = new MarketPriceService({ logger: this.logger });
  }

  async start(): Promise<void> {
    this.running = true;
    this.logger.info('engine starting');
    await this.refreshConfig();
    this.lastHeartbeat = Date.now();

    while (this.running) {
      const now = Date.now();
      if (now - this.lastConfigRefresh >= CONFIG_REFRESH_MS) {
        await this.refreshConfig().catch((err) =>
          this.logger.error('config refresh failed', { error: (err as Error).message }),
        );
      }
      if (now - this.lastHeartbeat >= HEARTBEAT_MS) {
        this.lastHeartbeat = now;
        void this.ops.heartbeat(this.heartbeatSummary());
      }
      this.dispatchDueWatches(now);
      await sleep(TICK_MS);
    }
  }

  stop(): void {
    this.running = false;
  }

  /** Force an immediate poll of one watch (debug / /check-now). */
  async checkNow(watchId: string): Promise<CheckResult | null> {
    await this.refreshConfig();
    const watch = this.watchById.get(watchId);
    if (!watch) return null;
    const runtime = this.runtimes.get(watch.retailer_id);
    if (!runtime) return null;
    return this.pollWatch(watch, runtime, { force: true });
  }

  // ---------------------------------------------------------------------------

  private heartbeatSummary(): string {
    const adapters = [...this.runtimes.values()]
      .map((r) => `${r.retailer.name}:${r.breaker.current}`)
      .join(', ');
    return `Sentinel alive — ${this.watchState.size} watches, ${this.runtimes.size} retailers [${adapters}]`;
  }

  /** Reload retailers + watches from Supabase and reconcile runtime maps. */
  private async refreshConfig(): Promise<void> {
    this.lastConfigRefresh = Date.now();
    const cfg = loadConfig();
    const [enabledRetailers, enabledWatches] = await Promise.all([
      retailerRepo.listEnabled(),
      watchRepo.listEnabled(),
    ]);

    // Reconcile retailer runtimes (preserve breaker/limiter state across refresh).
    const seenRetailers = new Set<string>();
    this.retailerById.clear();
    for (const retailer of enabledRetailers) {
      this.retailerById.set(retailer.id, retailer);
      seenRetailers.add(retailer.id);
      const existing = this.runtimes.get(retailer.id);
      if (existing) {
        existing.retailer = retailer;
        existing.ctx = buildAdapterContext(retailer, this.logger);
      } else {
        this.runtimes.set(retailer.id, {
          retailer,
          ctx: buildAdapterContext(retailer, this.logger),
          breaker: new CircuitBreaker(),
          limiter: new Limiter(cfg.engine.adapterConcurrency),
        });
      }
    }
    for (const id of [...this.runtimes.keys()]) {
      if (!seenRetailers.has(id)) this.runtimes.delete(id);
    }

    // Reconcile watch runtimes.
    const seenWatches = new Set<string>();
    this.watchById.clear();
    for (const watch of enabledWatches) {
      if (!this.runtimes.has(watch.retailer_id)) continue; // retailer disabled
      this.watchById.set(watch.id, watch);
      seenWatches.add(watch.id);
      const intervalSec = this.effectiveInterval(watch);
      const existing = this.watchState.get(watch.id);
      if (existing) {
        existing.intervalSec = intervalSec;
      } else {
        this.watchState.set(watch.id, {
          intervalSec,
          // Stagger first poll slightly so a fresh start doesn't fire everything at once.
          nextDue: Date.now() + Math.random() * intervalSec * 1000,
          hot: false,
          inFlight: false,
        });
      }
    }
    for (const id of [...this.watchState.keys()]) {
      if (!seenWatches.has(id)) this.watchState.delete(id);
    }

    this.logger.debug('config refreshed', {
      retailers: this.runtimes.size,
      watches: this.watchState.size,
    });
  }

  private effectiveInterval(watch: Watch): number {
    const cfg = loadConfig();
    const retailer = this.retailerById.get(watch.retailer_id);
    return (
      watch.interval_sec ??
      retailer?.default_interval_sec ??
      cfg.engine.globalIntervalSec
    );
  }

  /** Find due, not-in-flight watches and process them (fire-and-forget). */
  private dispatchDueWatches(now: number): void {
    for (const [watchId, ws] of this.watchState) {
      if (ws.inFlight || now < ws.nextDue) continue;
      const watch = this.watchById.get(watchId);
      const runtime = watch ? this.runtimes.get(watch.retailer_id) : undefined;
      if (!watch || !runtime) continue;

      if (!runtime.breaker.canRequest(now)) {
        // Breaker open: defer this watch without counting it as a poll.
        ws.nextDue = now + 5000;
        continue;
      }
      ws.inFlight = true;
      void runtime.limiter
        .run(() => this.pollWatch(watch, runtime))
        .catch((err) =>
          this.logger.error('poll failed', { watchId, error: (err as Error).message }),
        )
        .finally(() => {
          ws.inFlight = false;
        });
    }
  }

  private async pollWatch(
    watch: Watch,
    runtime: RetailerRuntime,
    opts: { force?: boolean } = {},
  ): Promise<CheckResult> {
    const cfg = loadConfig();
    const adapter = getAdapter(runtime.retailer.adapter_type);
    const ws = this.watchState.get(watch.id);
    const start = Date.now();
    const log = this.logger.child({ watchId: watch.id, retailer: runtime.retailer.name });

    const result = await adapter.check(watch, runtime.ctx);
    const latencyMs = Date.now() - start;

    // --- Failure path: circuit breaker + ops, hold state, backoff. ---
    if (result.error) {
      const tripped = runtime.breaker.recordFailure();
      log.warn('adapter check error', {
        code: result.error.code,
        latencyMs,
        outcome: 'error',
      });
      void this.ops.adapterFailure(runtime.retailer.name, result.error.code, result.error.message);
      if (result.error.code.startsWith('http_429')) {
        void this.ops.rateLimited(runtime.retailer.name);
      }
      if (tripped) void this.ops.circuitTripped(runtime.retailer.name);
      await this.persistCheck(watch, result, false);
      if (ws) this.reschedule(ws, watch, { backoff: true });
      return result;
    }

    const recovered = runtime.breaker.recordSuccess();
    if (recovered) void this.ops.circuitRecovered(runtime.retailer.name);

    // --- Queue-state changes always go to ops (PRD FR-21). ---
    const wasQueue = watch.last_status === 'queue';
    if (result.queue?.active && !wasQueue) {
      void this.ops.queueStateChanged(runtime.retailer.name, true, result.queue.position);
    } else if (!result.queue?.active && wasQueue) {
      void this.ops.queueStateChanged(runtime.retailer.name, false);
    }

    const decision = decide({ watch, result, cooldownSec: cfg.engine.alertCooldownSec });
    log.info('checked', {
      latencyMs,
      outcome: 'ok',
      status: decision.newStatus,
      price: result.price,
      alert: decision.shouldAlert,
      reason: decision.reason,
    });

    if (decision.shouldAlert && decision.alertKind) {
      // Enrich with market price only when we're actually going to alert.
      const market =
        watch.tcg_sku && decision.alertKind === 'restock'
          ? await this.market.getMarketPrice(watch.tcg_sku)
          : null;
      await this.dispatcher.dispatch(
        decision.alertKind,
        watch,
        runtime.retailer,
        result,
        market,
      );
      await alertRepo.log({
        watch_id: watch.id,
        price: result.price,
        market_price: market?.value ?? null,
        confidence: result.confidence,
        payload: result,
      });
      await this.persistCheck(watch, result, true, decision.newStatus);
      if (ws) ws.hot = true; // restock activity -> run hotter for a while
    } else {
      await this.persistCheck(watch, result, false, decision.newStatus);
    }

    if (ws && !opts.force) {
      // Queue-active: drop to a slow status poll, never escalate (PRD §16).
      const queueActive = result.queue?.active === true;
      this.reschedule(ws, watch, { queueActive });
    }
    return result;
  }

  private async persistCheck(
    watch: Watch,
    result: CheckResult,
    alerted: boolean,
    status = watch.last_status,
  ): Promise<void> {
    const now = new Date().toISOString();
    const fields = {
      last_status: status,
      last_price: result.price,
      last_checked: now,
      ...(alerted ? { last_alerted: now } : {}),
    };
    await watchRepo.recordCheck(watch.id, fields);
    // Keep the in-memory copy coherent for the next decision.
    const cached = this.watchById.get(watch.id);
    if (cached) {
      cached.last_status = status;
      cached.last_price = result.price;
      cached.last_checked = now;
      if (alerted) cached.last_alerted = now;
    }
  }

  /** Adaptive cadence (PRD §16): tighten when hot, relax when quiet/queue. */
  private reschedule(
    ws: WatchRuntime,
    watch: Watch,
    opts: { backoff?: boolean; queueActive?: boolean } = {},
  ): void {
    const cfg = loadConfig();
    let intervalSec = ws.intervalSec;
    if (opts.queueActive) {
      intervalSec = Math.max(ws.intervalSec, 60); // gentle status poll, no escalation
    } else if (opts.backoff) {
      intervalSec = Math.min(ws.intervalSec * 2, 600); // exponential-ish backoff, capped
    } else if (ws.hot) {
      intervalSec = Math.max(10, Math.floor(ws.intervalSec / 2)); // hot drop -> tighten
    }
    const jitter = 1 + (Math.random() * 2 - 1) * cfg.engine.jitterPct;
    ws.nextDue = Date.now() + intervalSec * 1000 * jitter;
  }
}
