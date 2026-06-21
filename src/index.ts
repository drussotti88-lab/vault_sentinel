import { loadConfig } from './lib/config.js';
import { createLogger } from './lib/logger.js';
import { Engine } from './core/engine.js';
import { startBot } from './bot/index.js';
import { startControlApi } from './api/server.js';

/**
 * Worker entrypoint (PRD §21): the persistent process running the core engine
 * and the Discord bot together. Must be long-running — continuous sub-minute
 * polling does not fit serverless cron (timeouts, no persistent state, cold
 * starts). Deploy on Railway / Fly.io / a small VPS with auto-restart.
 */
async function main(): Promise<void> {
  const cfg = loadConfig();
  const logger = createLogger(cfg.logLevel, { component: 'main' });
  logger.info('Sentinel starting', { env: cfg.ebay.env });

  // Catch-all diagnostics so a stray async error is logged with its full stack
  // instead of crashing the container with a one-line message. A long-running
  // bot/poller is better off logging and continuing than looping on restart.
  process.on('unhandledRejection', (reason) => {
    logger.error('unhandledRejection', {
      error: reason instanceof Error ? reason : new Error(String(reason)),
    });
  });
  process.on('uncaughtException', (err) => {
    logger.error('uncaughtException', { error: err });
  });

  const engine = new Engine();

  // Start the bot first so commands are live while the engine warms up. The
  // engine reference lets /check-now and /status query live state.
  const client = await startBot({ engine });

  // Web control API for the dashboard (watch-list management). Shares the same
  // actions as the slash commands; gated by CONTROL_API_TOKEN.
  const api = startControlApi({ logger });

  // Engine.start() runs the poll loop forever; don't await it past startup.
  void engine.start().catch((err) => {
    logger.error('engine crashed', {
      error: err instanceof Error ? err : new Error(String(err)),
    });
    process.exit(1);
  });

  const shutdown = (signal: string) => {
    logger.info('shutting down', { signal });
    engine.stop();
    void client.destroy();
    api.close();
    setTimeout(() => process.exit(0), 1000);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
