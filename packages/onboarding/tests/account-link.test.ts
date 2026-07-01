/**
 * Account-link lifecycle tests.
 *
 * FAG-32 acceptance criteria #2: the seven-state machine that drives
 * the connector linking flow for OAuth / app-password / bot-token
 * providers.
 */
import { describe, it, expect } from 'vitest';
import {
  AccountLinkTransitionError,
  actionableLinks,
  attentionLinks,
  isAccountLinkTerminal,
  nextStatesFor,
  transitionAccountLink,
  type AccountLink,
} from '../src/account-link.js';

const fixedNow = () => new Date('2025-01-01T00:00:00.000Z');

function makeLink(overrides: Partial<AccountLink> = {}): AccountLink {
  return {
    id: 'link-1',
    workspaceId: 'w1',
    provider: 'gmail',
    userId: 'u1',
    kind: 'oauth',
    state: 'not_connected',
    scopes: ['openid', 'email'],
    updatedAt: '2025-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('nextStatesFor', () => {
  it('not_connected can only move to linking or revoked', () => {
    expect(nextStatesFor('not_connected')).toEqual(['linking', 'revoked']);
  });
  it('linking can resolve to connected, error, or revoked', () => {
    expect(nextStatesFor('linking')).toEqual(['connected', 'error', 'revoked']);
  });
  it('connected can be reauth_required, paused, or revoked', () => {
    expect(nextStatesFor('connected')).toEqual(['reauth_required', 'paused', 'revoked']);
  });
  it('reauth_required can only re-link or be revoked', () => {
    expect(nextStatesFor('reauth_required')).toEqual(['linking', 'revoked']);
  });
  it('paused can be reactivated or revoked', () => {
    expect(nextStatesFor('paused')).toEqual(['connected', 'revoked']);
  });
  it('error can be retried or abandoned', () => {
    expect(nextStatesFor('error')).toEqual(['linking', 'not_connected', 'revoked']);
  });
  it('revoked is a terminal state', () => {
    expect(nextStatesFor('revoked')).toEqual([]);
    expect(isAccountLinkTerminal('revoked')).toBe(true);
  });
});

describe('transitionAccountLink — happy path', () => {
  it('walks not_connected -> linking -> connected', () => {
    let link = makeLink();
    link = transitionAccountLink(link, 'linking', fixedNow);
    expect(link.state).toBe('linking');
    link = transitionAccountLink(link, 'connected', fixedNow);
    expect(link.state).toBe('connected');
    expect(link.updatedAt).toBe('2025-01-01T00:00:00.000Z');
  });

  it('clears errorCode on a successful re-link', () => {
    let link = makeLink({ state: 'error', errorCode: 'oauth_timeout' });
    link = transitionAccountLink(link, 'linking', fixedNow);
    link = transitionAccountLink(link, 'connected', fixedNow);
    expect(link.errorCode).toBeUndefined();
  });
});

describe('transitionAccountLink — reauth + repair', () => {
  it('connected -> reauth_required marks the account as needing re-link', () => {
    let link = makeLink({ state: 'connected' });
    link = transitionAccountLink(link, 'reauth_required', fixedNow);
    expect(link.state).toBe('reauth_required');
  });

  it('reauth_required -> linking is the recovery path', () => {
    let link = makeLink({ state: 'reauth_required' });
    link = transitionAccountLink(link, 'linking', fixedNow);
    expect(link.state).toBe('linking');
  });

  it('paused -> connected resumes the account', () => {
    let link = makeLink({ state: 'paused' });
    link = transitionAccountLink(link, 'connected', fixedNow);
    expect(link.state).toBe('connected');
  });
});

describe('transitionAccountLink — error path', () => {
  it('linking -> error requires an errorCode', () => {
    const link = makeLink({ state: 'linking' });
    expect(() => transitionAccountLink(link, 'error', fixedNow)).toThrow(/errorCode is required/);
  });

  it('linking -> error records the errorCode', () => {
    let link = makeLink({ state: 'linking' });
    link = transitionAccountLink(link, 'error', fixedNow, { errorCode: 'invalid_grant' });
    expect(link.state).toBe('error');
    expect(link.errorCode).toBe('invalid_grant');
  });

  it('error -> linking is the retry path', () => {
    let link = makeLink({ state: 'error', errorCode: 'oauth_timeout' });
    link = transitionAccountLink(link, 'linking', fixedNow, { errorCode: undefined });
    expect(link.state).toBe('linking');
    // The errorCode is wiped on a fresh linking attempt so the
    // control plane does not display a stale error.
    expect(link.errorCode).toBeUndefined();
  });
});

describe('transitionAccountLink — revoked is terminal', () => {
  it('wipes scopes on revoke', () => {
    let link = makeLink({ state: 'connected', scopes: ['Mail.Read', 'Mail.Send'] });
    link = transitionAccountLink(link, 'revoked', fixedNow);
    expect(link.state).toBe('revoked');
    expect(link.scopes).toEqual([]);
    expect(link.errorCode).toBeUndefined();
  });

  it('refuses any transition out of revoked', () => {
    const link = makeLink({ state: 'revoked' });
    expect(() => transitionAccountLink(link, 'linking', fixedNow)).toThrow(/terminal state/);
    expect(() => transitionAccountLink(link, 'connected', fixedNow)).toThrow(/terminal state/);
  });
});

describe('transitionAccountLink — invalid transition', () => {
  it('refuses connected -> linking (no implicit re-link path)', () => {
    const link = makeLink({ state: 'connected' });
    expect(() => transitionAccountLink(link, 'linking', fixedNow)).toThrow(AccountLinkTransitionError);
  });

  it('refuses not_connected -> connected (must pass through linking)', () => {
    const link = makeLink({ state: 'not_connected' });
    expect(() => transitionAccountLink(link, 'connected', fixedNow)).toThrow(/cannot transition/);
  });
});

describe('actionableLinks / attentionLinks', () => {
  const links: AccountLink[] = [
    makeLink({ id: 'a', state: 'connected', handle: 'a@example.com' }),
    makeLink({ id: 'b', state: 'reauth_required', handle: 'b@example.com' }),
    makeLink({ id: 'c', state: 'paused', handle: 'c@example.com' }),
    makeLink({ id: 'd', state: 'revoked', handle: 'd@example.com' }),
    makeLink({ id: 'e', state: 'error', errorCode: 'invalid_grant' }),
  ];

  it('actionableLinks returns only connected links, in input order', () => {
    const out = actionableLinks(links);
    expect(out.map((l) => l.account_id)).toEqual(['a']);
    expect(out[0]?.provider).toBe('gmail');
    expect(out[0]?.handle).toBe('a@example.com');
  });

  it('attentionLinks flags reauth, paused, and error links', () => {
    const out = attentionLinks(links);
    expect(out.map((l) => l.id).sort()).toEqual(['b', 'c', 'e']);
  });
});
