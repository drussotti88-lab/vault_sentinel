import { Client, GatewayIntentBits, Events } from 'discord.js';
import { loadConfig } from '../lib/config.js';
import { createLogger } from '../lib/logger.js';
import { handleInteraction, commandDefinitions, type CommandDeps } from './commands.js';
import type { Engine } from '../core/engine.js';

/**
 * Discord gateway bot (PRD §9.1). Owns slash commands and channel/category
 * management; lightweight, mostly translating commands into Supabase writes.
 * Least-privilege: scoped to the single guild (PRD §20).
 */
export async function startBot(opts: { engine?: Engine } = {}): Promise<Client> {
  const cfg = loadConfig();
  const logger = createLogger(cfg.logLevel, { component: 'bot' });

  // GatewayIntentBits.Guilds is enough — we only handle interactions and manage
  // channels; we don't read message content.
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  const deps: CommandDeps = {};
  if (opts.engine) deps.engine = opts.engine;

  client.once(Events.ClientReady, async (c) => {
    logger.info('bot ready', { user: c.user.tag });

    // Auto-register slash commands on startup using the already-authenticated
    // client, so production hosts (e.g. Railway) need no separate tsx-based
    // `register-commands` step. Guild-scoped registration updates instantly
    // (vs. ~1h for global), which suits a single-guild deployment (PRD §15).
    try {
      if (cfg.discord.guildId) {
        await c.application.commands.set(commandDefinitions, cfg.discord.guildId);
        logger.info('registered guild commands', {
          guildId: cfg.discord.guildId,
          count: commandDefinitions.length,
        });
      } else {
        await c.application.commands.set(commandDefinitions);
        logger.info('registered global commands', { count: commandDefinitions.length });
      }
    } catch (err) {
      // Don't crash the bot if registration fails — log loudly and keep serving
      // any commands already registered.
      logger.error('failed to register commands', { error: (err as Error).message });
    }
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    await handleInteraction(interaction, deps);
  });

  await client.login(cfg.discord.botToken);
  return client;
}

// Allow running the bot standalone: `npm run bot`.
if (import.meta.url === `file://${process.argv[1]}`) {
  startBot().catch((err) => {
    console.error('bot failed to start:', err);
    process.exit(1);
  });
}
