/**
 * Per-provider rate-limit policy tests.
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_RATE_LIMIT_POLICIES,
  rateLimitCost,
  resolveRateLimitPolicy,
} from '../src/store/rate-limit-policy.js';

describe('rate-limit policy resolution', () => {
  it('returns the default policy for every known provider', () => {
    const providers = Object.keys(DEFAULT_RATE_LIMIT_POLICIES) as Array<keyof typeof DEFAULT_RATE_LIMIT_POLICIES>;
    for (const provider of providers) {
      const policy = resolveRateLimitPolicy(provider);
      expect(policy.maxUnits).toBeGreaterThan(0);
      expect(policy.windowMs).toBeGreaterThan(0);
    }
  });

  it('honours an override', () => {
    const policy = resolveRateLimitPolicy('gmail', { gmail: { maxUnits: 1, windowMs: 1000 } });
    expect(policy.maxUnits).toBe(1);
    expect(policy.windowMs).toBe(1000);
  });

  it('applies a per-operation cost when present', () => {
    const policy = DEFAULT_RATE_LIMIT_POLICIES.gmail;
    expect(rateLimitCost(policy, 'mail.list')).toBe(1);
    expect(rateLimitCost(policy, 'mail.send')).toBe(5);
  });

  it('falls back to a 1-unit cost when the operation is not weighted', () => {
    const policy = DEFAULT_RATE_LIMIT_POLICIES.outlook;
    expect(rateLimitCost(policy, 'mail.list')).toBe(1);
    expect(rateLimitCost(policy, 'mail.send')).toBe(5);
  });
});
