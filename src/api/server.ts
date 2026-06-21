import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { Logger } from '../lib/logger.js';
import * as actions from '../service/watchActions.js';

/**
 * Minimal HTTP control API for the worker (PRD §21 stretch: a web front-end for
 * watch-list management). It exposes the shared watch actions so the read-only
 * dashboard can mutate state without re-implementing adapter logic.
 *
 * Security model (PRD §20): every /api/* call needs a bearer token. The token
 * lives only in the environment, and the dashboard calls this API *server-side*
 * — the browser never sees the token and never calls this API directly, so no
 * CORS surface is exposed. Alerts/ops posting to Discord is unaffected.
 */

const addItemSchema = z.object({
  retailer: z.string().min(1),
  url: z.string().min(1),
  threshold: z.number().finite().nullable().optional(),
  name: z.string().nullable().optional(),
  interval: z.number().int().positive().nullable().optional(),
  tcgSku: z.string().nullable().optional(),
});

const patchSchema = z
  .object({
    threshold: z.number().finite().nullable().optional(),
    interval: z.number().int().positive().nullable().optional(),
  })
  .refine((v) => v.threshold !== undefined || v.interval !== undefined, {
    message: 'provide threshold and/or interval',
  });

export function startControlApi(deps: { logger: Logger }): Server {
  const { logger } = deps;
  const token = process.env.CONTROL_API_TOKEN ?? '';
  const port = Number(process.env.PORT ?? 8080);

  const server = createServer((req, res) => {
    handle(req, res, token, logger).catch((err) => {
      logger.error('control api handler crashed', {
        error: err instanceof Error ? err : new Error(String(err)),
      });
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
    });
  });

  server.listen(port, () => {
    logger.info('control API listening', { port, configured: Boolean(token) });
  });
  return server;
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  token: string,
  logger: Logger,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;
  const method = req.method ?? 'GET';

  // Unauthenticated liveness check — handy for confirming the public URL works.
  if (method === 'GET' && (path === '/health' || path === '/')) {
    return sendJson(res, 200, { ok: true, service: 'sentinel-control-api' });
  }

  if (!path.startsWith('/api/')) return sendJson(res, 404, { error: 'not found' });

  // Auth gate. If no token is configured the API is effectively disabled, so the
  // worker can be deployed before the secret is set without exposing anything.
  if (!token) {
    return sendJson(res, 503, { error: 'control API not configured (CONTROL_API_TOKEN unset)' });
  }
  const header = req.headers['authorization'] ?? '';
  const provided = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!provided || !tokenMatches(provided, token)) {
    return sendJson(res, 401, { error: 'unauthorized' });
  }

  try {
    if (method === 'GET' && path === '/api/retailers') {
      const retailers = await actions.listRetailers();
      return sendJson(res, 200, {
        retailers: retailers.map((r) => ({
          id: r.id,
          name: r.name,
          adapter_type: r.adapter_type,
          enabled: r.enabled,
        })),
      });
    }

    if (method === 'GET' && path === '/api/watches') {
      const retailer = url.searchParams.get('retailer') ?? undefined;
      return sendJson(res, 200, { watches: await actions.listWatches(retailer) });
    }

    if (method === 'POST' && path === '/api/watches') {
      const body = addItemSchema.parse(await readJson(req));
      const watch = await actions.addItem(body);
      logger.info('control api added watch', { id: watch.id, retailer: body.retailer });
      return sendJson(res, 201, { watch });
    }

    const m = path.match(/^\/api\/watches\/([^/]+)(\/pause|\/resume)?$/);
    if (m) {
      const id = decodeURIComponent(m[1] ?? '');
      const sub = m[2];

      if (method === 'DELETE' && !sub) {
        return sendJson(res, 200, { id: await actions.removeItem(id) });
      }
      if (method === 'POST' && sub === '/pause') {
        return sendJson(res, 200, { id: await actions.setItemEnabled(id, false), enabled: false });
      }
      if (method === 'POST' && sub === '/resume') {
        return sendJson(res, 200, { id: await actions.setItemEnabled(id, true), enabled: true });
      }
      if (method === 'PATCH' && !sub) {
        const body = patchSchema.parse(await readJson(req));
        let resolvedId = id;
        if (body.threshold !== undefined) resolvedId = await actions.setItemThreshold(id, body.threshold);
        if (body.interval !== undefined) resolvedId = await actions.setItemInterval(id, body.interval);
        return sendJson(res, 200, { id: resolvedId });
      }
    }

    return sendJson(res, 404, { error: 'not found' });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return sendJson(res, 400, { error: 'invalid request', issues: err.issues });
    }
    const message = err instanceof Error ? err.message : String(err);
    logger.warn('control api action failed', { path, method, error: message });
    return sendJson(res, 400, { error: message });
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(data);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > 1_000_000) throw new Error('request body too large');
    chunks.push(buf);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('invalid JSON body');
  }
}

/** Constant-time token comparison so the check doesn't leak length via timing. */
function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
