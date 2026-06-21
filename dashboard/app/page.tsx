import { getDashboardData, type RetailerView } from './lib/data';
import { ConfidenceBadge } from './components/badges';
import { AddItemForm } from './components/AddItemForm';
import { WatchTable, type WatchRow } from './components/WatchTable';
import { controlConfigured } from '@/lib/controlApi';

// Always render fresh — this mirrors live worker state in Supabase. No build-time
// fetch, so the page builds fine even without Supabase env configured.
export const dynamic = 'force-dynamic';
export const revalidate = 0;

function money(n: number | null): string {
  return n === null || n === undefined ? '—' : `$${Number(n).toFixed(2)}`;
}

function timeAgo(iso: string | null): string {
  if (!iso) return 'never';
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-lg border border-edge bg-panel p-4">
      <div className="text-2xl font-semibold text-white">{value}</div>
      <div className="text-xs uppercase tracking-wide text-zinc-500">{label}</div>
    </div>
  );
}

export default async function Page() {
  const { configured, retailers, watches, alerts } = await getDashboardData();
  const controlEnabled = controlConfigured();

  const watchName = (id: string): string => {
    const w = watches.find((x) => x.id === id);
    return w?.display_name ?? w?.product_id ?? id.slice(0, 8);
  };

  const enabledWatches = watches.filter((w) => w.enabled).length;
  const inStock = watches.filter((w) => w.last_status === 'in').length;

  const retailerOptions = retailers.map((r: RetailerView) => ({ id: r.id, name: r.name }));
  const watchRows: WatchRow[] = watches.map((w) => ({
    id: w.id,
    retailer_id: w.retailer_id,
    display_name: w.display_name,
    product_id: w.product_id,
    source_url: w.source_url,
    threshold: w.threshold,
    interval_sec: w.interval_sec,
    last_status: w.last_status,
    last_price: w.last_price,
    last_checked: w.last_checked,
    enabled: w.enabled,
  }));

  return (
    <main className="mx-auto max-w-6xl px-6 py-10">
      <header className="mb-8 flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Sentinel</h1>
          <p className="text-sm text-zinc-500">Stock Checkers — control panel</p>
        </div>
        <form method="POST" action="/api/logout">
          <button className="text-xs text-zinc-500 hover:text-zinc-300">Sign out</button>
        </form>
      </header>

      {!configured && (
        <div className="mb-8 rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-200">
          Supabase isn&apos;t configured. Set <code>SUPABASE_URL</code> and{' '}
          <code>SUPABASE_READONLY_KEY</code> in the environment to see live data.
        </div>
      )}
      {configured && !controlEnabled && (
        <div className="mb-8 rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-200">
          View-only: set <code>CONTROL_API_URL</code> and <code>CONTROL_API_TOKEN</code> in Vercel
          to enable adding and managing items.
        </div>
      )}

      <section className="mb-10 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Stat label="Retailers" value={retailers.length} />
        <Stat label="Watches" value={`${enabledWatches}/${watches.length}`} />
        <Stat label="In stock" value={inStock} />
        <Stat label="Alerts (50 max)" value={alerts.length} />
      </section>

      {/* Add item */}
      <section className="mb-10">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-zinc-400">
          Add an item to watch
        </h2>
        <AddItemForm retailers={retailerOptions} enabled={controlEnabled} />
      </section>

      {/* Watches + controls */}
      <section className="mb-10">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-zinc-400">Watches</h2>
        <WatchTable watches={watchRows} retailers={retailerOptions} enabled={controlEnabled} />
      </section>

      {/* Recent alerts (read-only) */}
      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-zinc-400">
          Recent alerts
        </h2>
        <div className="overflow-hidden rounded-lg border border-edge">
          <table className="w-full text-sm">
            <thead className="bg-panel text-left text-xs uppercase tracking-wide text-zinc-500">
              <tr>
                <th className="px-4 py-2">When</th>
                <th className="px-4 py-2">Item</th>
                <th className="px-4 py-2">Price</th>
                <th className="px-4 py-2">Market</th>
                <th className="px-4 py-2">Confidence</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-edge">
              {alerts.length === 0 && (
                <tr>
                  <td className="px-4 py-6 text-center text-zinc-600" colSpan={5}>
                    No alerts yet.
                  </td>
                </tr>
              )}
              {alerts.map((a) => (
                <tr key={a.id}>
                  <td className="px-4 py-2 text-zinc-500">{timeAgo(a.fired_at)}</td>
                  <td className="px-4 py-2 text-zinc-200">{watchName(a.watch_id)}</td>
                  <td className="px-4 py-2 text-zinc-300">{money(a.price)}</td>
                  <td className="px-4 py-2 text-zinc-400">{money(a.market_price)}</td>
                  <td className="px-4 py-2">
                    <ConfidenceBadge confidence={a.confidence} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <footer className="mt-10 text-center text-xs text-zinc-600">
        Changes here post to Discord just like the slash commands. Alerts continue to fire in your
        Discord channels.
      </footer>
    </main>
  );
}
