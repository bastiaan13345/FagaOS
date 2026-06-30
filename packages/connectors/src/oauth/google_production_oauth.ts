/**
 * Google production-OAuth helper.
 *
 * The Phase 1 PKCE flow in `google.ts` covers local dev. This module
 * covers the production deployment of FagaOS, where:
 *
 *   - The OAuth client is a "Web application" client with a real
 *     client secret. The consent screen is a "Google verification"
 *     scope set covering Gmail and Calendar reads + writes.
 *   - The connector uses an *offline* access type so the user is
 *     prompted to grant a refresh token on first link. The refresh
 *     token never leaves the credential vault; the connector asks
 *     for a short-lived access token through `GoogleTokenProvider`.
 *   - Scopes are per-operation. Read-only connectors request
 *     `*.readonly`; write-enabled connectors request the broader
 *     `gmail.modify` / `calendar.events.owned` / etc.
 *
 * The function in this module does not perform the network call —
 * the gateway wires a `GoogleTokenProvider` to the connector and the
 * connector delegates. We expose helpers for the consent URL and the
 * scope set so the FagaOS control plane can render a per-workspace
 * linking screen.
 *
 * Reference:
 *   https://developers.google.com/identity/protocols/oauth2/web-server
 *   https://developers.google.com/workspace/calendar/api/guides/auth
 */
import { buildAuthorizationUrl, type AuthorizationUrlInput } from './pkce.js';
import type { Provider } from '../models/schemas.js';

/**
 * Scope bundles keyed by provider. The provider-scope map is the
 * single source of truth for what each connector is allowed to
 * request at link time. The control plane should refuse to mint a
 * token for a scope that is not in the bundle.
 */
export const GOOGLE_PRODUCTION_SCOPES: Readonly<Record<'gmail' | 'google_calendar', ReadonlyArray<string>>> = {
  gmail: [
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/gmail.send',
    'https://www.googleapis.com/auth/gmail.modify',
    'openid',
    'email',
    'profile',
  ],
  google_calendar: [
    'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
    'https://www.googleapis.com/auth/calendar.events.readonly',
    'https://www.googleapis.com/auth/calendar.events.owned',
    'openid',
    'email',
    'profile',
  ],
};

/** Resolve the production scope set for a provider. */
export function productionScopesFor(provider: Provider): ReadonlyArray<string> {
  if (provider === 'gmail' || provider === 'google_calendar') {
    return GOOGLE_PRODUCTION_SCOPES[provider];
  }
  return [];
}

/**
 * Build a Google consent URL for a production link. The caller passes
 * the same PKCE pair that the front end stored, plus the workspace
 * redirect URL. The state parameter is a CSRF nonce the gateway
 * verifies on the redirect.
 */
export function productionAuthorizationUrl(input: {
  provider: 'gmail' | 'google_calendar';
  client_id: string;
  redirect_uri: string;
  state: string;
  scopes?: ReadonlyArray<string>;
  pkce: AuthorizationUrlInput['pkce'];
  /** `online` (no refresh token) or `offline` (refresh token issued). */
  access_type?: 'online' | 'offline';
  /** Force consent to obtain a new refresh token even when one is on file. */
  prompt?: 'none' | 'consent' | 'select_account';
}): string {
  const scope = (input.scopes ?? productionScopesFor(input.provider)).join(' ');
  return buildAuthorizationUrl({
    authorization_endpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
    client_id: input.client_id,
    redirect_uri: input.redirect_uri,
    scopes: scope.split(' ').filter(Boolean),
    state: input.state,
    pkce: input.pkce,
    extra_params: {
      access_type: input.access_type ?? 'offline',
      prompt: input.prompt ?? 'consent',
      include_granted_scopes: 'true',
    },
  });
}
