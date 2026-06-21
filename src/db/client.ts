import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { loadConfig } from '../lib/config.js';

/**
 * Single Supabase service-role client for the worker (PRD §20: the service key
 * is used only by the worker; the bot uses a constrained role). Supabase is the
 * single source of truth for config and state (PRD §9.1).
 */
let cached: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (cached) return cached;
  const cfg = loadConfig();
  cached = createClient(cfg.supabase.url, cfg.supabase.serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cached;
}
