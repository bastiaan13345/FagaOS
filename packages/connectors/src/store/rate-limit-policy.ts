/**
 * Per-provider rate-limit policies.
 *
 * Each connector has its own quota. The values below are conservative
 * defaults for development; production deployments should source these
 * from a config map (so an operator can tighten a limit when a
 * workspace is close to the provider's hard cap).
 *
 * The "units" model: the gateway counts one unit per dispatched call
 * by default, but a connector may request a multi-unit cost (e.g. a
 * Gmail `users.history.list` with a large page costs more). The
 * provider-level budget is a sliding window over the configured units.
 *
 * Source-of-truth references (consult before changing numbers):
 *   - Gmail:  https://developers.google.com/gmail/api/reference/quota
 *   - GCal:   https://developers.google.com/calendar/api/limits
 *   - Graph:  https://learn.microsoft.com/en-us/graph/throttling
 *   - Meta:   https://developers.facebook.com/docs/marketing-api/insights
 *   - TG:     https://core.telegram.org/api/env
 *   - Slack:  https://api.slack.com/docs/rate-limits
 *   - Disc:   https://discord.com/developers/docs/topics/rate-limits
 */
import type { Provider } from '../models/schemas.js';

export interface RateLimitPolicy {
  /** Maximum units in a window. */
  maxUnits: number;
  /** Window length in milliseconds. */
  windowMs: number;
  /**
   * Multipliers applied to specific connector operations. Default
   * `1`. The gateway multiplies the per-call cost by this number
   * before consuming from the budget.
   */
  weights?: Partial<Record<string, number>>;
}

/**
 * Default policies. Keys must match the `Provider` enum.
 *
 * Phase 1 ships Gmail + Google Calendar; the rest default to a
 * conservative 60/min to keep a chatty connector from running away.
 * The connector implementation can request a smaller budget at
 * construction time.
 */
export const DEFAULT_RATE_LIMIT_POLICIES: Readonly<Record<Provider, RateLimitPolicy>> = {
  gmail: { maxUnits: 250, windowMs: 60_000, weights: { 'mail.send': 5 } },
  outlook: { maxUnits: 60, windowMs: 60_000, weights: { 'mail.send': 5 } },
  imap: { maxUnits: 30, windowMs: 60_000 },
  icloud: { maxUnits: 30, windowMs: 60_000 },
  whatsapp: { maxUnits: 80, windowMs: 60_000, weights: { 'dm.send': 5 } },
  instagram: { maxUnits: 60, windowMs: 60_000, weights: { 'dm.send': 5 } },
  telegram: { maxUnits: 30, windowMs: 1_000 },
  discord: { maxUnits: 5, windowMs: 1_000 },
  slack: { maxUnits: 60, windowMs: 60_000 },
  google_calendar: { maxUnits: 250, windowMs: 60_000 },
  outlook_calendar: { maxUnits: 60, windowMs: 60_000 },
  caldav: { maxUnits: 30, windowMs: 60_000 },
};

/** Resolve a policy for a provider; falls back to a 60/min budget. */
export function resolveRateLimitPolicy(
  provider: Provider,
  overrides?: Partial<Record<Provider, RateLimitPolicy>>,
): RateLimitPolicy {
  return overrides?.[provider] ?? DEFAULT_RATE_LIMIT_POLICIES[provider];
}

/** Cost of a single call. Default 1. */
export function rateLimitCost(
  policy: RateLimitPolicy,
  operation: string,
): number {
  return policy.weights?.[operation] ?? 1;
}
