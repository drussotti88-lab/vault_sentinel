/** Row shapes mirroring supabase/schema.sql. */

export type AdapterType = 'target' | 'ebay' | 'walmart' | 'pokemon_center';

export type StockStatus = 'in' | 'out' | 'unknown' | 'queue';

export interface RetailerConfig {
  /** Free-form per-adapter config: api keys references, store ids, proxy ref, cadence overrides. */
  [key: string]: unknown;
}

export interface Retailer {
  id: string;
  name: string;
  adapter_type: AdapterType;
  channel_id: string;
  webhook_url: string | null;
  config: RetailerConfig;
  default_interval_sec: number;
  enabled: boolean;
  created_at: string;
}

export interface Watch {
  id: string;
  retailer_id: string;
  product_id: string;
  source_url: string;
  display_name: string | null;
  image_url: string | null;
  threshold: number | null;
  tcg_sku: string | null;
  interval_sec: number | null;
  last_status: StockStatus;
  last_price: number | null;
  last_checked: string | null;
  last_alerted: string | null;
  enabled: boolean;
  created_at: string;
}

export interface AlertRow {
  id: string;
  watch_id: string;
  fired_at: string;
  price: number | null;
  market_price: number | null;
  confidence: string | null;
  payload: unknown;
}

export interface PriceCacheRow {
  tcg_sku: string;
  value: number | null;
  currency: string;
  source: string | null;
  sample_size: number | null;
  as_of: string | null;
  expires_at: string | null;
}

export interface ProxyRow {
  id: string;
  endpoint: string;
  kind: 'residential' | 'datacenter' | null;
  healthy: boolean;
  last_used: string | null;
}
