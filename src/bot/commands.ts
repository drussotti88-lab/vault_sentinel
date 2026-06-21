import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { loadConfig } from '../lib/config.js';
import { createLogger } from '../lib/logger.js';
import { retailers as retailerRepo, watches as watchRepo } from '../db/repositories.js';
import { listAdapterTypes } from '../adapters/registry.js';
import { DiscordRest } from '../lib/discordRest.js';
import * as actions from '../service/watchActions.js';
import type { AdapterType } from '../db/types.js';
import type { Engine } from '../core/engine.js';

/**
 * Slash-command spec (PRD §15). The bot is lightweight — it mostly translates
 * commands into Supabase writes; the engine reacts on its next config refresh.
 * /add-item resolves the URL through the bound adapter before inserting.
 */

const logger = createLogger(loadConfig().logLevel, { component: 'bot' });

export interface CommandDeps {
  engine?: Engine;
}

const ADAPTER_CHOICES = listAdapterTypes().map((t) => ({ name: t, value: t }));

export const commandDefinitions = [
  new SlashCommandBuilder()
    .setName('add-retailer')
    .setDescription('Register a retailer and bind it to a channel')
    .addStringOption((o) => o.setName('name').setDescription('Display name').setRequired(true))
    .addStringOption((o) =>
      o
        .setName('adapter')
        .setDescription('Adapter type')
        .setRequired(true)
        .addChoices(...ADAPTER_CHOICES),
    )
    .addChannelOption((o) =>
      o.setName('channel').setDescription('Existing channel to bind').setRequired(false),
    )
    .addBooleanOption((o) =>
      o
        .setName('create_channel')
        .setDescription('Auto-create a channel under the category (default: true unless channel given)')
        .setRequired(false),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('add-item')
    .setDescription('Start watching a product URL')
    .addStringOption((o) => o.setName('retailer').setDescription('Retailer name').setRequired(true))
    .addStringOption((o) => o.setName('url').setDescription('Product URL').setRequired(true))
    .addNumberOption((o) =>
      o.setName('threshold').setDescription('Alert only if price <= threshold').setRequired(false),
    )
    .addStringOption((o) => o.setName('name').setDescription('Override display name').setRequired(false))
    .addIntegerOption((o) =>
      o.setName('interval').setDescription('Poll interval (seconds)').setRequired(false),
    )
    .addStringOption((o) =>
      o.setName('tcg_sku').setDescription('TCG SKU for market-price enrichment').setRequired(false),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('list-watches')
    .setDescription('List tracked items with status')
    .addStringOption((o) => o.setName('retailer').setDescription('Filter by retailer').setRequired(false)),

  new SlashCommandBuilder()
    .setName('remove-item')
    .setDescription('Stop watching an item')
    .addStringOption((o) => o.setName('id').setDescription('Watch id').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('pause-item')
    .setDescription('Pause an item')
    .addStringOption((o) => o.setName('id').setDescription('Watch id').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('resume-item')
    .setDescription('Resume an item')
    .addStringOption((o) => o.setName('id').setDescription('Watch id').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('set-threshold')
    .setDescription('Update an item price threshold')
    .addStringOption((o) => o.setName('id').setDescription('Watch id').setRequired(true))
    .addNumberOption((o) => o.setName('value').setDescription('New threshold').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('set-interval')
    .setDescription('Set per-item poll cadence')
    .addStringOption((o) => o.setName('id').setDescription('Watch id').setRequired(true))
    .addIntegerOption((o) => o.setName('seconds').setDescription('Interval seconds').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder().setName('status').setDescription('Worker heartbeat + per-adapter health'),

  new SlashCommandBuilder()
    .setName('check-now')
    .setDescription('Force an immediate poll (debug)')
    .addStringOption((o) => o.setName('id').setDescription('Watch id').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('set-retailer-config')
    .setDescription('Set a config value on a retailer (API key, store id, proxy, etc.)')
    .addStringOption((o) => o.setName('retailer').setDescription('Retailer name').setRequired(true))
    .addStringOption((o) =>
      o
        .setName('key')
        .setDescription('Config key, e.g. apiKey, storeId, zip, inventoryUrl, queueStatusUrl')
        .setRequired(true),
    )
    .addStringOption((o) => o.setName('value').setDescription('Value to set').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('get-retailer-config')
    .setDescription("Show a retailer's config (secrets masked)")
    .addStringOption((o) => o.setName('retailer').setDescription('Retailer name').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
].map((b) => b.toJSON());

// ---------------------------------------------------------------------------

export async function handleInteraction(
  interaction: ChatInputCommandInteraction,
  deps: CommandDeps,
): Promise<void> {
  try {
    switch (interaction.commandName) {
      case 'add-retailer':
        return await addRetailer(interaction);
      case 'add-item':
        return await addItem(interaction);
      case 'list-watches':
        return await listWatches(interaction);
      case 'remove-item':
        return await removeItem(interaction);
      case 'pause-item':
        return await toggleItem(interaction, false);
      case 'resume-item':
        return await toggleItem(interaction, true);
      case 'set-threshold':
        return await setThreshold(interaction);
      case 'set-interval':
        return await setInterval(interaction);
      case 'status':
        return await status(interaction, deps);
      case 'check-now':
        return await checkNow(interaction, deps);
      case 'set-retailer-config':
        return await setRetailerConfig(interaction);
      case 'get-retailer-config':
        return await getRetailerConfig(interaction);
      default:
        await interaction.reply({ content: 'Unknown command.', ephemeral: true });
    }
  } catch (err) {
    logger.error('command failed', {
      command: interaction.commandName,
      error: (err as Error).message,
    });
    const msg = `Error: ${(err as Error).message}`;
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(msg);
    } else {
      await interaction.reply({ content: msg, ephemeral: true });
    }
  }
}

async function addRetailer(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true });
  const cfg = loadConfig();
  const name = interaction.options.getString('name', true);
  const adapter = interaction.options.getString('adapter', true) as AdapterType;
  const channelOpt = interaction.options.getChannel('channel');
  // Auto-create by default (PRD §28 #6 decision): create a channel unless an
  // existing one is bound, or the operator explicitly opts out.
  const createChannel = interaction.options.getBoolean('create_channel') ?? !channelOpt;

  const rest = new DiscordRest(cfg.discord.botToken, { logger });
  let channelId = channelOpt?.id ?? '';

  if (createChannel || !channelId) {
    if (!cfg.discord.guildId) throw new Error('DISCORD_GUILD_ID not configured for channel creation');
    const created = await rest.createTextChannel(
      cfg.discord.guildId,
      name.toLowerCase().replace(/\s+/g, '-'),
      cfg.discord.categoryId || undefined,
    );
    channelId = created.id;
  }

  // Create a webhook on the channel for fast posts (FR-17).
  let webhookUrl: string | null = null;
  try {
    const wh = await rest.createWebhook(channelId);
    webhookUrl = wh.url;
  } catch (err) {
    logger.warn('webhook creation failed; alerts will need a webhook later', {
      error: (err as Error).message,
    });
  }

  const retailer = await retailerRepo.create({
    name,
    adapter_type: adapter,
    channel_id: channelId,
    webhook_url: webhookUrl,
  });

  await interaction.editReply(
    `Registered **${retailer.name}** (\`${adapter}\`) on <#${channelId}>.\nId: \`${retailer.id}\``,
  );
}

async function addItem(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true });
  const retailerName = interaction.options.getString('retailer', true);
  const watch = await actions.addItem({
    retailer: retailerName,
    url: interaction.options.getString('url', true),
    threshold: interaction.options.getNumber('threshold'),
    name: interaction.options.getString('name'),
    interval: interaction.options.getInteger('interval'),
    tcgSku: interaction.options.getString('tcg_sku'),
  });

  const thresholdText =
    watch.threshold !== null ? ` ≤ $${watch.threshold.toFixed(2)}` : ' (any price)';
  await interaction.editReply(
    `Watching **${watch.display_name ?? watch.product_id}** on **${retailerName}**${thresholdText}.\nId: \`${watch.id}\``,
  );
}

async function listWatches(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true });
  const retailerName = interaction.options.getString('retailer');
  const rows = await actions.listWatches(retailerName ?? undefined);
  if (rows.length === 0) {
    await interaction.editReply('No watches.');
    return;
  }
  const lines = rows
    .slice(0, 25)
    .map((w) => {
      const price = w.last_price !== null ? `$${w.last_price}` : '—';
      const flag = w.enabled ? '' : ' (paused)';
      return `\`${w.id.slice(0, 8)}\` ${w.display_name ?? w.product_id} — ${w.last_status} @ ${price}${flag}`;
    })
    .join('\n');
  await interaction.editReply(lines.slice(0, 1900));
}

async function removeItem(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true });
  const id = await actions.removeItem(interaction.options.getString('id', true));
  await interaction.editReply(`Removed watch \`${id}\`.`);
}

async function toggleItem(
  interaction: ChatInputCommandInteraction,
  enabled: boolean,
): Promise<void> {
  await interaction.deferReply({ ephemeral: true });
  const id = await actions.setItemEnabled(interaction.options.getString('id', true), enabled);
  await interaction.editReply(`${enabled ? 'Resumed' : 'Paused'} watch \`${id}\`.`);
}

async function setThreshold(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true });
  const value = interaction.options.getNumber('value', true);
  const id = await actions.setItemThreshold(interaction.options.getString('id', true), value);
  await interaction.editReply(`Threshold for \`${id}\` set to $${value.toFixed(2)}.`);
}

