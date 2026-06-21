import 'server-only';

/**
 * Server-only client for the worker's control API. The bearer token lives only
 * in the environment and is sent server-side, so it never reaches the browser
 * (PRD §20). Every mutation the dashboard performs funnels through here.
 */

export function controlConfigured(): boolean {
  return Boolean(process.env.CONTROL_API_URL && process.env.CONTROL_API_TOKEN);
}

function baseUrl(): string {
  const url = process.env.CONTROL_API_URL;
  if (!url) throw new Error('CONTROL_API_URL is not set.');
  return url.replace(/\/+$/, '');
}

async function call<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const token = process.env.CONTROL_API_TOKEN;
  if (!token) throw new Error('CONTROL_API_TOKEN is not set.');

  const res = await fetch(`${baseUrl()}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  });

  const text = await res.text();
  let data: unknown = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: text };
    }
  }
  if (!res.ok) {
    const message =
      (data as { error?: string }).error ?? `Control API error (HTTP ${res.status}).`;
    throw new Error(message);
  }
  return data as T;
}

export interface AddItemInput {
  retailer: string;
  url: string;
  threshold?: number | null;
  name?: string | null;
  interval?: number | null;
}

export interface WatchResult {
  watch?: { id?: string; product_id?: string; display_name?: string | null };
}

export const controlApi = {
  addItem: (input: AddItemInput) => call<WatchResult>('POST', '/api/watches', input),
  removeItem: (id: string) => call('DELETE', `/api/watches/${encodeURIComponent(id)}`),
  pause: (id: string) => call('POST', `/api/watches/${encodeURIComponent(id)}/pause`),
  resume: (id: string) => call('POST', `/api/watches/${encodeURIComponent(id)}/resume`),
  setThreshold: (id: string, threshold: number | null) =>
    call('PATCH', `/api/watches/${encodeURIComponent(id)}`, { threshold }),
  setInterval: (id: string, interval: number) =>
    call('PATCH', `/api/watches/${encodeURIComponent(id)}`, { interval }),
};
