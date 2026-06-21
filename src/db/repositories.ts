import { getSupabase } from './client.js';
import type {
  Retailer,
  Watch,
  AlertRow,
  PriceCacheRow,
  StockStatus,
  AdapterType,
} from './types.js';

/**
 * Data-access layer. All Supabase reads/writes funnel through here so the
 * engine, bot, and dispatcher share one consistent view of state.
 */

function unwrap<T>(data: T | null, error: { message: string } | null): T {
  if (error) throw new Error(error.message);
  if (data === null) throw new Error('expected a row but got null');
  return data;
}

// ----------------------------- Retailers -----------------------------------

export const retailers = {
  async list(): Promise<Retailer[]> {
    const { data, error } = await getSupabase().from('retailers').select('*');
    if (error) throw new Error(error.message);
    return (data ?? []) as Retailer[];
  },

  async listEnabled(): Promise<Retailer[]> {
    const { data, error } = await getSupabase()
      .from('retailers')
      .select('*')
      .eq('enabled', true);
    if (error) throw new Error(error.message);
    return (data ?? []) as Retailer[];
  },

  async get(id: string): Promise<Retailer | null> {
    const { data, error } = await getSupabase()
      .from('retailers')
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return (data as Retailer) ?? null;
  },

  async getByName(name: string): Promise<Retailer | null> {
    const { data, error } = await getSupabase()
      .from('retailers')
      .select('*')
      .ilike('name', name)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return (data as Retailer) ?? null;
  },

  async create(input: {
    name: string;
    adapter_type: AdapterType;
    channel_id: string;
    webhook_url?: string | null;
    config?: Record<string, unknown>;
    default_interval_sec?: number;
  }): Promise<Retailer> {
    const { data, error } = await getSupabase()
      .from('retailers')
      .insert({
        name: input.name,
        adapter_type: input.adapter_type,
        channel_id: input.channel_id,
        webhook_url: input.webhook_url ?? null,
        config: input.config ?? {},
        default_interval_sec: input.default_interval_sec ?? 45,
      })
      .select('*')
      .single();
    return unwrap(data as Retailer, error);
  },

  async setWebhook(id: string, webhookUrl: string): Promise<void> {
    const { error } = await getSupabase()
      .from('retailers')
      .update({ webhook_url: webhookUrl })
      .eq('id', id);
    if (error) throw new Error(error.message);
  },

  async setConfig(id: string, config: Record<string, unknown>): Promise<void> {
    const { error } = await getSupabase().from('retailers').update({ config }).eq('id', id);
    if (error) throw new Error(error.message);
  },
};

// ------------------------------- Watches ------------------------------------

export const watches = {
  async listEnabled(): Promise<Watch[]> {
    const { data, error } = await getSupabase()
      .from('watches')
      .select('*')
      .eq('enabled', true);
    if (error) throw new Error(error.message);
    return (data ?? []) as Watch[];
  },

  async listByRetailer(retailerId: string): Promise<Watch[]> {
    const { data, error } = await getSupabase()
      .from('watches')
      .select('*')
      .eq('retailer_id', retailerId);
    if (error) throw new Error(error.message);
    return (data ?? []) as Watch[];
  },

  async listAll(): Promise<Watch[]> {
    const { data, error } = await getSupabase().from('watches').select('*');
    if (error) throw new Error(error.message);
    return (data ?? []) as Watch[];
  },

  async get(id: string): Promise<Watch | null> {
    const { data, error } = await getSupabase()
      .from('watches')
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return (data as Watch) ?? null;
  },

  async create(input: {
    retailer_id: string;
    product_id: string;
    source_url: string;
    display_name?: string | null;
    image_url?: string | null;
    threshold?: number | null;
    tcg_sku?: string | null;
    interval_sec?: number | null;
    enabled?: boolean;
  }): Promise<Watch> {
    const row: Record<string, unknown> = {
      retailer_id: input.retailer_id,
      product_id: input.product_id,
      source_url: input.source_url,
      display_name: input.display_name ?? null,
      image_url: input.image_url ?? null,
      threshold: input.threshold ?? null,
      tcg_sku: input.tcg_sku ?? null,
      interval_sec: input.interval_sec ?? null,
    };
    // Discovery creates items paused; normal adds default to enabled (schema default).
    if (input.enabled !== undefined) row.enabled = input.enabled;
    const { data, error } = await getSupabase().from('watches').insert(row).select('*').single();
    return unwrap(data as Watch, error);
  },

  async remove(id: string): Promise<void> {
    const { error } = await getSupabase().from('watches').delete().eq('id', id);
    if (error) throw new Error(error.message);
  },

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const { error } = await getSupabase().from('watches').update({ enabled }).eq('id', id);
    if (error) throw new Error(error.message);
  },

  async setThreshold(id: string, threshold: number | null): Promise<void> {
    const { error } = await getSupabase().from('watches').update({ threshold }).eq('id', id);
    if (error) throw new Error(error.message);
  },

  async setInterval(id: string, intervalSec: number | null): Promise<void> {
    const { error } = await getSupabase()
      .from('watches')
      .update({ interval_sec: intervalSec })
      .eq('id', id);
    if (error) throw new Error(error.message);
  },

  /** Persist the outcome of a poll. */
  async recordCheck(
    id: string,
    fields: {
      last_status: StockStatus;
      last_price: number | null;
      last_checked: string;
      last_alerted?: string | null;
    },
  ): Promise<void> {
    const update: Record<string, unknown> = {
      last_status: fields.last_status,
      last_price: fields.last_price,
      last_checked: fields.last_checked,
    };
    if (fields.last_alerted !== undefined) update.last_alerted = fields.last_alerted;
    const { error } = await getSupabase().from('watches').update(update).eq('id', id);
    if (error) throw new Error(error.message);
  },
};

// ------------------------------- Alerts -------------------------------------

export const alerts = {
  async log(input: {
    watch_id: string;
    price: number | null;
    market_price: number | null;
    confidence: string | null;
    payload: unknown;
  }): Promise<AlertRow> {
    const { data, error } = await getSupabase()
      .from('alerts')
      .insert(input)
      .select('*')
      .single();
    return unwrap(data as AlertRow, error);
  },
};

// ----------------------------- Price cache ----------------------------------

export const priceCache = {
  async get(tcgSku: string): Promise<PriceCacheRow | null> {
    const { data, error } = await getSupabase()
      .from('price_cache')
      .select('*')
      .eq('tcg_sku', tcgSku)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return (data as PriceCacheRow) ?? null;
  },

  async upsert(row: PriceCacheRow): Promise<void> {
    const { error } = await getSupabase().from('price_cache').upsert(row);
    if (error) throw new Error(error.message);
  },
};
