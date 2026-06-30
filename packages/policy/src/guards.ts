/**
 * Policy-guarded call helpers.
 *
 * The connector gateway and the desktop-bridge each have their own
 * concrete operation surface. This module centralises the policy
 * translation: given a verifier and a structured call description,
 * build the `PolicyRequest`, run verification, and return a
 * uniform decision.
 *
 * The structural checks (`tokenAuthorizes` in the connectors,
 * `createAllowListCapabilityVerifier` in the desktop-bridge) remain
 * the fast hot-path guards. The functions here are the *augmentation*
 * that the connector gateway and desktop-bridge layer on top to
 * enforce:
 *   - cryptographic signature / expiry / workspace binding
 *   - key-rotation grace-window enforcement
 *   - the policy engine's allow/deny decision
 *
 * The connectors and desktop-bridge packages import these
 * helpers; the policy package does not depend on the connector
 * types. Translation is done in the connectors package via the
 * generic `OperationDescriptor` shape below.
 */
import {
  type CapabilityToken,
  type CapabilityVerifier,
  type PolicyRequest,
  type VerifyResult,
} from './types.js';

export interface OperationDescriptor {
  /** Subject id (agent id, user id, system:component). */
  actorId: string;
  /** Top-level namespace for the action, e.g. "connector" or "desktop". */
  namespace: string;
  /** Operation name, e.g. "mail.send", "screenshot.capture". */
  name: string;
  /** Resource type, e.g. "connector.account" or "desktop.session". */
  resourceType: string;
  /** Resource id. */
  resourceId: string;
  /** Extra context forwarded to the policy engine. */
  context?: Record<string, unknown>;
}

/**
 * Synchronous structural pre-check: the token contains a
 * capability matching the descriptor's namespace/name/resourceType.
 * The token's `resourceId` may be `null` (wildcard), in which case
 * any resource id is allowed.
 *
 * This is a *fast* path; the full crypto + policy check follows
 * in `verifyCall` (async).
 */
export function tokenCoversOperation(
  token: CapabilityToken,
  descriptor: OperationDescriptor,
): boolean {
  // Validate expiry first; a token past its expiry is useless even
  // if it contains a matching capability.
  const nowMs = Date.now();
  if (Date.parse(token.body.expiresAt) <= nowMs) return false;
  if (token.body.notBefore && Date.parse(token.body.notBefore) > nowMs) return false;
  return token.body.capabilities.some((cap) => {
    if (cap.namespace !== descriptor.namespace) return false;
    if (cap.action !== descriptor.name) return false;
    if (cap.resourceType !== descriptor.resourceType) return false;
    if (cap.resourceId === null || cap.resourceId === undefined) return true;
    return cap.resourceId === descriptor.resourceId;
  });
}

/**
 * Full async verification: signature, expiry, key id, policy.
 * Returns the same shape as `CapabilityVerifier.verify`.
 */
export async function verifyCall(
  verifier: CapabilityVerifier,
  token: CapabilityToken,
  descriptor: OperationDescriptor,
): Promise<VerifyResult> {
  const request: PolicyRequest = {
    actor: { id: descriptor.actorId },
    action: { namespace: descriptor.namespace, name: descriptor.name },
    resource: { type: descriptor.resourceType, id: descriptor.resourceId },
    ...(descriptor.context ? { context: descriptor.context } : {}),
  };
  return verifier.verify({ token, request });
}

/**
 * Compose the structural pre-check and the full verify into a
 * single helper. Returns `{ allow: false, reason }` on any
 * rejection; otherwise `{ allow: true }`.
 */
export async function guardCall(
  verifier: CapabilityVerifier,
  token: CapabilityToken,
  descriptor: OperationDescriptor,
): Promise<{ allow: true } | { allow: false; reason: string; code: string }> {
  if (!tokenCoversOperation(token, descriptor)) {
    return {
      allow: false,
      code: 'token_scope_mismatch',
      reason: `token has no capability for ${descriptor.namespace}.${descriptor.name} on ${descriptor.resourceType}:${descriptor.resourceId}`,
    };
  }
  const result = await verifyCall(verifier, token, descriptor);
  if (result.ok) return { allow: true };
  return { allow: false, code: result.code, reason: result.message };
}
