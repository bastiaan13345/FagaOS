/**
 * Capability + feature flag tests.
 */
import { describe, it, expect } from 'vitest';
import {
  CapabilitySchema,
  CapabilityTokenSchema,
  hasProviderWideCapability,
  tokenAuthorizes,
  featureFlagsFromEnv,
  FeatureFlagRegistry,
} from '../src/index.js';

const validToken = CapabilityTokenSchema.parse({
  subject: 'agent:test',
  capabilities: [
    { provider: 'gmail', operation: 'mail.list', account_id: null },
    { provider: 'gmail', operation: 'mail.get', account_id: 'a1' },
  ],
  expires_at: new Date(Date.now() + 60_000).toISOString(),
});

describe('CapabilitySchema', () => {
  it('defaults account_id to null', () => {
    const c = CapabilitySchema.parse({ provider: 'gmail', operation: 'mail.list' });
    expect(c.account_id).toBeNull();
  });
});

describe('tokenAuthorizes', () => {
  it('admits a wildcard capability', () => {
    expect(
      tokenAuthorizes(validToken, { provider: 'gmail', operation: 'mail.list', account_id: 'a1' }),
    ).toBe(true);
  });

  it('admits a specific-account capability', () => {
    expect(
      tokenAuthorizes(validToken, { provider: 'gmail', operation: 'mail.get', account_id: 'a1' }),
    ).toBe(true);
  });

  it('rejects a different account on a specific capability', () => {
    expect(
      tokenAuthorizes(validToken, { provider: 'gmail', operation: 'mail.get', account_id: 'a2' }),
    ).toBe(false);
  });

  it('rejects an operation the token does not cover', () => {
    expect(
      tokenAuthorizes(validToken, { provider: 'gmail', operation: 'mail.send', account_id: 'a1' }),
    ).toBe(false);
  });

  it('rejects an expired token', () => {
    const expired = CapabilityTokenSchema.parse({
      subject: 'agent:test',
      capabilities: [{ provider: 'gmail', operation: 'mail.list', account_id: null }],
      expires_at: new Date(Date.now() - 1000).toISOString(),
    });
    expect(
      tokenAuthorizes(expired, { provider: 'gmail', operation: 'mail.list', account_id: 'a1' }),
    ).toBe(false);
  });
});

describe('hasProviderWideCapability', () => {
  it('returns true iff a wildcard capability exists', () => {
    expect(hasProviderWideCapability(validToken, 'gmail')).toBe(true);
    expect(hasProviderWideCapability(validToken, 'outlook')).toBe(false);
  });
});

describe('featureFlagsFromEnv', () => {
  it('enables flags on truthy env values', () => {
    const flags = featureFlagsFromEnv({
      FAGAOS_FEATURE_GMAIL: '1',
      FAGAOS_FEATURE_GOOGLE_CALENDAR: 'true',
      FAGAOS_FEATURE_STUB_EMAIL: 'no',
    } as NodeJS.ProcessEnv);
    expect(flags.gmail).toBe(true);
    expect(flags.google_calendar).toBe(true);
    expect(flags.stub_email).toBe(false);
    expect(flags.stub_calendar).toBe(true);
  });

  it('defaults real flags off, stubs on', () => {
    const flags = featureFlagsFromEnv({} as NodeJS.ProcessEnv);
    expect(flags.gmail).toBe(false);
    expect(flags.google_calendar).toBe(false);
    expect(flags.stub_email).toBe(true);
    expect(flags.stub_calendar).toBe(true);
  });
});

describe('FeatureFlagRegistry', () => {
  it('reads flags from the supplied object', () => {
    const r = new FeatureFlagRegistry({ gmail: true, google_calendar: false, stub_email: true, stub_calendar: true });
    expect(r.isEnabled('gmail')).toBe(true);
    expect(r.isEnabled('google_calendar')).toBe(false);
  });

  it('snapshot returns a defensive copy', () => {
    const r = new FeatureFlagRegistry({ gmail: false, google_calendar: false, stub_email: true, stub_calendar: true });
    const s = r.snapshot();
    s.gmail = true;
    expect(r.isEnabled('gmail')).toBe(false);
  });
});
