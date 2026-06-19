/**
 * @fagaos/control-plane/auth
 *
 * Production authn/authz for the control-plane HTTP API.
 *
 * Authentication: Bearer token (static API key for now; JWT/JWKS in production).
 * Authorization: role-based — each route has a minimum required role.
 *
 * Identity model
 * ──────────────
 *  - "user:<id>"   — workspace human member
 *  - "agent:<id>"  — registered agent acting on behalf of a session
 *  - "system"      — internal control-plane (health, recovery)
 *
 * Roles (in ascending privilege):
 *   reader  — GET-only access (sessions, tasks, log, health)
 *   invoker — reader + can create sessions and invoke tools
 *   admin   — invoker + can kill sessions, cancel tasks, register cards
 *   system  — internal-only (recover tasks)
 */

export type CallerRole = 'reader' | 'invoker' | 'admin' | 'system';

export interface CallerIdentity {
  id: string;
  type: 'user' | 'agent' | 'system';
  role: CallerRole;
}

export interface AuthConfig {
  /**
   * Map from static API key → caller identity.
   * In production this would be backed by a secret store.
   */
  tokens: Map<string, CallerIdentity>;
  /**
   * When true, unauthenticated requests to health/readiness endpoints
   * are allowed (useful for load balancer probes).
   */
  allowUnauthenticatedHealthChecks?: boolean;
}

export type AuthResult =
  | { ok: true; caller: CallerIdentity }
  | { ok: false; status: 401 | 403; code: string; message: string };

const ROLE_ORDER: Record<CallerRole, number> = {
  reader: 0,
  invoker: 1,
  admin: 2,
  system: 3,
};

export function hasRole(caller: CallerIdentity, required: CallerRole): boolean {
  return ROLE_ORDER[caller.role] >= ROLE_ORDER[required];
}

export function authenticate(
  authHeader: string | undefined,
  config: AuthConfig,
): AuthResult {
  if (!authHeader) {
    return { ok: false, status: 401, code: 'missing_token', message: 'Authorization header required' };
  }
  const [scheme, token] = authHeader.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !token) {
    return { ok: false, status: 401, code: 'invalid_scheme', message: 'Bearer token required' };
  }
  const identity = config.tokens.get(token);
  if (!identity) {
    return { ok: false, status: 401, code: 'invalid_token', message: 'Invalid or revoked token' };
  }
  return { ok: true, caller: identity };
}

export function authorize(caller: CallerIdentity, required: CallerRole): AuthResult {
  if (!hasRole(caller, required)) {
    return {
      ok: false,
      status: 403,
      code: 'forbidden',
      message: `Role '${required}' required; caller has '${caller.role}'`,
    };
  }
  return { ok: true, caller };
}

/**
 * Derive a stable actor representation from a caller identity
 * so audit entries carry the same format as existing Actor records.
 */
export function callerToActor(caller: CallerIdentity): { id: string; type: 'user' | 'agent' | 'system' } {
  return { id: caller.id, type: caller.type };
}
