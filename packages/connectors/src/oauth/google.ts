/**
 * Minimal Google OAuth client.
 *
 * Phase 1 ships a thin client that knows the Google endpoints and
 * how to mint a token-exchange request. Token persistence is the
 * gateway's job; the connector asks for an access token through the
 * `TokenProvider` interface and never holds refresh tokens.
 *
 * NOTE: this client performs HTTPS calls. The connector layer should
 * mock it in tests; the production path is HTTPS only.
 */
import { ConnectorError } from '../errors.js';
import type { PkcePair } from './pkce.js';

export interface GoogleTokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
  token_type: 'Bearer';
  id_token?: string;
}

export interface GoogleTokenProvider {
  /**
   * Return a current access token for the given account, refreshing if
   * it is within 5 minutes of expiry. The connector never receives the
   * refresh token.
   */
  accessToken(args: { account_id: string; scopes: ReadonlyArray<string> }): Promise<string>;
}

export interface ExchangeCodeInput {
  token_endpoint: string;
  client_id: string;
  client_secret?: string;
  code: string;
  redirect_uri: string;
  pkce: PkcePair;
}

export interface ExchangeRefreshInput {
  token_endpoint: string;
  client_id: string;
  client_secret?: string;
  refresh_token: string;
}

/**
 * Standard Google token exchange (RFC 6749 §4.1.3 + PKCE).
 *
 * The caller passes a `fetch` so tests can stub the network. In
 * production the default `globalThis.fetch` is used.
 */
export async function exchangeAuthorizationCode(
  input: ExchangeCodeInput,
  fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
): Promise<GoogleTokenResponse> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: input.code,
    client_id: input.client_id,
    redirect_uri: input.redirect_uri,
    code_verifier: input.pkce.code_verifier,
  });
  if (input.client_secret) body.set('client_secret', input.client_secret);

  const res = await fetchImpl(input.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) {
    throw new ConnectorError(
      'provider_error',
      `token exchange failed: ${res.status} ${res.statusText}`,
      await safeText(res),
    );
  }
  return (await res.json()) as GoogleTokenResponse;
}

export async function exchangeRefreshToken(
  input: ExchangeRefreshInput,
  fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
): Promise<GoogleTokenResponse> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: input.refresh_token,
    client_id: input.client_id,
  });
  if (input.client_secret) body.set('client_secret', input.client_secret);
  const res = await fetchImpl(input.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) {
    throw new ConnectorError(
      'reauth_required',
      `refresh failed: ${res.status} ${res.statusText}`,
      await safeText(res),
    );
  }
  return (await res.json()) as GoogleTokenResponse;
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}
