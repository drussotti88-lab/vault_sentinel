/**
 * Per-adapter circuit breaker (PRD §16, §18). After N consecutive failures the
 * breaker trips (open) and that adapter's polling pauses for a cooldown; it then
 * half-opens to test recovery. A tripped breaker posts to #ops and pauses
 * polling temporarily rather than hammering a struggling source.
 */
export type BreakerState = 'closed' | 'open' | 'half_open';

export interface CircuitBreakerOptions {
  failureThreshold?: number; // consecutive failures to trip
  cooldownMs?: number; // how long to stay open before half-open
}

export class CircuitBreaker {
  private state: BreakerState = 'closed';
  private consecutiveFailures = 0;
  private openedAt = 0;
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;

  constructor(opts: CircuitBreakerOptions = {}) {
    this.failureThreshold = opts.failureThreshold ?? 5;
    this.cooldownMs = opts.cooldownMs ?? 60_000;
  }

  /** Whether a call is currently permitted. Transitions open -> half_open. */
  canRequest(now = Date.now()): boolean {
    if (this.state === 'open') {
      if (now - this.openedAt >= this.cooldownMs) {
        this.state = 'half_open';
        return true; // allow a single probe
      }
      return false;
    }
    return true;
  }

  /** Returns true if this success closed a previously-open breaker. */
  recordSuccess(): boolean {
    this.consecutiveFailures = 0;
    if (this.state !== 'closed') {
      this.state = 'closed';
      return true;
    }
    return false;
  }

  /** Returns true if this failure tripped the breaker (closed/half -> open). */
  recordFailure(now = Date.now()): boolean {
    this.consecutiveFailures++;
    if (this.state === 'half_open') {
      this.trip(now);
      return true;
    }
    if (this.consecutiveFailures >= this.failureThreshold && this.state === 'closed') {
      this.trip(now);
      return true;
    }
    return false;
  }

  private trip(now: number): void {
    this.state = 'open';
    this.openedAt = now;
  }

  get current(): BreakerState {
    return this.state;
  }
}
