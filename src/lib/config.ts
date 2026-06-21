import 'dotenv/config';
import { z } from 'zod';

/**
 * Central, validated configuration. Read once at startup so a missing/garbled
 * env var fails loudly instead of surfacing as a mysterious runtime error.
 * Secrets live only in the environment (PRD §20) — never in the repo or DB.
 */

const numFromEnv = (def: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : Number(v)))
    .pipe(z.number().finite());

const schema = z.object({
  discord: z.object({
    botToken: z.string().min(1, 'DISCORD_BOT_TOKEN is required'),
    clientId: z.string().optional().default(''),
    guildId: z.string().optional().default(''),
    categoryId: z.string().optional().default(''),
    opsChannelId: z.string().optional().default(''),
  }),
  supabase: z.object({
    url: z.string().url('SUPABASE_URL must be a URL'),
    serviceKey: z.string().min(1, 'SUPABASE_SERVICE_KEY is required'),
  }),
  ebay: z.object({
    clientId: z.string().optional().default(''),
    clientSecret: z.string().optional().default(''),
    refreshToken: z.string().optional().default(''),
    env: z.enum(['production', 'sandbox']).default('production'),
  }),
  marketPrice: z.object({
    priceChartingApiKey: z.string().optional().default(''),
    cacheTtlSec: numFromEnv(43200),
  }),
  proxyPoolUrl: z.string().optional().default(''),
  engine: z.object({
    globalIntervalSec: numFromEnv(45),
    alertCooldownSec: numFromEnv(300),
    jitterPct: numFromEnv(0.2),
    adapterConcurrency: numFromEnv(4),
  }),
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export type Config = z.infer<typeof schema>;

let cached: Config | null = null;

export function loadConfig(): Config {
  if (cached) return cached;
  const parsed = schema.safeParse({
    discord: {
      botToken: process.env.DISCORD_BOT_TOKEN,
      clientId: process.env.DISCORD_CLIENT_ID,
      guildId: process.env.DISCORD_GUILD_ID,
      categoryId: process.env.DISCORD_CATEGORY_ID,
      opsChannelId: process.env.DISCORD_OPS_CHANNEL_ID,
    },
    supabase: {
      url: process.env.SUPABASE_URL,
      serviceKey: process.env.SUPABASE_SERVICE_KEY,
    },
    ebay: {
      clientId: process.env.EBAY_CLIENT_ID,
      clientSecret: process.env.EBAY_CLIENT_SECRET,
      refreshToken: process.env.EBAY_REFRESH_TOKEN,
      env: process.env.EBAY_ENV,
    },
    marketPrice: {
      priceChartingApiKey: process.env.PRICECHARTING_API_KEY,
      cacheTtlSec: process.env.MARKET_CACHE_TTL_SEC,
    },
    proxyPoolUrl: process.env.PROXY_POOL_URL,
    engine: {
      globalIntervalSec: process.env.GLOBAL_POLL_INTERVAL_SEC,
      alertCooldownSec: process.env.ALERT_COOLDOWN_SEC,
      jitterPct: process.env.POLL_JITTER_PCT,
      adapterConcurrency: process.env.ADAPTER_CONCURRENCY,
    },
    logLevel: process.env.LOG_LEVEL,
  });

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid configuration:\n${issues}`);
  }

  cached = parsed.data;
  return cached;
}
