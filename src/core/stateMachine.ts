import type { CheckResult } from '../adapters/types.js';
import type { Watch, StockStatus } from '../db/types.js';

/**
 * Stock-status state machine (PRD §13, §17). Alert on *transitions*, not states.
 *
 *   Alert fires only on  OUT/UNKNOWN -> IN  while  price <= threshold  and the
 *   cooldown has elapsed. Rapid IN/OUT within cooldown (flapping) updates state
 *   silently. QUEUE is its own state for queue-aware adapters, with its own
 *   one-shot alert.
 *
 * Dedup (PRD §14): an alert for a given watch is suppressed if
 *   now - last_alerted < cooldown, UNLESS the price dropped further below
 *   the threshold since the last alert.
 */

export type AlertKind = 'restock' | 'queue';

export interface Decision {
  /** The status to persist for this watch. */
  newStatus: StockStatus;
  /** Whether to emit an alert this cycle. */
  shouldAlert: boolean;
  /** Which kind of alert, when shouldAlert is true. */
  alertKind?: AlertKind;
  /** Human-readable reason (for logs/ops). */
  reason: string;
}

export interface DecideInput {
  watch: Watch;
  result: CheckResult;
  /** Cooldown window in seconds. */
  cooldownSec: number;
  /** Defaults to Date.now(); injectable for tests. */
  now?: number;
}

function statusOf(result: CheckResult): StockStatus {
  if (result.error) return 'unknown';
  if (result.queue?.active) return 'queue';
  return result.inStock ? 'in' : 'out';
}

function meetsThreshold(watch: Watch, result: CheckResult): boolean {
  if (watch.threshold === null || watch.threshold === undefined) return true; // any price
  if (result.price === null) return true; // price unknown -> don't block the alert
  return result.price <= watch.threshold;
}

function cooldownElapsed(watch: Watch, now: number, cooldownSec: number): boolean {
  if (!watch.last_alerted) return true;
  return now - new Date(watch.last_alerted).getTime() >= cooldownSec * 1000;
}

/** Did the price drop further below threshold since the last seen price? */
function priceDroppedFurther(watch: Watch, result: CheckResult): boolean {
  if (result.price === null || watch.last_price === null) return false;
  return result.price < watch.last_price;
}

export function decide(input: DecideInput): Decision {
  const { watch, result, cooldownSec } = input;
  const now = input.now ?? Date.now();
  const newStatus = statusOf(result);
  const prev = watch.last_status;

  // --- Errors: never alert, hold last known status so we don't churn state. ---
  if (result.error) {
    return { newStatus: prev, shouldAlert: false, reason: `error: ${result.error.code}` };
  }

  // --- Queue-aware: queue going active is a one-shot situational alert. ---
  if (newStatus === 'queue') {
    if (prev === 'queue') {
      return { newStatus, shouldAlert: false, reason: 'queue already active' };
    }
    return { newStatus, shouldAlert: true, alertKind: 'queue', reason: 'queue went active' };
  }

  // --- Restock transition: OUT/UNKNOWN/QUEUE -> IN. ---
  if (newStatus === 'in') {
    const wasOut = prev !== 'in';
    const passesThreshold = meetsThreshold(watch, result);

    if (!passesThreshold) {
      return { newStatus, shouldAlert: false, reason: 'in stock but above threshold' };
    }

    const cooled = cooldownElapsed(watch, now, cooldownSec);
    const droppedFurther = priceDroppedFurther(watch, result);

    if (wasOut && (cooled || droppedFurther)) {
      return {
        newStatus,
        shouldAlert: true,
        alertKind: 'restock',
        reason: cooled ? 'out->in transition' : 'price dropped further within cooldown',
      };
    }

    if (!wasOut && droppedFurther && cooled) {
      // Still in stock, but a fresh price drop below threshold is alert-worthy.
      return {
        newStatus,
        shouldAlert: true,
        alertKind: 'restock',
        reason: 'price dropped further below threshold',
      };
    }

    if (!wasOut) {
      return { newStatus, shouldAlert: false, reason: 'still in stock (no transition)' };
    }
    // wasOut but within cooldown and no further drop -> flapping/dedup suppression.
    return { newStatus, shouldAlert: false, reason: 'transition suppressed by cooldown' };
  }

  // --- Out / unknown: just update state silently. ---
  return { newStatus, shouldAlert: false, reason: 'out of stock' };
}
