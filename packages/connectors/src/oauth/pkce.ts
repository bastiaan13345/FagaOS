/**
 * OAuth 2.0 PKCE helpers.
 *
 * Implements the spec from RFC 7636. The gateway uses this to mint
 * authorisation-code-with-PKCE requests against providers that
 * support it (Google, Microsoft, Slack, Discord). The actual token
 * exchange (code → access_token) is performed by the gateway's
 * credential vault, not here.
 *
 * Two outputs:
 *   - `generatePkce()` returns a `code_verifier` and the corresponding
 *     `code_challenge` (S256). The verifier stays on the server; the
 *     challenge goes into the authorisation request.
 *   - `buildAuthorizationUrl()` returns a fully-formed URL the user's
 *     browser visits.
 */
import { createHash, randomBytes } from 'node:crypto';

export interface PkcePair {
  /** Plain-text verifier. Sent on the token exchange. */
  code_verifier: string;
  /** S256 challenge. Sent on the authorisation request. */
  code_challenge: string;
  /** Always "S256" in this implementation. */
  code_challenge_method: 'S256';
}

/** RFC 7636 §4.1 — 43–128 unreserved chars. We use 32 random bytes base64url. */
export function generatePkce(): PkcePair {
  const verifier = base64UrlEncode(randomBytes(32));
  const challenge = base64UrlEncode(createHash('sha256').update(verifier).digest());
  return {
    code_verifier: verifier,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  };
}

export interface AuthorizationUrlInput {
  authorization_endpoint: string;
  client_id: string;
  redirect_uri: string;
  scopes: ReadonlyArray<string>;
  state: string;
  pkce: PkcePair;
  /** Optional provider-specific extras. `access_type=offline` for Google, etc. */
  extra_params?: Record<string, string>;
}

export function buildAuthorizationUrl(input: AuthorizationUrlInput): string {
  const url = new URL(input.authorization_endpoint);
  url.searchParams.set('client_id', input.client_id);
  url.searchParams.set('redirect_uri', input.redirect_uri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', input.scopes.join(' '));
  url.searchParams.set('state', input.state);
  url.searchParams.set('code_challenge', input.pkce.code_challenge);
  url.searchParams.set('code_challenge_method', input.pkce.code_challenge_method);
  for (const [k, v] of Object.entries(input.extra_params ?? {})) {
    // Provider extras override defaults — callers that pass
    // `prompt=consent` should know what they're doing.
    url.searchParams.set(k, v);
  }
  return url.toString();
}

function base64UrlEncode(buf: Buffer): string {
  return buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}
