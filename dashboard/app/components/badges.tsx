/** Small presentational badges shared across the dashboard. */

export function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    in: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
    out: 'bg-zinc-500/15 text-zinc-400 border-zinc-500/30',
    queue: 'bg-sky-500/15 text-sky-300 border-sky-500/30',
    unknown: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
  };
  const cls = map[status] ?? map.unknown;
  return (
    <span className={`inline-block rounded border px-2 py-0.5 text-xs font-medium ${cls}`}>
      {status}
    </span>
  );
}

export function ConfidenceBadge({ confidence }: { confidence: string | null }) {
  if (!confidence) return <span className="text-zinc-500">—</span>;
  const label: Record<string, string> = {
    exact: 'Exact',
    inferred: 'Inferred',
    queue_gated: 'Queue-gated',
    unknown: 'Unknown',
  };
  return (
    <span className="inline-block rounded border border-edge bg-panel px-2 py-0.5 text-xs text-zinc-300">
      {label[confidence] ?? confidence}
    </span>
  );
}
