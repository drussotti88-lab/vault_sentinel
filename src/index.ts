import { loadConfig } from './lib/config.js';
import { createLogger } from './lib/logger.js';
import { Engine } from './core/engine.js';
import { startBot } from './bot/index.js';

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

  const engine = new Engine();

  // Start the bot first so commands are live while the engine warms up. The
  // engine reference lets /check-now and /status query live state.
  const client = await startBot({ engine });

  // Engine.start() runs the poll loop forever; don't await it past startup.
  void engine.start().catch((err) => {
    logger.error('engine crashed', { error: (err as Error).message });
    process.exit(1);
  });

  const shutdown = (signal: string) => {
    logger.info('shutting down', { signal });
    engine.stop();
    void client.destroy();
    setTimeout(() => process.exit(0), 1000);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
