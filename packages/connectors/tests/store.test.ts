/**
 * Store unit tests — covers the in-memory stores and the rate-limit
 * budget, which are the gateway's hot path on every call.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  InMemoryAccountStore,
  InMemoryIdempotencyStore,
  RateLimitBudget,
  ReauthTracker,
} from '../src/index.js';
import { ConnectorError } from '../src/index.js';
import { AccountSchema } from '../src/index.js';

function makeAccount(id: string, provider: 'gmail' | 'google_calendar' = 'gmail') {
  return AccountSchema.parse({
    id,
    user_id: 'u1',
    provider,
    handle: 'me@example.com',
    scopes: ['gmail.readonly'],
    capabilities: ['read_mail'],
    status: 'active',
    created_at: '2025-01-01T00:00:00.000Z',
    updated_at: '2025-01-01T00:00:00.000Z',
  });
}

describe('InMemoryAccountStore', () => {
  let store: InMemoryAccountStore;
  beforeEach(() => {
    store = new InMemoryAccountStore();
  });

  it('upserts and returns an account by id', async () => {
    const a = makeAccount('a1');
    await store.upsert(a);
    expect((await store.get('a1'))?.id).toBe('a1');
  });

  it('returns null for an unknown id', async () => {
    expect(await store.get('missing')).toBeNull();
  });

  it('filters by user and provider', async () => {
    await store.upsert(makeAccount('a1', 'gmail'));
    await store.upsert(makeAccount('a2', 'google_calendar'));
    await store.upsert(makeAccount('a3', 'gmail'));
    const u1Gmail = await store.listForUser('u1', 'gmail');
    expect(u1Gmail.map((a) => a.id).sort()).toEqual(['a1', 'a3']);
    const u1All = await store.listForUserAll('u1');
    expect(u1All.length).toBe(3);
  });

  it('updates the status field on demand', async () => {
    await store.upsert(makeAccount('a1'));
    await store.setStatus('a1', 'reauth_required');
    const a = await store.get('a1');
    expect(a?.status).toBe('reauth_required');
    expect(a?.updated_at).not.toBe('2025-01-01T00:00:00.000Z');
  });

  it('rejects setStatus on an unknown id', async () => {
    await expect(store.setStatus('missing', 'reauth_required')).rejects.toThrow();
  });
});

describe('InMemoryIdempotencyStore', () => {
  it('returns null on a fresh key', async () => {
    const s = new InMemoryIdempotencyStore();
    expect(await s.reserveOrLookup({ key: 'k1', request_hash: 'h1' })).toBeNull();
  });

  it('returns the stored record on a replay', async () => {
    const s = new InMemoryIdempotencyStore();
    await s.reserveOrLookup({ key: 'k1', request_hash: 'h1' });
    await s.commit({ key: 'k1', request_hash: 'h1', response: { id: 1 } });
    const replay = await s.reserveOrLookup({ key: 'k1', request_hash: 'h1' });
    expect(replay?.response).toEqual({ id: 1 });
  });

  it('rejects a replay with a different request_hash', async () => {
    const s = new InMemoryIdempotencyStore();
    await s.reserveOrLookup({ key: 'k1', request_hash: 'h1' });
    await s.commit({ key: 'k1', request_hash: 'h1', response: {} });
    await expect(
      s.reserveOrLookup({ key: 'k1', request_hash: 'h2' }),
    ).rejects.toBeInstanceOf(ConnectorError);
  });

  it('drops entries on sweep', async () => {
    const s = new InMemoryIdempotencyStore({ ttlMs: 100 });
    await s.reserveOrLookup({ key: 'k1', request_hash: 'h1' });
    await s.commit({ key: 'k1', request_hash: 'h1', response: {} });
    const dropped = await s.sweep(Date.now() + 1000);
    expect(dropped).toBe(1);
    expect(await s.reserveOrLookup({ key: 'k1', request_hash: 'h1' })).toBeNull();
  });
});

describe('RateLimitBudget', () => {
  it('admits up to maxUnits calls in a window', () => {
    const clock = (() => {
      let t = 0;
      return () => ++t;
    })();
    const b = new RateLimitBudget({ maxUnits: 3, windowMs: 100, clock });
    expect(b.consume().allowed).toBe(true);
    expect(b.consume().allowed).toBe(true);
    expect(b.consume().allowed).toBe(true);
    const denied = b.consume();
    expect(denied.allowed).toBe(false);
    expect(denied.retry_after_ms).toBeGreaterThan(0);
  });

  it('expires old calls after windowMs', () => {
    let t = 0;
    const b = new RateLimitBudget({ maxUnits: 1, windowMs: 100, clock: () => ++t });
    expect(b.consume().allowed).toBe(true);
    expect(b.consume().allowed).toBe(false);
    // Advance the clock past the window.
    t = 1000;
    expect(b.consume().allowed).toBe(true);
  });

  it('rejects non-positive units', () => {
    const b = new RateLimitBudget({ maxUnits: 1, windowMs: 100 });
    expect(() => b.consume(0)).toThrow();
    expect(() => b.consume(-1)).toThrow();
  });

  it('rejects non-positive maxUnits or windowMs', () => {
    expect(() => new RateLimitBudget({ maxUnits: 0, windowMs: 1 })).toThrow();
    expect(() => new RateLimitBudget({ maxUnits: 1, windowMs: 0 })).toThrow();
  });
});

describe('ReauthTracker', () => {
  it('marks, reads, clears', () => {
    const r = new ReauthTracker();
    expect(r.isRequired('a1')).toBe(false);
    r.markReauthRequired('a1', 'invalid_grant');
    expect(r.isRequired('a1')).toBe(true);
    expect(r.get('a1')?.reason).toBe('invalid_grant');
    r.clear('a1');
    expect(r.isRequired('a1')).toBe(false);
  });

  it('size reflects the number of flags', () => {
    const r = new ReauthTracker();
    r.markReauthRequired('a1', 'x');
    r.markReauthRequired('a2', 'x');
    expect(r.size()).toBe(2);
  });
});
