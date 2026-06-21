import 'server-only';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * Server-only data access for the read-only dashboard. Uses a read-only key
 * (never the worker's service key, PRD §20) and is only ever imported by server
 * components, so the key never reaches the browser.
 *
 * Every query degrades gracefully: if Supabase isn't configured (e.g. a preview
 * build with no env), it returns empty data instead of throwing, so the page
 * still renders a clean empty state.
 */

export interface RetailerView {
  id: string;
  name: string;
  adapter_type: string;
  enabled: boolean;
  default_interval_sec: number;
}

export interface WatchView {
  id: string;
  retailer_id: string;
  display_name: string | null;
  product_id: string;
  source_url: string;
  threshold: number | null;
  last_status: string;
  last_price: number | null;
  last_checked: string | null;
  enabled: boolean;
}

export interface AlertView {
  id: string;
  watch_id: string;
  fired_at: string;
  price: number | null;
  market_price: number | null;
  confidence: string | null;
}

export interface DashboardData {
  configured: boolean;
  retailers: RetailerView[];
  watches: WatchView[];
  alerts: AlertView[];
}

function client(): SupabaseClient | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_READONLY_KEY;
  if (!url || !key) return null;
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export async function getDashboardData(): Promise<DashboardData> {
  const supabase = client();
  if (!supabase) {
    return { configured: false, retailers: [], watches: [], alerts: [] };
  }

  const [retailersRes, watchesRes, alertsRes] = await Promise.all([
    supabase.from('retailers').select('id,name,adapter_type,enabled,default_interval_sec'),
    supabase
      .from('watches')
      .select(
        'id,retailer_id,display_name,product_id,source_url,threshold,last_status,last_price,last_checked,enabled',
      ),
    supabase
      .from('alerts')
      .select('id,watch_id,fired_at,price,market_price,confidence')
      .order('fired_at', { ascending: false })
      .limit(50),
  ]);

  return {
    configured: true,
    retailers: (retailersRes.data ?? []) as RetailerView[],
    watches: (watchesRes.data ?? []) as WatchView[],
    alerts: (alertsRes.data ?? []) as AlertView[],
  };
}
