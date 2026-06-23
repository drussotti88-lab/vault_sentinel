import { sleep } from './rateLimiter.js';
import type { Logger } from './logger.js';

/**
 * Thin fetch wrapper with timeouts, optional proxy, and exponential backoff
 * with jitter (PRD §16, §18). Adapters get one of these via AdapterContext so
 * retailer code never re-implements retry/timeout semantics.
 */

export interface HttpRequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  /** Per-request timeout in ms. */
  timeoutMs?: number;
  /** Max retry attempts on retryable failures (5xx / network / timeout). */
  retries?: number;
}

export interface HttpResponse {
  status: number;
  ok: boolean;
  headers: Headers;
  text: string;
  json<T = unknown>(): T;
}

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean,
    readonly body?: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export interface HttpClientOptions {
  /** Proxy URL (http(s)://user:pass@host:port). Empty => direct. */
  proxyUrl?: string;
  logger?: Logger;
  defaultTimeoutMs?: number;
  defaultRetries?: number;
}

export class HttpClient {
  private readonly proxyUrl?: string;
  private readonly logger?: Logger;
  private readonly defaultTimeoutMs: number;
  private readonly defaultRetries: number;
  private dispatcherPromise?: Promise<unknown>;

  constructor(opts: HttpClientOptions = {}) {
    this.proxyUrl = opts.proxyUrl || undefined;
    this.logger = opts.logger;
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 10_000;
    this.defaultRetries = opts.defaultRetries ?? 2;
  }

  async request(url: string, opts: HttpRequestOptions = {}): Promise<HttpResponse> {
    const retries = opts.retries ?? this.defaultRetries;
    const timeoutMs = opts.timeoutMs ?? this.defaultTimeoutMs;
    let attempt = 0;
    // 1-indexed attempts: try once, then up to `retries` more times.
    for (;;) {
      attempt++;
      try {
        return await this.once(url, opts, timeoutMs);
      } catch (err) {
        const retryable = err instanceof HttpError ? err.retryable : true;
        if (!retryable || attempt > retries) throw err;
        const backoff = this.backoffMs(attempt);
        this.logger?.warn('http retry', {
          url,
          attempt,
          backoffMs: Math.round(backoff),
          error: (err as Error).message,
        });
        await sleep(backoff);
      }
    }
  }

  get(url: string, opts: HttpRequestOptions = {}): Promise<HttpResponse> {
    return this.request(url, { ...opts, method: 'GET' });
  }

  post(url: string, body: string, opts: HttpRequestOptions = {}): Promise<HttpResponse> {
    return this.request(url, { ...opts, method: 'POST', body });
  }

  private async once(
    url: string,
    opts: HttpRequestOptions,
    timeoutMs: number,
  ): Promise<HttpResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const init: RequestInit = {
        method: opts.method ?? 'GET',
        headers: opts.headers,
        body: opts.body,
        signal: controller.signal,
      };
      const dispatcher = await this.dispatcher();
      // `dispatcher` is an undici-only extension to RequestInit; set it loosely.
      if (dispatcher) (init as Record<string, unknown>).dispatcher = dispatcher;

      const res = await fetch(url, init);
      const text = await res.text();
      if (!res.ok) {
        // 429 / 5xx are retryable; 4xx (except 429) generally are not.
        const retryable = res.status === 429 || res.status >= 500;
        throw new HttpError(`HTTP ${res.status} for ${url}`, res.status, retryable, text);
      }
      return {
        status: res.status,
        ok: res.ok,
        headers: res.headers,
        text,
        json<T = unknown>(): T {
          return JSON.parse(text) as T;
        },
      };
    } catch (err) {
      if (err instanceof HttpError) throw err;
      if ((err as Error).name === 'AbortError') {
        throw new HttpError(`Request timed out after ${timeoutMs}ms`, 0, true);
      }
      throw new HttpError((err as Error).message, 0, true);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Build an undici ProxyAgent when a proxy is configured. Done lazily and
   * cached so the system runs with zero proxy config (Target/eBay paths).
   */
  private dispatcher(): Promise<unknown> {
    if (!this.proxyUrl) return Promise.resolve(undefined);
    if (!this.dispatcherPromise) {
      const proxyUrl = this.proxyUrl;
      // Validate early: a malformed value (e.g. a whole `curl ...` command pasted
      // into PROXY_POOL_URL) must give a clear error, not silently go direct.
      let parsed: URL | null = null;
      try {
        parsed = new URL(proxyUrl);
      } catch {
        parsed = null;
      }
      if (!parsed || !/^https?:$/.test(parsed.protocol)) {
        this.logger?.error(
          'invalid PROXY_POOL_URL — expected just http://user:pass@host:port (no "curl", no flags); going DIRECT',
          { valuePreview: proxyUrl.slice(0, 24) },
        );
        this.dispatcherPromise = Promise.resolve(undefined);
        return this.dispatcherPromise;
      }
      this.dispatcherPromise = import('undici')
        .then((undici) => new undici.ProxyAgent(proxyUrl) as unknown)
        .catch((err) => {
          this.logger?.error('failed to initialize proxy agent; going DIRECT', {
            error: (err as Error).message,
          });
          return undefined;
        });
    }
    return this.dispatcherPromise;
  }

  /** Exponential backoff with full jitter, capped at 30s. */
  private backoffMs(attempt: number): number {
    const base = Math.min(30_000, 500 * 2 ** (attempt - 1));
    return Math.random() * base;
  }
}
