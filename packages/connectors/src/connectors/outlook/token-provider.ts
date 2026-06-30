/**
 * Microsoft Graph token provider.
 *
 * Mirrors `GoogleTokenProvider`: the gateway wires this to a credential
 * vault, the connector asks for a current access token. The provider
 * does the refresh, sets the new refresh token on the vault, and
 * raises `reauth_required` on a refresh failure so the gateway flips
 * the reauth flag.
 */
import type { Provider } from '../../models/schemas.js';
import { ConnectorError } from '../../errors.js';
import { graphRefreshToken } from '../../oauth/microsoft_graph.js';

export interface GraphTokenProvider {
  accessToken(args: { account_id: string; scopes: ReadonlyArray<string> }): Promise<string>;
}

export interface GraphTokenProviderOptions {
  /**
   * Pluggable credential vault. The implementation is responsible for
   * persisting the new refresh token after a successful refresh. The
   * connector never holds the refresh token.
   */
  vault: {
    getRefreshToken(args: { account_id: string }): Promise<string | null>;
    setRefreshToken(args: { account_id: string; refresh_token: string; expires_at: string }): Promise<void>;
    getAccessToken(args: { account_id: string }): Promise<{ token: string; expires_at: string } | null>;
    setAccessToken(args: { account_id: string; token: string; expires_at: string }): Promise<void>;
  };
  oauth: {
    client_id: string;
    client_secret?: string;
    tenant?: 'common' | 'organizations' | 'consumers' | string;
    token_endpoint?: string;
  };
  fetchImpl?: typeof fetch;
  /** Clock for tests. */
  clock?: () => number;
}

/**
 * Build a `GraphTokenProvider` from a vault. The provider caches the
 * access token until 60 seconds before expiry; refresh uses
 * `graphRefreshToken`.
 */
export function buildGraphTokenProvider(opts: GraphTokenProviderOptions): GraphTokenProvider {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const clock = opts.clock ?? (() => Date.now());
  return {
    async accessToken({ account_id, scopes }) {
      void scopes;
      const cached = await opts.vault.getAccessToken({ account_id });
      if (cached && Date.parse(cached.expires_at) - 60_000 > clock()) {
        return cached.token;
      }
      const refresh = await opts.vault.getRefreshToken({ account_id });
      if (!refresh) {
        throw new ConnectorError('reauth_required', 'no refresh token in vault; user must re-link');
      }
      const next = await graphRefreshToken(
        {
          client_id: opts.oauth.client_id,
          client_secret: opts.oauth.client_secret ?? undefined,
          tenant: opts.oauth.tenant ?? undefined,
          token_endpoint: opts.oauth.token_endpoint ?? undefined,
          refresh_token: refresh,
        },
        fetchImpl,
      );
      const expires_at = new Date(clock() + next.expires_in * 1000).toISOString();
      await opts.vault.setAccessToken({ account_id, token: next.access_token, expires_at });
      if (next.refresh_token) {
        await opts.vault.setRefreshToken({
          account_id,
          refresh_token: next.refresh_token,
          expires_at,
        });
      }
      return next.access_token;
    },
  };
}

/** Helper for tests. */
export const __testing__ = { Provider: null as Provider | null };