async function setInterval(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true });
  const seconds = interaction.options.getInteger('seconds', true);
  const id = await actions.setItemInterval(interaction.options.getString('id', true), seconds);
  await interaction.editReply(`Interval for \`${id}\` set to ${seconds}s.`);
}

async function status(
  interaction: ChatInputCommandInteraction,
  _deps: CommandDeps,
): Promise<void> {
  await interaction.deferReply({ ephemeral: true });
  const [retailers, watches] = await Promise.all([retailerRepo.list(), watchRepo.listAll()]);
  const enabledWatches = watches.filter((w) => w.enabled).length;
  const lines = [
    `**Sentinel status**`,
    `Retailers: ${retailers.length}`,
    `Watches: ${watches.length} (${enabledWatches} enabled)`,
    ...retailers.map((r) => `• ${r.name} (\`${r.adapter_type}\`) — ${r.enabled ? 'enabled' : 'disabled'}`),
  ];
  await interaction.editReply(lines.join('\n').slice(0, 1900));
}

async function checkNow(
  interaction: ChatInputCommandInteraction,
  deps: CommandDeps,
): Promise<void> {
  await interaction.deferReply({ ephemeral: true });
  if (!deps.engine) {
    await interaction.editReply('Engine not attached to this process; cannot force a poll.');
    return;
  }
  const id = await actions.resolveWatchId(interaction.options.getString('id', true));
  const result = await deps.engine.checkNow(id);
  if (!result) {
    await interaction.editReply(`Watch \`${id}\` not found or not enabled.`);
    return;
  }
  if (result.error) {
    await interaction.editReply(`Checked \`${id}\`: error ${result.error.code} — ${result.error.message}`);
    return;
  }
  const price = result.price !== null ? `$${result.price}` : '—';
  await interaction.editReply(
    `Checked \`${id}\`: inStock=${result.inStock}, price=${price}, confidence=${result.confidence}.`,
  );
}

