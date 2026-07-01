/**
 * Google production-OAuth helper tests.
 *
 * The Phase 1 PKCE flow in `google.ts` covers local dev. This module
 * covers the production deployment of FagaOS, where:
 *   - The OAuth client is a "Web application" client with a real client secret.
 *   - The connector uses an *offline* access type so the user is prompted
 *     to grant a refresh token on first link.
 *   - Scopes are per-operation; the bundle below is the single source of
 *     truth for what each connector is allowed to request at link time.
 *
 * Reference:
 *   https://developers.google.com/identity/protocols/oauth2/web-server
 *   https://developers.google.com/workspace/calendar/api/guides/auth
 */
import { describe, it, expect } from 'vitest';
import {
  GOOGLE_PRODUCTION_SCOPES,
  productionAuthorizationUrl,
  productionScopesFor,
} from '../src/oauth/google_production_oauth.js';
import { generatePkce } from '../src/oauth/pkce.js';

describe('GOOGLE_PRODUCTION_SCOPES', () => {
  it('exposes the gmail scope bundle with offline-friendly openid/email/profile claims', () => {
    const scopes = GOOGLE_PRODUCTION_SCOPES.gmail;
    expect(scopes).toContain('https://www.googleapis.com/auth/gmail.readonly');
    expect(scopes).toContain('https://www.googleapis.com/auth/gmail.send');
    expect(scopes).toContain('https://www.googleapis.com/auth/gmail.modify');
    expect(scopes).toContain('openid');
    expect(scopes).toContain('email');
    expect(scopes).toContain('profile');
  });

  it('exposes the google_calendar scope bundle covering list, events, and owned writes', () => {
    const scopes = GOOGLE_PRODUCTION_SCOPES.google_calendar;
    expect(scopes).toContain('https://www.googleapis.com/auth/calendar.calendarlist.readonly');
    expect(scopes).toContain('https://www.googleapis.com/auth/calendar.events.readonly');
    expect(scopes).toContain('https://www.googleapis.com/auth/calendar.events.owned');
    expect(scopes).toContain('openid');
    expect(scopes).toContain('email');
    expect(scopes).toContain('profile');
  });
});

describe('productionScopesFor', () => {
  it('returns the gmail bundle for the gmail provider', () => {
    expect(productionScopesFor('gmail')).toBe(GOOGLE_PRODUCTION_SCOPES.gmail);
  });

  it('returns the google_calendar bundle for the google_calendar provider', () => {
    expect(productionScopesFor('google_calendar')).toBe(GOOGLE_PRODUCTION_SCOPES.google_calendar);
  });

  it('returns an empty array for non-Google providers', () => {
    expect(productionScopesFor('outlook')).toEqual([]);
    expect(productionScopesFor('whatsapp')).toEqual([]);
    expect(productionScopesFor('telegram')).toEqual([]);
  });
});

describe('productionAuthorizationUrl', () => {
  it('builds a Google consent URL targeting accounts.google.com with PKCE', () => {
    const url = productionAuthorizationUrl({
      provider: 'gmail',
      client_id: 'cid',
      redirect_uri: 'https://app.example.com/cb',
      state: 'csrf-nonce',
      pkce: generatePkce(),
    });
    const parsed = new URL(url);
    expect(parsed.origin).toBe('https://accounts.google.com');
    expect(parsed.pathname).toBe('/o/oauth2/v2/auth');
    expect(parsed.searchParams.get('client_id')).toBe('cid');
    expect(parsed.searchParams.get('redirect_uri')).toBe('https://app.example.com/cb');
    expect(parsed.searchParams.get('state')).toBe('csrf-nonce');
    expect(parsed.searchParams.get('code_challenge_method')).toBe('S256');
    expect(parsed.searchParams.get('access_type')).toBe('offline');
    expect(parsed.searchParams.get('prompt')).toBe('consent');
    expect(parsed.searchParams.get('include_granted_scopes')).toBe('true');
  });

  it('uses google_calendar scopes when the calendar provider is requested', () => {
    const url = productionAuthorizationUrl({
      provider: 'google_calendar',
      client_id: 'cid',
      redirect_uri: 'https://app.example.com/cb',
      state: 'csrf-nonce',
      pkce: generatePkce(),
    });
    const parsed = new URL(url);
    const requested = (parsed.searchParams.get('scope') ?? '').split(' ');
    expect(requested).toContain('https://www.googleapis.com/auth/calendar.events.owned');
    expect(requested).toContain('https://www.googleapis.com/auth/calendar.calendarlist.readonly');
  });

  it('honours a custom access_type and prompt override', () => {
    const url = productionAuthorizationUrl({
      provider: 'gmail',
      client_id: 'cid',
      redirect_uri: 'https://app.example.com/cb',
      state: 'csrf-nonce',
      pkce: generatePkce(),
      access_type: 'online',
      prompt: 'select_account',
    });
    const parsed = new URL(url);
    expect(parsed.searchParams.get('access_type')).toBe('online');
    expect(parsed.searchParams.get('prompt')).toBe('select_account');
  });

  it('honours caller-supplied scopes when provided', () => {
    const url = productionAuthorizationUrl({
      provider: 'gmail',
      client_id: 'cid',
      redirect_uri: 'https://app.example.com/cb',
      state: 'csrf-nonce',
      pkce: generatePkce(),
      scopes: ['openid', 'email'],
    });
    const parsed = new URL(url);
    const requested = (parsed.searchParams.get('scope') ?? '').split(' ');
    expect(requested).toEqual(['openid', 'email']);
  });

  it('omits the empty extra params when the caller overrides access_type/prompt to defaults', () => {
    const url = productionAuthorizationUrl({
      provider: 'gmail',
      client_id: 'cid',
      redirect_uri: 'https://app.example.com/cb',
      state: 'csrf-nonce',
      pkce: generatePkce(),
      access_type: 'offline',
      prompt: 'consent',
    });
    const parsed = new URL(url);
    expect(parsed.searchParams.get('access_type')).toBe('offline');
    expect(parsed.searchParams.get('prompt')).toBe('consent');
  });
});
