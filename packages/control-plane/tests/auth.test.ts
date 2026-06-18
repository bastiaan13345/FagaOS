import { describe, it, expect, beforeEach } from 'vitest';
import { authenticate, authorize, hasRole, type AuthConfig, type CallerIdentity } from '../src/auth.js';

const adminIdentity: CallerIdentity = { id: 'user:admin', type: 'user', role: 'admin' };
const readerIdentity: CallerIdentity = { id: 'user:readonly', type: 'user', role: 'reader' };
const agentIdentity: CallerIdentity = { id: 'agent:worker', type: 'agent', role: 'invoker' };

function makeConfig(): AuthConfig {
  return {
    tokens: new Map([
      ['tok-admin',  adminIdentity],
      ['tok-reader', readerIdentity],
      ['tok-agent',  agentIdentity],
    ]),
  };
}

describe('authenticate', () => {
  let cfg: AuthConfig;
  beforeEach(() => { cfg = makeConfig(); });

  it('returns ok for a valid Bearer token', () => {
    const r = authenticate('Bearer tok-admin', cfg);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.caller.id).toBe('user:admin');
  });

  it('returns 401 when Authorization header is missing', () => {
    const r = authenticate(undefined, cfg);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(401);
  });

  it('returns 401 for non-Bearer scheme', () => {
    const r = authenticate('Basic dXNlcjpwYXNz', cfg);
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.status).toBe(401); expect(r.code).toBe('invalid_scheme'); }
  });

  it('returns 401 for an unknown token', () => {
    const r = authenticate('Bearer tok-unknown', cfg);
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.status).toBe(401); expect(r.code).toBe('invalid_token'); }
  });
});

describe('authorize', () => {
  it('allows a caller with sufficient role', () => {
    const r = authorize(adminIdentity, 'reader');
    expect(r.ok).toBe(true);
  });

  it('denies a caller with insufficient role', () => {
    const r = authorize(readerIdentity, 'admin');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(403);
  });

  it('allows exact role match', () => {
    const r = authorize(agentIdentity, 'invoker');
    expect(r.ok).toBe(true);
  });
});

describe('hasRole', () => {
  it('reader < invoker < admin < system', () => {
    const sys: CallerIdentity = { id: 's', type: 'system', role: 'system' };
    expect(hasRole(sys, 'admin')).toBe(true);
    expect(hasRole(adminIdentity, 'system')).toBe(false);
    expect(hasRole(readerIdentity, 'invoker')).toBe(false);
    expect(hasRole(agentIdentity, 'reader')).toBe(true);
  });
});