async function setRetailerConfig(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true });
  const name = interaction.options.getString('retailer', true);
  const key = interaction.options.getString('key', true).trim();
  const value = interaction.options.getString('value', true);
  const retailer = await retailerRepo.getByName(name);
  if (!retailer) throw new Error(`No retailer named "${name}".`);

  const config = { ...retailer.config, [key]: value };
  await retailerRepo.setConfig(retailer.id, config);
  await interaction.editReply(
    `Set \`${key}\` on **${retailer.name}**. The engine applies it on its next config refresh (~1 min).`,
  );
}

async function getRetailerConfig(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true });
  const name = interaction.options.getString('retailer', true);
  const retailer = await retailerRepo.getByName(name);
  if (!retailer) throw new Error(`No retailer named "${name}".`);

  const keys = Object.keys(retailer.config);
  if (keys.length === 0) {
    await interaction.editReply(`**${retailer.name}** has no config set.`);
    return;
  }
  const lines = keys.map((k) => `\`${k}\`: ${maskConfigValue(k, retailer.config[k])}`);
  await interaction.editReply([`**${retailer.name}** config:`, ...lines].join('\n').slice(0, 1900));
}

/** Mask secret-looking values so /get-retailer-config doesn't echo full keys. */
function maskConfigValue(key: string, value: unknown): string {
  const s = String(value);
  if (/key|token|secret|password|proxy/i.test(key) && s.length > 6) {
    return `${'•'.repeat(s.length - 4)}${s.slice(-4)}`;
  }
  return s.length > 80 ? `${s.slice(0, 77)}…` : s;
}
