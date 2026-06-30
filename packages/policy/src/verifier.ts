/**
 * Capability verifier.
 *
 * The verifier is the gate every connector and desktop-bridge call
 * passes through. The flow is:
 *
 *   1. Parse the token against the Zod schema. Malformed tokens are
 *      rejected with `token_malformed`.
 *   2. Confirm the algorithm is one we support. Currently only
 *      `hmac-sha256-v1`. Anything else is `token_unsupported_algorithm`.
 *   3. Confirm the workspace matches the verifier's workspace.
 *      Cross-workspace tokens are rejected.
 *   4. Look up the signing key in the secret store by the token's
 *      `keyId`. Unknown key → `token_unknown_key`.
 *   5. Verify the HMAC over the canonical body. Wrong signature →
 *      `token_signature_invalid`.
 *   6. Confirm the token is within `[notBefore, expiresAt]`. Outside
 *      → `token_not_yet_valid` or `token_expired`.
 *   7. Check the key's grace-window status. If the key is retired
 *      and outside the grace window → `key_retired`.
 *   8. Match the request against the token's granted capabilities.
 *      No matching capability → `token_scope_mismatch`.
 *   9. Ask the policy engine whether the request is allowed. The
 *      engine may still deny even if the token says yes (e.g. a
 *      rule was tightened after the token was minted).
 *  10. Otherwise allow.
 *
 * The verifier is stateless except for the secret store and the
 * engine; it is safe to share across requests.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  CapabilityTokenSchema,
  type CapabilityToken,
  type CapabilityVerifier,
  type PolicyEngine,
  type PolicyRequest,
  type SecretMaterial,
  type SecretStore,
  type VerifyResult,
} from './types.js';
import { canonicalize } from './canonical.js';

export interface CapabilityVerifierOptions {
  secretStore: SecretStore;
  engine: PolicyEngine;
  workspaceId: string;
  now?: () => Date;
  /**
   * When true, retire-window checks are bypassed — only used for
   * tests that want to verify the signature in isolation. The
   * default is false (production path).
   */
  skipRetireWindowCheck?: boolean;
}

export function createCapabilityVerifier(opts: CapabilityVerifierOptions): CapabilityVerifier {
  const now = opts.now ?? (() => new Date());

  return {
    async verify(input): Promise<VerifyResult> {
      const parsed = safeParse(input.token);
      if (!parsed.ok) {
        return { ok: false, code: 'token_malformed', message: parsed.message };
      }
      const token = parsed.value;
      if (token.body.algorithm !== 'hmac-sha256-v1') {
        return { ok: false, code: 'token_unsupported_algorithm', message: `unsupported algorithm: ${token.body.algorithm}` };
      }
      if (token.body.workspaceId !== opts.workspaceId) {
        return { ok: false, code: 'token_workspace_mismatch', message: `token workspace "${token.body.workspaceId}" does not match verifier workspace "${opts.workspaceId}"` };
      }

      let key: SecretMaterial;
      try {
        key = opts.secretStore.getKey(token.body.keyId);
      } catch {
        return { ok: false, code: 'token_unknown_key', message: `unknown signing key: ${token.body.keyId}` };
      }

      if (!verifySignature(token, key.secret)) {
        return { ok: false, code: 'token_signature_invalid', message: 'token signature does not match' };
      }

      const nowIso = now().toISOString();
      if (token.body.notBefore) {
        if (Date.parse(nowIso) < Date.parse(token.body.notBefore)) {
          return { ok: false, code: 'token_not_yet_valid', message: `token is not valid before ${token.body.notBefore}` };
        }
      }
      if (Date.parse(nowIso) >= Date.parse(token.body.expiresAt)) {
        return { ok: false, code: 'token_expired', message: `token expired at ${token.body.expiresAt}` };
      }

      if (!opts.skipRetireWindowCheck && key.retiredAt !== null) {
        const retireCutoff = Date.parse(key.retiredAt) + opts.secretStore.graceWindowMs;
        if (Date.parse(nowIso) >= retireCutoff) {
          return { ok: false, code: 'key_retired', message: `signing key "${key.keyId}" was retired at ${key.retiredAt} and is past the grace window` };
        }
      }

      const matchedCapability = findMatchingCapability(token.body.capabilities, input.request);
      if (!matchedCapability) {
        return { ok: false, code: 'token_scope_mismatch', message: `token has no capability covering ${input.request.action.namespace}.${input.request.action.name} on ${input.request.resource.type}:${input.request.resource.id}` };
      }

      const decision = await opts.engine.decide(input.request);
      if (!decision.allow) {
        return { ok: false, code: 'deny', message: decision.reason ?? 'denied by policy', ...(decision.ruleId ? { ruleId: decision.ruleId } : {}) };
      }

      return { ok: true, token };
    },
    resolveKey(keyId) {
      return opts.secretStore.getKey(keyId);
    },
  };
}

function safeParse(input: unknown): { ok: true; value: CapabilityToken } | { ok: false; message: string } {
  const r = CapabilityTokenSchema.safeParse(input);
  if (!r.success) {
    return { ok: false, message: r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
  }
  return { ok: true, value: r.data };
}

function verifySignature(token: CapabilityToken, secret: Buffer): boolean {
  const expected = createHmac('sha256', secret).update(canonicalize(token.body)).digest();
  let actual: Buffer;
  try {
    actual = Buffer.from(token.signature, 'hex');
  } catch {
    return false;
  }
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(expected, actual);
}

function findMatchingCapability(
  capabilities: ReadonlyArray<CapabilityToken['body']['capabilities'][number]>,
  request: PolicyRequest,
): { namespace: string; action: string; resourceType: string; resourceId: string | null | undefined } | null {
  for (const cap of capabilities) {
    if (cap.namespace !== request.action.namespace) continue;
    if (cap.action !== request.action.name) continue;
    if (cap.resourceType !== request.resource.type) continue;
    if (cap.resourceId !== undefined && cap.resourceId !== null && cap.resourceId !== request.resource.id) continue;
    return { namespace: cap.namespace, action: cap.action, resourceType: cap.resourceType, resourceId: cap.resourceId ?? null };
  }
  return null;
}
