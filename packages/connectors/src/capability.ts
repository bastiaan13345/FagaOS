/**
 * Capability model for the gateway.
 *
 * The FAG-6 capability broker mints short-lived capability tokens; the
 * gateway verifies them. For Phase 1 we accept a structured token (no
 * real crypto yet) and trust the caller. The token's shape is stable so
 * the policy engine can plug in later without changing the gateway
 * surface.
 *
 * Capability is a (provider, operation, optional account_id) triple. The
 * wildcard `*` for `account_id` means "any account the caller is allowed
 * to act on"; a specific id scopes to one account.
 */
import { z } from 'zod';
import { ProviderSchema, type Provider } from './models/schemas.js';

export const ConnectorOperationSchema = z.enum([
  'mail.list',
  'mail.get',
  'mail.send',
  'dm.conversations.list',
  'dm.send',
  'calendar.calendars.list',
  'calendar.events.list',
  'calendar.events.get',
]);
export type ConnectorOperation = z.infer<typeof ConnectorOperationSchema>;

/**
 * A capability is the authorisation unit. The gateway checks every call
 * against the caller's set of capabilities before invoking the connector.
 */
export const CapabilitySchema = z.object({
  provider: ProviderSchema,
  operation: ConnectorOperationSchema,
  /**
   * Account scope. `null` means the capability is provider-wide
   * (the caller may act on any account of that provider they own).
   */
  account_id: z.string().nullable().default(null),
});
export type Capability = z.infer<typeof CapabilitySchema>;

/**
 * A signed-by-issuer capability token. The token's opaque `body` is
 * JSON; in Phase 1 we accept the parsed shape and the broker's
 * verification is a no-op stub. The shape is locked so real signing
 * slots in later without API churn.
 */
export const CapabilityTokenSchema = z.object({
  /** Subject — agent id, user id, or "system:<component>". */
  subject: z.string().min(1),
  /** Granted capabilities. */
  capabilities: z.array(CapabilitySchema).min(1),
  /** RFC 3339 expiry. */
  expires_at: z.string().datetime(),
});
export type CapabilityToken = z.infer<typeof CapabilityTokenSchema>;

/** A token whose `account_id` is a wildcard for the given provider. */
export function hasProviderWideCapability(
  token: CapabilityToken,
  provider: Provider,
): boolean {
  return token.capabilities.some(
    (c) => c.provider === provider && c.account_id === null,
  );
}

/**
 * Verify a token covers a specific (provider, operation, account_id) call.
 * Returns `true` iff at least one capability in the token is a strict
 * superset of the requested triple and the token is not expired.
 */
export function tokenAuthorizes(
  token: CapabilityToken,
  request: { provider: Provider; operation: ConnectorOperation; account_id: string },
  now: () => Date = () => new Date(),
): boolean {
  const expires = Date.parse(token.expires_at);
  if (Number.isNaN(expires) || expires <= now().getTime()) return false;
  return token.capabilities.some(
    (c) =>
      c.provider === request.provider &&
      c.operation === request.operation &&
      (c.account_id === null || c.account_id === request.account_id),
  );
}
