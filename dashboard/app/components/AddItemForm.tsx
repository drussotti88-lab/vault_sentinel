'use client';

import { useState, type FormEvent } from 'react';
import { addItemAction } from '../actions';

interface RetailerOption {
  id: string;
  name: string;
}

export function AddItemForm({
  retailers,
  enabled,
}: {
  retailers: RetailerOption[];
  enabled: boolean;
}) {
  const [retailer, setRetailer] = useState(retailers[0]?.name ?? '');
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const [threshold, setThreshold] = useState('');
  const [intervalSec, setIntervalSec] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const disabled = !enabled || retailers.length === 0;

  async function onSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setOk(null);
    const res = await addItemAction({
      retailer,
      url: url.trim(),
      name: name.trim() || null,
      threshold: threshold.trim() ? Number(threshold) : null,
      interval: intervalSec.trim() ? Number(intervalSec) : null,
    });
    if (res.ok) {
      setOk(res.message ?? 'Added.');
      setUrl('');
      setName('');
      setThreshold('');
      setIntervalSec('');
    } else {
      setError(res.error ?? 'Could not add item.');
    }
    setBusy(false);
  }

  const field = 'w-full rounded-lg border border-edge bg-panel px-3 py-2 text-sm text-white outline-none focus:border-zinc-500 disabled:opacity-50';

  return (
    <form onSubmit={onSubmit} className="rounded-lg border border-edge bg-panel/40 p-4">
      {retailers.length === 0 ? (
        <p className="text-sm text-zinc-400">
          Add a retailer in Discord first (<code>/add-retailer</code>), then you can add items here.
        </p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-xs uppercase tracking-wide text-zinc-500">
            Retailer
            <select
              value={retailer}
              onChange={(e) => setRetailer(e.target.value)}
              disabled={disabled}
              className={`mt-1 ${field}`}
            >
              {retailers.map((r) => (
                <option key={r.id} value={r.name}>
                  {r.name}
                </option>
              ))}
            </select>
          </label>

          <label className="text-xs uppercase tracking-wide text-zinc-500">
            Product or search URL
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              disabled={disabled}
              placeholder="https://…"
              className={`mt-1 ${field}`}
            />
          </label>

          <label className="text-xs uppercase tracking-wide text-zinc-500">
            Max price (optional)
            <input
              value={threshold}
              onChange={(e) => setThreshold(e.target.value)}
              disabled={disabled}
              inputMode="decimal"
              placeholder="any price"
              className={`mt-1 ${field}`}
            />
          </label>

          <label className="text-xs uppercase tracking-wide text-zinc-500">
            Display name (optional)
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={disabled}
              placeholder="auto-detected"
              className={`mt-1 ${field}`}
            />
          </label>

          <label className="text-xs uppercase tracking-wide text-zinc-500">
            Poll interval seconds (optional)
            <input
              value={intervalSec}
              onChange={(e) => setIntervalSec(e.target.value)}
              disabled={disabled}
              inputMode="numeric"
              placeholder="default"
              className={`mt-1 ${field}`}
            />
          </label>

          <div className="flex items-end">
            <button
              type="submit"
              disabled={disabled || busy}
              className="w-full rounded-lg bg-emerald-600 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
            >
              {busy ? 'Adding…' : 'Add item'}
            </button>
          </div>
        </div>
      )}

      {!enabled && retailers.length > 0 && (
        <p className="mt-3 text-sm text-amber-400">
          Controls are disabled until <code>CONTROL_API_URL</code> and{' '}
          <code>CONTROL_API_TOKEN</code> are set in Vercel.
        </p>
      )}
      {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
      {ok && <p className="mt-3 text-sm text-emerald-400">{ok}</p>}
    </form>
  );
}
