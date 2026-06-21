import { REST, Routes } from 'discord.js';
import { loadConfig } from '../lib/config.js';
import { createLogger } from '../lib/logger.js';
import { commandDefinitions } from './commands.js';

/**
 * Registers slash commands with Discord. Guild-scoped registration updates
 * instantly (vs. ~1h for global), which suits a single-guild deployment.
 * Run with `npm run register-commands`.
 */
async function main(): Promise<void> {
  const cfg = loadConfig();
  const logger = createLogger(cfg.logLevel, { component: 'register' });

  if (!cfg.discord.clientId) throw new Error('DISCORD_CLIENT_ID is required to register commands');
  const rest = new REST({ version: '10' }).setToken(cfg.discord.botToken);

  if (cfg.discord.guildId) {
    await rest.put(
      Routes.applicationGuildCommands(cfg.discord.clientId, cfg.discord.guildId),
      { body: commandDefinitions },
    );
    logger.info('registered guild commands', {
      guildId: cfg.discord.guildId,
      count: commandDefinitions.length,
    });
  } else {
    await rest.put(Routes.applicationCommands(cfg.discord.clientId), {
      body: commandDefinitions,
    });
    logger.info('registered global commands', { count: commandDefinitions.length });
  }
}

main().catch((err) => {
  console.error('failed to register commands:', err);
  process.exit(1);
});
