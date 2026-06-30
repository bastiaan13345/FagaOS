/**
 * Microsoft Graph OAuth helper.
 *
 * The Microsoft identity platform uses an OAuth 2.0 flow very similar
 * to Google's. The notable differences:
 *
 *   - The authorisation endpoint is `login.microsoftonline.com` (or
 *     the per-tenant `login.microsoftonline.com/{tenant}/`).
 *   - Scopes are space-separated and pre-declared in the Azure AD app
 *     registration; an unregistered scope fails silently.
 *   - Tenant choices: `common` (multi-tenant + personal), `organizations`
 *     (work/school only), `consumers` (personal only), or a tenant id.
 *   - Refresh tokens are long-lived (up to 90 days of inactivity) but
 *     rotated on every refresh. The credential vault MUST update the
 *     stored refresh token on every successful refresh response.
 *   - The Graph SDK is not used here — the connector uses
 *     `globalThis.fetch` so tests can inject a mock.
 *
 * Reference:
 *   https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow
 *   https://learn.microsoft.com/en-us/graph/auth-v2-user
 */
import { buildAuthorizationUrl, type AuthorizationUrlInput } from './pkce.js';
import { ConnectorError } from '../errors.js';
import type { Provider } from '../models/schemas.js';

const DEFAULT_AUTHORIZE = 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize';
const DEFAULT_TOKEN = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';

export const GRAPH_PRODUCTION_SCOPES: Readonly<Record<'outlook' | 'outlook_calendar', ReadonlyArray<string>>> = {
  outlook: [
    'offline_access',
    'openid',
    'profile',
    'email',
    'Mail.Read',
    'Mail.ReadWrite',
    'Mail.Send',
    'User.Read',
  ],
  outlook_calendar: [
    'offline_access',
    'openid',
    'profile',
    'email',
    'Calendars.Read',
    'Calendars.ReadWrite',
    'User.Read',
  ],
};

export function graphProductionScopesFor(provider: Provider): ReadonlyArray<string> {
  if (provider === 'outlook' || provider === 'outlook_calendar') {
    return GRAPH_PRODUCTION_SCOPES[provider];
  }
  return [];
}

export interface GraphTokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
  token_type: 'Bearer';
  id_token?: string;
  expires_on?: string;
}

export function graphAuthorizationUrl(input: {
  provider: 'outlook' | 'outlook_calendar';
  client_id: string;
  redirect_uri: string;
  state: string;
  scopes?: ReadonlyArray<string>;
  pkce: AuthorizationUrlInput['pkce'];
  /** 'common' (default), 'organizations', 'consumers', or a tenant id. */
  tenant?: 'common' | 'organizations' | 'consumers' | string;
}): string {
  const tenant = input.tenant ?? 'common';
  const scope = (input.scopes ?? graphProductionScopesFor(input.provider)).join(' ');
  return buildAuthorizationUrl({
    authorization_endpoint: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`,
    client_id: input.client_id,
    redirect_uri: input.redirect_uri,
    scopes: scope.split(' ').filter(Boolean),
    state: input.state,
    pkce: input.pkce,
    extra_params: {
      response_mode: 'query',
      prompt: 'select_account',
    },
  });
}

export interface GraphExchangeInput {
  token_endpoint?: string | undefined;
  client_id: string;
  client_secret?: string | undefined;
  tenant?: 'common' | 'organizations' | 'consumers' | string | undefined;
  code: string;
  redirect_uri: string;
  pkce: { code_verifier: string };
}

export async function graphExchangeAuthorizationCode(
  input: GraphExchangeInput,
  fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
): Promise<GraphTokenResponse> {
  const tenant = input.tenant ?? 'common';
  const body = new URLSearchParams({
    client_id: input.client_id,
    grant_type: 'authorization_code',
    code: input.code,
    redirect_uri: input.redirect_uri,
    code_verifier: input.pkce.code_verifier,
  });
  if (input.client_secret) body.set('client_secret', input.client_secret);
  const res = await fetchImpl(input.token_endpoint ?? `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) {
    throw new ConnectorError(
      'provider_error',
      `graph token exchange failed: ${res.status} ${res.statusText}`,
      await safeText(res),
    );
  }
  return (await res.json()) as GraphTokenResponse;
}

export interface GraphRefreshInput {
  token_endpoint?: string | undefined;
  client_id: string;
  client_secret?: string | undefined;
  tenant?: 'common' | 'organizations' | 'consumers' | string | undefined;
  refresh_token: string;
}

export async function graphRefreshToken(
  input: GraphRefreshInput,
  fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
): Promise<GraphTokenResponse> {
  const tenant = input.tenant ?? 'common';
  const body = new URLSearchParams({
    client_id: input.client_id,
    grant_type: 'refresh_token',
    refresh_token: input.refresh_token,
  });
  if (input.client_secret) body.set('client_secret', input.client_secret);
  const res = await fetchImpl(input.token_endpoint ?? `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) {
    throw new ConnectorError(
      'reauth_required',
      `graph refresh failed: ${res.status} ${res.statusText}`,
      await safeText(res),
    );
  }
  return (await res.json()) as GraphTokenResponse;
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

export { DEFAULT_AUTHORIZE, DEFAULT_TOKEN };
