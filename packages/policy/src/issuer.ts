/**
 * Capability issuer.
 *
 * Mints short-lived, signed capability tokens. The token's `body`
 * contains the subject, granted capabilities, timestamps, workspace
 * id, and the signing key id. The `signature` is an HMAC-SHA-256 over
 * the canonical JSON of `body` using the secret-store key with that
 * id.
 *
 * The issuer is bound to a single workspace — the body carries the
 * workspace id so the verifier can reject cross-workspace tokens
 * even if a key id is somehow shared across workspaces.
 *
 * The issuer is intentionally cheap: a single HMAC and a JSON
 * serialisation. Rotation, expiry, and scope enforcement all live in
 * the verifier; the issuer just produces a token.
 */
import { createHmac } from 'node:crypto';
import {
  CapabilityTokenBodySchema,
  type CapabilityIssuer,
  type CapabilityTokenBody,
  type SecretStore,
} from './types.js';
import { PolicyError } from './errors.js';
import { canonicalize } from './canonical.js';

export interface CapabilityIssuerOptions {
  secretStore: SecretStore;
  workspaceId: string;
  now?: () => Date;
  /**
   * Maximum TTL accepted from callers. Default 24h. The 24h cap
   * keeps a leaked token from being useful for long; production
   * policy should set this to whatever the org's session lifetime is.
   */
  maxTtlMs?: number;
}

const DEFAULT_MAX_TTL_MS = 24 * 60 * 60 * 1000;
const ALGORITHM = 'hmac-sha256-v1' as const;

export function createCapabilityIssuer(opts: CapabilityIssuerOptions): CapabilityIssuer {
  const now = opts.now ?? (() => new Date());
  const maxTtlMs = opts.maxTtlMs ?? DEFAULT_MAX_TTL_MS;

  return {
    currentKeyId() {
      const active = opts.secretStore.getActiveKey('capability-signing');
      if (!active) {
        throw new PolicyError('secret_not_found', 'no active capability-signing key', {
          workspaceId: opts.workspaceId,
        });
      }
      return active.keyId;
    },
    mint(input) {
      if (!input.subject) {
        throw new PolicyError('invalid_request', 'subject is required');
      }
      if (!input.capabilities || input.capabilities.length === 0) {
        throw new PolicyError('invalid_request', 'at least one capability is required');
      }
      if (input.ttlMs <= 0) {
        throw new PolicyError('invalid_request', 'ttlMs must be positive');
      }
      if (input.ttlMs > maxTtlMs) {
        throw new PolicyError('invalid_request', `ttlMs exceeds the issuer cap (${maxTtlMs}ms)`, { requestedMs: input.ttlMs, maxMs: maxTtlMs });
      }
      const active = opts.secretStore.getActiveKey('capability-signing');
      if (!active) {
        throw new PolicyError('secret_not_found', 'no active capability-signing key', { workspaceId: opts.workspaceId });
      }
      const issuedAtDate = now();
      const issuedAt = issuedAtDate.toISOString();
      const expiresAtDate = new Date(issuedAtDate.getTime() + input.ttlMs);
      const expiresAt = expiresAtDate.toISOString();
      const notBefore = input.notBefore ? input.notBefore.toISOString() : undefined;
      const body: CapabilityTokenBody = CapabilityTokenBodySchema.parse({
        subject: input.subject,
        capabilities: input.capabilities,
        issuedAt,
        expiresAt,
        ...(notBefore ? { notBefore } : {}),
        workspaceId: opts.workspaceId,
        keyId: active.keyId,
        algorithm: ALGORITHM,
      });
      const signature = signBody(body, active.secret);
      return { body, signature };
    },
  };
}

function signBody(body: CapabilityTokenBody, secret: Buffer): string {
  const mac = createHmac('sha256', secret);
  mac.update(canonicalize(body));
  return mac.digest('hex');
}

export { signBody };
