/**
 * Microsoft Graph token-provider tests.
 *
 * The token provider caches the access token until 60s before expiry,
 * then calls `graphRefreshToken` to mint a fresh one. On refresh
 * success the new access token (and rotated refresh token, if the
 * provider returned one) is written back to the vault. On a missing
 * refresh token the provider raises `reauth_required` so the gateway
 * can flip the account's reauth flag.
 */
import { describe, it, expect, vi } from 'vitest';
import { ConnectorError } from '../src/index.js';
import { buildGraphTokenProvider } from '../src/connectors/outlook/token-provider.js';

interface Vault {
  getAccessToken: ReturnType<typeof vi.fn>;
  setAccessToken: ReturnType<typeof vi.fn>;
  getRefreshToken: ReturnType<typeof vi.fn>;
  setRefreshToken: ReturnType<typeof vi.fn>;
}

function makeVault(): Vault {
  return {
    getAccessToken: vi.fn(),
    setAccessToken: vi.fn(),
    getRefreshToken: vi.fn(),
    setRefreshToken: vi.fn(),
  };
}

const futureExp = (offsetMs: number) => new Date(offsetMs).toISOString();

describe('buildGraphTokenProvider — cache hit', () => {
  it('returns the cached access token when it is still valid', async () => {
    const now = 1_700_000_000_000;
    const clock = vi.fn(() => now);
    const vault = makeVault();
    vault.getAccessToken.mockResolvedValue({ token: 'cached', expires_at: futureExp(now + 600_000) });
    const provider = buildGraphTokenProvider({
      vault,
      oauth: { client_id: 'cid' },
      fetchImpl: vi.fn() as unknown as typeof fetch,
      clock: () => clock(),
    });
    const out = await provider.accessToken({ account_id: 'a1', scopes: ['Mail.Read'] });
    expect(out).toBe('cached');
    expect(vault.getAccessToken).toHaveBeenCalledOnce();
    expect(vault.getRefreshToken).not.toHaveBeenCalled();
  });

  it('treats an access token inside the 60s expiry window as expired', async () => {
    const now = 1_700_000_000_000;
    const clock = vi.fn(() => now);
    const vault = makeVault();
    vault.getAccessToken.mockResolvedValue({ token: 'about-to-expire', expires_at: futureExp(now + 30_000) });
    vault.getRefreshToken.mockResolvedValue('rt-1');
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ access_token: 'fresh', expires_in: 3600, token_type: 'Bearer' }), { status: 200 }),
    );
    const provider = buildGraphTokenProvider({
      vault,
      oauth: { client_id: 'cid' },
      fetchImpl: fetchImpl as unknown as typeof fetch,
      clock: () => clock(),
    });
    const out = await provider.accessToken({ account_id: 'a1', scopes: ['Mail.Read'] });
    expect(out).toBe('fresh');
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(vault.setAccessToken).toHaveBeenCalledWith(
      expect.objectContaining({ account_id: 'a1', token: 'fresh' }),
    );
  });
});

describe('buildGraphTokenProvider — refresh path', () => {
  it('refreshes the access token and persists the new one to the vault', async () => {
    const now = 1_700_000_000_000;
    const clock = vi.fn(() => now);
    const vault = makeVault();
    vault.getAccessToken.mockResolvedValue(null);
    vault.getRefreshToken.mockResolvedValue('rt-old');
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ access_token: 'new-at', expires_in: 3600, token_type: 'Bearer' }), { status: 200 }),
    );
    const provider = buildGraphTokenProvider({
      vault,
      oauth: { client_id: 'cid' },
      fetchImpl: fetchImpl as unknown as typeof fetch,
      clock: () => clock(),
    });
    const out = await provider.accessToken({ account_id: 'a1', scopes: ['Mail.Read'] });
    expect(out).toBe('new-at');
    expect(vault.setAccessToken).toHaveBeenCalledWith({
      account_id: 'a1',
      token: 'new-at',
      expires_at: futureExp(now + 3600 * 1000),
    });
    // No new refresh token was returned, so the vault must not be
    // told to overwrite the on-file refresh token.
    expect(vault.setRefreshToken).not.toHaveBeenCalled();
  });

  it('persists the rotated refresh token when the refresh response includes one', async () => {
    const now = 1_700_000_000_000;
    const clock = vi.fn(() => now);
    const vault = makeVault();
    vault.getAccessToken.mockResolvedValue(null);
    vault.getRefreshToken.mockResolvedValue('rt-old');
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({ access_token: 'new-at', expires_in: 3600, refresh_token: 'rt-new', token_type: 'Bearer' }),
        { status: 200 },
      ),
    );
    const provider = buildGraphTokenProvider({
      vault,
      oauth: { client_id: 'cid', client_secret: 'secret' },
      fetchImpl: fetchImpl as unknown as typeof fetch,
      clock: () => clock(),
    });
    await provider.accessToken({ account_id: 'a1', scopes: ['Mail.Read'] });
    expect(vault.setRefreshToken).toHaveBeenCalledWith({
      account_id: 'a1',
      refresh_token: 'rt-new',
      expires_at: futureExp(now + 3600 * 1000),
    });
  });

  it('raises reauth_required when the vault has no refresh token', async () => {
    const vault = makeVault();
    vault.getAccessToken.mockResolvedValue(null);
    vault.getRefreshToken.mockResolvedValue(null);
    const provider = buildGraphTokenProvider({
      vault,
      oauth: { client_id: 'cid' },
      fetchImpl: vi.fn() as unknown as typeof fetch,
    });
    await expect(
      provider.accessToken({ account_id: 'a1', scopes: ['Mail.Read'] }),
    ).rejects.toMatchObject({ code: 'reauth_required' });
  });

  it('propagates the reauth_required error from graphRefreshToken when the refresh fails', async () => {
    const vault = makeVault();
    vault.getAccessToken.mockResolvedValue(null);
    vault.getRefreshToken.mockResolvedValue('rt-1');
    const fetchImpl = vi.fn(async () => new Response('invalid_grant', { status: 400, statusText: 'Bad Request' }));
    const provider = buildGraphTokenProvider({
      vault,
      oauth: { client_id: 'cid' },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(
      provider.accessToken({ account_id: 'a1', scopes: ['Mail.Read'] }),
    ).rejects.toBeInstanceOf(ConnectorError);
    expect(vault.setAccessToken).not.toHaveBeenCalled();
  });
});

describe('buildGraphTokenProvider — clock + wiring defaults', () => {
  it('uses the supplied token_endpoint when the caller overrides it', async () => {
    const vault = makeVault();
    vault.getAccessToken.mockResolvedValue(null);
    vault.getRefreshToken.mockResolvedValue('rt-1');
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.method).toBe('POST');
      return new Response(JSON.stringify({ access_token: 'a', expires_in: 60, token_type: 'Bearer' }), { status: 200 });
    });
    const provider = buildGraphTokenProvider({
      vault,
      oauth: { client_id: 'cid', token_endpoint: 'https://login.example.com/token' },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await provider.accessToken({ account_id: 'a1', scopes: ['Mail.Read'] });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://login.example.com/token',
      expect.objectContaining({ method: 'POST' }),
    );
  });
});
