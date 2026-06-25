import type { AvailabilityStatus } from "../types";

const LABELS: Record<AvailabilityStatus, string> = {
  in_stock: "In stock",
  out_of_stock: "Out of stock",
  unknown: "Unknown",
};

export function StatusBadge({ status }: { status: AvailabilityStatus }) {
  return <span className={`badge badge--${status}`}>{LABELS[status]}</span>;
}
