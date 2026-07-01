/**
 * Scope-explainer tests.
 *
 * FAG-32 acceptance criteria #3: surface provider scope requests in
 * human-readable terms before consent, including read/write
 * distinction and destructive-action implications.
 */
import { describe, it, expect } from 'vitest';
import {
  explainScope,
  explainScopes,
  groupByRisk,
  hasDestructiveScope,
  hasWriteScope,
} from '../src/scope-explain.js';

describe('explainScope', () => {
  it('explains a gmail readonly scope as low risk, read-only', () => {
    const out = explainScope('gmail', 'https://www.googleapis.com/auth/gmail.readonly');
    expect(out.writes).toBe(false);
    expect(out.destructive).toBe(false);
    expect(out.risk).toBe('low');
    expect(out.label).toMatch(/read/i);
  });

  it('explains a gmail send scope as high risk, writes but not destructive', () => {
    const out = explainScope('gmail', 'https://www.googleapis.com/auth/gmail.send');
    expect(out.writes).toBe(true);
    expect(out.destructive).toBe(false);
    expect(out.risk).toBe('high');
  });

  it('explains a gmail.modify scope as destructive', () => {
    const out = explainScope('gmail', 'https://www.googleapis.com/auth/gmail.modify');
    expect(out.writes).toBe(true);
    expect(out.destructive).toBe(true);
    expect(out.risk).toBe('high');
  });

  it('explains a google_calendar events.owned scope as destructive', () => {
    const out = explainScope('google_calendar', 'https://www.googleapis.com/auth/calendar.events.owned');
    expect(out.destructive).toBe(true);
  });

  it('explains an Outlook Mail.ReadWrite scope as destructive', () => {
    const out = explainScope('outlook', 'Mail.ReadWrite');
    expect(out.writes).toBe(true);
    expect(out.destructive).toBe(true);
  });

  it('flags an unknown scope on a known provider as high risk', () => {
    const out = explainScope('gmail', 'gmail.unknown.scope');
    expect(out.risk).toBe('high');
    expect(out.label).toMatch(/unrecognised/i);
  });

  it('flags an unknown scope on a provider with no catalog as high risk', () => {
    const out = explainScope('whatsapp', 'whatsapp.scope');
    expect(out.risk).toBe('high');
  });
});

describe('explainScopes', () => {
  it('preserves order and explains every scope', () => {
    const scopes = ['openid', 'https://www.googleapis.com/auth/gmail.send'];
    const out = explainScopes('gmail', scopes);
    expect(out.length).toBe(scopes.length);
    expect(out[0]?.scope).toBe('openid');
    expect(out[1]?.scope).toBe('https://www.googleapis.com/auth/gmail.send');
  });
});

describe('groupByRisk', () => {
  it('partitions explained scopes into low / medium / high buckets', () => {
    const out = groupByRisk([
      explainScope('gmail', 'openid'), // low
      explainScope('gmail', 'https://www.googleapis.com/auth/gmail.send'), // high
      explainScope('outlook', 'offline_access'), // medium
    ]);
    expect(out.low.length).toBe(1);
    expect(out.medium.length).toBe(1);
    expect(out.high.length).toBe(1);
  });
});

describe('hasWriteScope / hasDestructiveScope', () => {
  it('hasWriteScope is true when any scope writes', () => {
    expect(hasWriteScope([explainScope('gmail', 'openid'), explainScope('gmail', 'https://www.googleapis.com/auth/gmail.send')])).toBe(true);
    expect(hasWriteScope([explainScope('gmail', 'openid')])).toBe(false);
  });

  it('hasDestructiveScope is true when any scope is destructive', () => {
    expect(hasDestructiveScope([explainScope('gmail', 'https://www.googleapis.com/auth/gmail.modify')])).toBe(true);
    expect(hasDestructiveScope([explainScope('gmail', 'https://www.googleapis.com/auth/gmail.send')])).toBe(false);
  });
});
