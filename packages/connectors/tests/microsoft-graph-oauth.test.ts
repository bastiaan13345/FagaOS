/**
 * Microsoft Graph OAuth helper tests.
 */
import { describe, it, expect } from 'vitest';
import {
  GRAPH_PRODUCTION_SCOPES,
  graphAuthorizationUrl,
  graphExchangeAuthorizationCode,
  graphProductionScopesFor,
  graphRefreshToken,
} from '../src/oauth/microsoft_graph.js';

describe('Microsoft Graph OAuth — production scopes', () => {
  it('exposes a non-empty scope bundle for mail and calendar', () => {
    expect(GRAPH_PRODUCTION_SCOPES.outlook).toContain('Mail.Send');
    expect(GRAPH_PRODUCTION_SCOPES.outlook_calendar).toContain('Calendars.ReadWrite');
  });
  it('returns an empty array for non-Graph providers', () => {
    expect(graphProductionScopesFor('gmail')).toEqual([]);
    expect(graphProductionScopesFor('whatsapp')).toEqual([]);
  });
});

describe('graphAuthorizationUrl', () => {
  it('builds a multi-tenant URL with PKCE challenge', () => {
    const url = graphAuthorizationUrl({
      provider: 'outlook',
      client_id: 'client',
      redirect_uri: 'https://app/callback',
      state: 'csrf',
      pkce: { code_verifier: 'v', code_challenge: 'c', code_challenge_method: 'S256' },
    });
    const parsed = new URL(url);
    expect(parsed.origin).toBe('https://login.microsoftonline.com');
    expect(parsed.searchParams.get('client_id')).toBe('client');
    expect(parsed.searchParams.get('code_challenge')).toBe('c');
    expect(parsed.searchParams.get('code_challenge_method')).toBe('S256');
    expect(parsed.searchParams.get('scope')!.split(' ')).toContain('Mail.Send');
  });
});

describe('graphExchangeAuthorizationCode + graphRefreshToken', () => {
  it('parses a success response', async () => {
    const fetchMock = async (_url: string, init: RequestInit): Promise<Response> => {
      expect(init.method).toBe('POST');
      const body = new URLSearchParams(init.body as string);
      expect(body.get('grant_type')).toBe('authorization_code');
      expect(body.get('code')).toBe('auth-code');
      return new Response(JSON.stringify({
        access_token: 'at', expires_in: 3600, refresh_token: 'rt', scope: 'Mail.Read', token_type: 'Bearer',
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const out = await graphExchangeAuthorizationCode({
      client_id: 'client',
      code: 'auth-code',
      redirect_uri: 'https://app/callback',
      pkce: { code_verifier: 'v' },
    }, fetchMock as typeof fetch);
    expect(out.access_token).toBe('at');
    expect(out.refresh_token).toBe('rt');
  });

  it('raises reauth_required when refresh fails', async () => {
    const fetchMock = async (): Promise<Response> => new Response('invalid_grant', { status: 400 });
    await expect(graphRefreshToken({ client_id: 'client', refresh_token: 'rt' }, fetchMock as typeof fetch)).rejects.toMatchObject({ code: 'reauth_required' });
  });
});
