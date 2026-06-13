/**
 * Per-account rate-limit budget.
 *
 * Each (account, provider) pair owns a sliding window of `maxUnits` over
 * `windowMs` milliseconds. The window is implemented as a deque of
 * timestamps; a new call is admitted iff at least
 * `maxUnits * windowMs / (admit_every)` milliseconds have passed since
 * the oldest in-window call, or the window is not yet full.
 *
 * The `consume` method is non-blocking: when the budget is exhausted
 * the caller is told how long to wait (in ms) and may decide to retry.
 * The gateway respects the supplied value and re-attempts with the
 * connector's `Retry-After`-style hint.
 *
 * The values default to the Gmail "users.messages.list"-shaped budget
 * from FAG-5 §3.1, which is the most common connector in Phase 1.
 * Other providers should construct with a smaller budget where
 * appropriate.
 */
export interface RateLimitBudgetOptions {
  /** Maximum units the budget can hold. */
  maxUnits: number;
  /** Window length in milliseconds. */
  windowMs: number;
  /** Optional clock for tests. */
  clock?: () => number;
}

export interface RateLimitDecision {
  /** True iff the call is admitted. */
  allowed: boolean;
  /** If denied, milliseconds the caller should wait before retrying. */
  retry_after_ms: number;
  /** Units remaining in the window after this call (0 when denied). */
  remaining: number;
}

export class RateLimitBudget {
  private readonly maxUnits: number;
  private readonly windowMs: number;
  private readonly clock: () => number;
  private readonly timestamps: number[] = [];

  constructor(options: RateLimitBudgetOptions) {
    if (options.maxUnits <= 0) {
      throw new Error(`RateLimitBudget.maxUnits must be > 0 (got ${options.maxUnits})`);
    }
    if (options.windowMs <= 0) {
      throw new Error(`RateLimitBudget.windowMs must be > 0 (got ${options.windowMs})`);
    }
    this.maxUnits = options.maxUnits;
    this.windowMs = options.windowMs;
    this.clock = options.clock ?? (() => Date.now());
  }

  /**
   * Try to admit one unit. When admitted the timestamp is recorded.
   * When denied nothing is recorded; the caller is told the smallest
   * `windowMs` delay that would unblock it.
   */
  consume(units: number = 1): RateLimitDecision {
    if (units <= 0) {
      throw new Error(`RateLimitBudget.consume requires positive units (got ${units})`);
    }
    const now = this.clock();
    this.dropExpired(now);
    if (this.timestamps.length + units <= this.maxUnits) {
      for (let i = 0; i < units; i++) this.timestamps.push(now);
      return {
        allowed: true,
        retry_after_ms: 0,
        remaining: this.maxUnits - this.timestamps.length,
      };
    }
    // Denied. The retry delay is the time until the oldest in-window
    // timestamp falls out, which is the soonest we can admit `units`
    // new ones.
    const oldest = this.timestamps[0]!;
    const retry_after_ms = Math.max(0, oldest + this.windowMs - now);
    return {
      allowed: false,
      retry_after_ms,
      remaining: 0,
    };
  }

  /** Inspect the current state without consuming. */
  inspect(): { used: number; remaining: number; oldest_age_ms: number | null } {
    const now = this.clock();
    this.dropExpired(now);
    const oldest = this.timestamps[0];
    return {
      used: this.timestamps.length,
      remaining: this.maxUnits - this.timestamps.length,
      oldest_age_ms: oldest === undefined ? null : now - oldest,
    };
  }

  private dropExpired(now: number): void {
    const cutoff = now - this.windowMs;
    // The array is sorted ascending by insertion time. Drop the
    // prefix that is older than the window.
    let i = 0;
    while (i < this.timestamps.length && this.timestamps[i]! <= cutoff) i++;
    if (i > 0) this.timestamps.splice(0, i);
  }
}
