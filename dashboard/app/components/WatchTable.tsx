'use client';

import { useState } from 'react';
import { StatusBadge } from './badges';
import {
  removeItemAction,
  setEnabledAction,
  setThresholdAction,
  setIntervalAction,
  type ActionResult,
} from '../actions';

export interface WatchRow {
  id: string;
  retailer_id: string;
  display_name: string | null;
  product_id: string;
  source_url: string;
  threshold: number | null;
  interval_sec: number | null;
  last_status: string;
  last_price: number | null;
  last_checked: string | null;
  enabled: boolean;
}

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

export function WatchTable({
  watches,
  retailers,
  enabled,
}: {
  watches: WatchRow[];
  retailers: { id: string; name: string }[];
  enabled: boolean;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const retailerName = (id: string): string =>
    retailers.find((r) => r.id === id)?.name ?? '—';

  async function run(id: string, fn: () => Promise<ActionResult>): Promise<void> {
    setError(null);
    setBusyId(id);
    try {
      const res = await fn();
      if (!res.ok) setError(res.error ?? 'Something went wrong.');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  }

  function editThreshold(w: WatchRow): void {
    const current = w.threshold == null ? '' : String(w.threshold);
    const input = window.prompt('Max price (leave blank for "any price"):', current);
    if (input === null) return;
    const value = input.trim() === '' ? null : Number(input);
    if (value !== null && !Number.isFinite(value)) {
      setError('Max price must be a number.');
      return;
    }
    void run(w.id, () => setThresholdAction(w.id, value));
  }

  function editInterval(w: WatchRow): void {
    const current = w.interval_sec == null ? '' : String(w.interval_sec);
    const input = window.prompt('Poll interval in seconds:', current);
    if (input === null) return;
    const value = Number(input);
    if (!Number.isInteger(value) || value <= 0) {
      setError('Interval must be a positive whole number of seconds.');
      return;
    }
    void run(w.id, () => setIntervalAction(w.id, value));
  }

  function remove(w: WatchRow): void {
    const label = w.display_name ?? w.product_id;
    if (!window.confirm(`Stop watching “${label}”? This removes it permanently.`)) return;
    void run(w.id, () => removeItemAction(w.id));
  }

  const btn =
    'rounded border border-edge px-2 py-1 text-xs text-zinc-300 hover:bg-panel disabled:opacity-40';

  return (
    <div>
      {error && (
        <div className="mb-3 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-300">
          {error}
        </div>
      )}
      <div className="overflow-x-auto rounded-lg border border-edge">
        <table className="w-full text-sm">
          <thead className="bg-panel text-left text-xs uppercase tracking-wide text-zinc-500">
            <tr>
              <th className="px-4 py-2">Item</th>
              <th className="px-4 py-2">Retailer</th>
              <th className="px-4 py-2">Status</th>
              <th className="px-4 py-2">Price</th>
              <th className="px-4 py-2">Threshold</th>
              <th className="px-4 py-2">Checked</th>
              <th className="px-4 py-2 text-right">Manage</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-edge">
            {watches.length === 0 && (
              <tr>
                <td className="px-4 py-6 text-center text-zinc-600" colSpan={7}>
                  No watches yet — add one above.
                </td>
              </tr>
            )}
            {watches.map((w) => {
              const busy = busyId === w.id;
              return (
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
                  <td className="px-4 py-2">
                    <div className="flex flex-wrap justify-end gap-1">
                      <button
                        className={btn}
                        disabled={!enabled || busy}
                        onClick={() => run(w.id, () => setEnabledAction(w.id, !w.enabled))}
                      >
                        {w.enabled ? 'Pause' : 'Resume'}
                      </button>
                      <button className={btn} disabled={!enabled || busy} onClick={() => editThreshold(w)}>
                        Threshold
                      </button>
                      <button className={btn} disabled={!enabled || busy} onClick={() => editInterval(w)}>
                        Interval
                      </button>
                      <button
                        className="rounded border border-red-500/30 px-2 py-1 text-xs text-red-300 hover:bg-red-500/10 disabled:opacity-40"
                        disabled={!enabled || busy}
                        onClick={() => remove(w)}
                      >
                        Remove
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
