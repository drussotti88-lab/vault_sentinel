'use client';

import { useMemo, useState } from 'react';
import { StatusBadge } from './badges';
import {
  removeItemAction,
  setEnabledAction,
  setThresholdAction,
  setIntervalAction,
  bulkSetEnabledAction,
  bulkRemoveAction,
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
  const [bulkBusy, setBulkBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [retailerFilter, setRetailerFilter] = useState<string>(''); // '' = all
  const [keyword, setKeyword] = useState('');

  const retailerName = (id: string): string => retailers.find((r) => r.id === id)?.name ?? '—';

  // Filter (by site + keyword) and group (sort) by retailer so sites cluster.
  const visible = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    return watches
      .filter((w) => (retailerFilter ? w.retailer_id === retailerFilter : true))
      .filter((w) => {
        if (!kw) return true;
        const hay = `${w.display_name ?? ''} ${w.product_id} ${w.source_url}`.toLowerCase();
        return hay.includes(kw);
      })
      .sort((a, b) => {
        const r = retailerName(a.retailer_id).localeCompare(retailerName(b.retailer_id));
        return r !== 0 ? r : (a.display_name ?? a.product_id).localeCompare(b.display_name ?? b.product_id);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watches, retailerFilter, keyword, retailers]);

  const visibleIds = visible.map((w) => w.id);
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));

  function toggleOne(id: string): void {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function toggleAllVisible(): void {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) visibleIds.forEach((id) => next.delete(id));
      else visibleIds.forEach((id) => next.add(id));
      return next;
    });
  }

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

  async function runBulk(fn: (ids: string[]) => Promise<ActionResult>): Promise<void> {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    setError(null);
    setBulkBusy(true);
    try {
      const res = await fn(ids);
      if (!res.ok) setError(res.error ?? 'Bulk action failed.');
      else setSelected(new Set());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBulkBusy(false);
    }
  }

  function editThreshold(w: WatchRow): void {
    const input = window.prompt('Max price (leave blank for "any price"):', w.threshold == null ? '' : String(w.threshold));
    if (input === null) return;
    const value = input.trim() === '' ? null : Number(input);
    if (value !== null && !Number.isFinite(value)) return setError('Max price must be a number.');
    void run(w.id, () => setThresholdAction(w.id, value));
  }
  function editInterval(w: WatchRow): void {
    const input = window.prompt('Poll interval in seconds:', w.interval_sec == null ? '' : String(w.interval_sec));
    if (input === null) return;
    const value = Number(input);
    if (!Number.isInteger(value) || value <= 0) return setError('Interval must be a positive whole number of seconds.');
    void run(w.id, () => setIntervalAction(w.id, value));
  }
  function removeOne(w: WatchRow): void {
    if (!window.confirm(`Stop watching “${w.display_name ?? w.product_id}”? This removes it permanently.`)) return;
    void run(w.id, () => removeItemAction(w.id));
  }
  function removeBulk(): void {
    if (!window.confirm(`Remove ${selected.size} selected item${selected.size === 1 ? '' : 's'} permanently?`)) return;
    void runBulk((ids) => bulkRemoveAction(ids));
  }

  const btn = 'rounded border border-edge px-2 py-1 text-xs text-zinc-300 hover:bg-panel disabled:opacity-40';
  const field = 'rounded-lg border border-edge bg-panel px-3 py-1.5 text-sm text-white outline-none focus:border-zinc-500';

  return (
    <div>
      {error && (
        <div className="mb-3 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-300">{error}</div>
      )}

      {/* Filter / group toolbar */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <select
          value={retailerFilter}
          onChange={(e) => setRetailerFilter(e.target.value)}
          className={field}
          aria-label="Filter by site"
        >
          <option value="">All sites</option>
          {retailers.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
        <input
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          placeholder="Filter by keyword (e.g. tcg, booster)"
          className={`${field} min-w-[14rem] flex-1`}
          aria-label="Filter by keyword"
        />
        <span className="text-xs text-zinc-500">
          {visible.length} of {watches.length}
        </span>
      </div>

      {/* Bulk action bar */}
      {selected.size > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-edge bg-panel/60 px-3 py-2 text-sm">
          <span className="text-zinc-300">{selected.size} selected</span>
          <button className={btn} disabled={!enabled || bulkBusy} onClick={() => runBulk((ids) => bulkSetEnabledAction(ids, false))}>
            Pause
          </button>
          <button className={btn} disabled={!enabled || bulkBusy} onClick={() => runBulk((ids) => bulkSetEnabledAction(ids, true))}>
            Resume
          </button>
          <button
            className="rounded border border-red-500/30 px-2 py-1 text-xs text-red-300 hover:bg-red-500/10 disabled:opacity-40"
            disabled={!enabled || bulkBusy}
            onClick={removeBulk}
          >
            Remove
          </button>
          <button className="text-xs text-zinc-500 hover:text-zinc-300" onClick={() => setSelected(new Set())}>
            Clear
          </button>
        </div>
      )}

      <div className="overflow-x-auto rounded-lg border border-edge">
        <table className="w-full text-sm">
          <thead className="bg-panel text-left text-xs uppercase tracking-wide text-zinc-500">
            <tr>
              <th className="px-3 py-2">
                <input
                  type="checkbox"
                  checked={allVisibleSelected}
                  onChange={toggleAllVisible}
                  aria-label="Select all"
                />
              </th>
              <th className="px-4 py-2">Item</th>
              <th className="px-4 py-2">Site</th>
              <th className="px-4 py-2">Status</th>
              <th className="px-4 py-2">Price</th>
              <th className="px-4 py-2">Threshold</th>
              <th className="px-4 py-2">Checked</th>
              <th className="px-4 py-2 text-right">Manage</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-edge">
            {visible.length === 0 && (
              <tr>
                <td className="px-4 py-6 text-center text-zinc-600" colSpan={8}>
                  {watches.length === 0 ? 'No watches yet — add one above.' : 'No matches for this filter.'}
                </td>
              </tr>
            )}
            {visible.map((w) => {
              const busy = busyId === w.id;
              return (
                <tr key={w.id} className={w.enabled ? '' : 'opacity-50'}>
                  <td className="px-3 py-2">
                    <input
                      type="checkbox"
                      checked={selected.has(w.id)}
                      onChange={() => toggleOne(w.id)}
                      aria-label={`Select ${w.display_name ?? w.product_id}`}
                    />
                  </td>
                  <td className="px-4 py-2">
                    <a href={w.source_url} target="_blank" rel="noreferrer" className="text-zinc-200 hover:text-white hover:underline">
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
                      <button className={btn} disabled={!enabled || busy} onClick={() => run(w.id, () => setEnabledAction(w.id, !w.enabled))}>
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
                        onClick={() => removeOne(w)}
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
