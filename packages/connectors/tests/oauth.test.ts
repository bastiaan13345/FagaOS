/**
 * OAuth PKCE + Google token-exchange tests.
 */
import { describe, it, expect, vi } from 'vitest';
import { buildAuthorizationUrl, generatePkce, exchangeAuthorizationCode, exchangeRefreshToken } from '../src/index.js';
import { ConnectorError } from '../src/index.js';

describe('PKCE', () => {
  it('generates verifier and S256 challenge', () => {
    const pkce = generatePkce();
    expect(pkce.code_verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(pkce.code_challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(pkce.code_challenge_method).toBe('S256');
  });

  it('builds an authorisation URL with the right parameters', () => {
    const url = buildAuthorizationUrl({
      authorization_endpoint: 'https://example.com/oauth/authorize',
      client_id: 'cid',
      redirect_uri: 'https://app.example.com/cb',
      scopes: ['openid', 'email'],
      state: 's1',
      pkce: generatePkce(),
    });
    const u = new URL(url);
    expect(u.searchParams.get('client_id')).toBe('cid');
    expect(u.searchParams.get('response_type')).toBe('code');
    expect(u.searchParams.get('scope')).toBe('openid email');
    expect(u.searchParams.get('state')).toBe('s1');
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
  });
});

describe('Google token exchange', () => {
  it('exchanges the authorisation code for tokens', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ access_token: 'a', expires_in: 3600, token_type: 'Bearer' }), { status: 200 }),
    );
    const out = await exchangeAuthorizationCode(
      {
        token_endpoint: 'https://example.com/token',
        client_id: 'cid',
        code: 'c',
        redirect_uri: 'https://app/cb',
        pkce: generatePkce(),
      },
      fetchImpl as unknown as typeof fetch,
    );
    expect(out.access_token).toBe('a');
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('raises provider_error on a non-2xx response', async () => {
    const fetchImpl = vi.fn(async () => new Response('bad', { status: 400 }));
    await expect(
      exchangeAuthorizationCode(
        {
          token_endpoint: 'https://example.com/token',
          client_id: 'cid',
          code: 'c',
          redirect_uri: 'https://app/cb',
          pkce: generatePkce(),
        },
        fetchImpl as unknown as typeof fetch,
      ),
    ).rejects.toBeInstanceOf(ConnectorError);
  });

  it('refreshes a token', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ access_token: 'a2', expires_in: 3600, token_type: 'Bearer' }), { status: 200 }),
    );
    const out = await exchangeRefreshToken(
      {
        token_endpoint: 'https://example.com/token',
        client_id: 'cid',
        refresh_token: 'rt',
      },
      fetchImpl as unknown as typeof fetch,
    );
    expect(out.access_token).toBe('a2');
  });
});
