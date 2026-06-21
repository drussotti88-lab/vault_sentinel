import { getDashboardData, type RetailerView } from './lib/data';
import { StatusBadge, ConfidenceBadge } from './components/badges';

// Always render fresh — this mirrors live worker state in Supabase. No build-time
// fetch, so the page builds fine even without Supabase env configured.
export const dynamic = 'force-dynamic';
export const revalidate = 0;

function money(n: number | null): string {
  return n === null || n === undefined ? '—' : `$${Number(n).toFixed(2)}`;
}

function timeAgo(iso: string | null): string {
  if (!iso) return 'never';
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.round(diff / 1000);
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

  const retailerName = (id: string): string =>
    retailers.find((r: RetailerView) => r.id === id)?.name ?? '—';
  const watchName = (id: string): string => {
    const w = watches.find((x) => x.id === id);
    return w?.display_name ?? w?.product_id ?? id.slice(0, 8);
  };

  const enabledWatches = watches.filter((w) => w.enabled).length;
  const inStock = watches.filter((w) => w.last_status === 'in').length;

  return (
    <main className="mx-auto max-w-6xl px-6 py-10">
      <header className="mb-8 flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Sentinel</h1>
          <p className="text-sm text-zinc-500">Stock Checkers — read-only dashboard</p>
        </div>
        <span className="text-xs text-zinc-600">live from Supabase</span>
      </header>

      {!configured && (
        <div className="mb-8 rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-200">
          Supabase isn&apos;t configured. Set <code>SUPABASE_URL</code> and{' '}
          <code>SUPABASE_READONLY_KEY</code> in the environment to see live data.
        </div>
      )}

      <section className="mb-10 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Stat label="Retailers" value={retailers.length} />
        <Stat label="Watches" value={`${enabledWatches}/${watches.length}`} />
        <Stat label="In stock" value={inStock} />
        <Stat label="Alerts (50 max)" value={alerts.length} />
      </section>

      {/* Watches */}
      <section className="mb-10">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-zinc-400">
          Watches
        </h2>
        <div className="overflow-hidden rounded-lg border border-edge">
          <table className="w-full text-sm">
            <thead className="bg-panel text-left text-xs uppercase tracking-wide text-zinc-500">
              <tr>
                <th className="px-4 py-2">Item</th>
                <th className="px-4 py-2">Retailer</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2">Price</th>
                <th className="px-4 py-2">Threshold</th>
                <th className="px-4 py-2">Checked</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-edge">
              {watches.length === 0 && (
                <tr>
                  <td className="px-4 py-6 text-center text-zinc-600" colSpan={6}>
                    No watches yet.
                  </td>
                </tr>
              )}
              {watches.map((w) => (
                <tr key={w.id} className={w.enabled ? '' : 'opacity-50'}>
                  <td className="px-4 py-2">
                    <a
                      href={w.source_url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-zinc-200 hover:text-white hover:underline"
                    >
                      {w.display_name ?? w.product_id}
                    </a>
                  </td>
                  <td className="px-4 py-2 text-zinc-400">{retailerName(w.retailer_id)}</td>
                  <td className="px-4 py-2">
                    <StatusBadge status={w.last_status} />
                  </td>
                  <td className="px-4 py-2 text-zinc-300">{money(w.last_price)}</td>
                  <td className="px-4 py-2 text-zinc-500">{money(w.threshold)}</td>
                  <td className="px-4 py-2 text-zinc-500">{timeAgo(w.last_checked)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Recent alerts */}
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
        Read-only. Manage watches via Discord slash commands. The poller runs on
        Fly.io, not here.
      </footer>
    </main>
  );
}
