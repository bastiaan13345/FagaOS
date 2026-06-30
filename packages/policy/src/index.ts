/**
 * @fagaos/policy — FagaOS policy, secrets, and capability primitives.
 *
 * Phase 2 (FAG-24) hardens the policy, secrets, and capability
 * surface that Phase 1 (FAG-13) sketched. The package is the
 * single authority for authorisation inside FagaOS:
 *
 *   - `PolicyEngine`     — answers "may agent X do action Y to
 *                          resource Z?" against a versioned rule set.
 *                          Default-deny. DENY rules override ALLOW.
 *
 *   - `SecretStore`      — workspace-level secret store with explicit
 *                          key rotation. Stores raw bytes (32-byte HMAC
 *                          keys, 32-byte random tokens, etc.) and
 *                          remembers the rotation history so a token
 *                          signed by a recently retired key can still
 *                          verify during the grace window.
 *
 *   - `CapabilityIssuer` — mints short-lived, signed capability
 *                          tokens using the current `SecretStore`
 *                          signing key.
 *
 *   - `CapabilityVerifier` — verifies a token's signature against the
 *                          key id embedded in the token, checks expiry,
 *                          and asks the `PolicyEngine` whether the
 *                          token's capabilities cover the requested
 *                          action under the current published policy.
 *
 *   - `PolicyAdministrator` — draft / review / approve / publish
 *                          workflow for the rule set. The published
 *                          version is what the engine consults.
 *
 *   - `PolicyDecisionStore` — durable persistence boundary for the
 *                          policy store and policy review trail. The
 *                          in-memory implementation is the local-dev
 *                          default; a SQLite or Postgres adapter
 *                          slots in via the same interface.
 *
 * The policy language is intentionally small and explicit. It is
 * *Cedar-like* in shape (effect, principal, action, resource,
 * conditions) but evaluated entirely in-process. See
 * `docs/adr/0005-policy-engine-cedar-decision.md` for the
 * Phase 2 / Phase 3 decision and the documented migration path to
 * a full Cedar backend if/when policy complexity outgrows the
 * in-memory engine.
 */
export * from './types.js';
export * from './errors.js';
export * from './engine.js';
export * from './secret-store.js';
export * from './issuer.js';
export * from './verifier.js';
export * from './governance.js';
export * from './policy-store.js';
export * from './guards.js';

import { InMemoryCedarLikePolicyEngine } from './engine.js';
import { InMemorySecretStore, FileBackedSecretStore, type InMemorySecretStoreOptions } from './secret-store.js';
import { createCapabilityIssuer } from './issuer.js';
import { createCapabilityVerifier } from './verifier.js';
import { createPolicyAdministrator } from './governance.js';
import { InMemoryPolicyDecisionStore } from './policy-store.js';
import type {
  PolicyEngine,
  SecretStore,
  CapabilityIssuer,
  CapabilityVerifier,
  PolicyAdministrator,
  PolicyDecisionStore,
  PolicyRule,
} from './types.js';

export interface FagaosPolicyStack {
  engine: PolicyEngine;
  secretStore: SecretStore;
  issuer: CapabilityIssuer;
  verifier: CapabilityVerifier;
  administrator: PolicyAdministrator;
  decisionStore: PolicyDecisionStore;
}

export interface FagaosPolicyStackOptions {
  workspaceId: string;
  /** Optional seed for the secret store. Useful for tests. */
  seedKeys?: Array<{ keyId: string; secret: Buffer; createdAt: string }>;
  /** Optional initial policy rules. */
  initialPolicy?: PolicyRule[];
  /** Optional clock. */
  now?: () => Date;
  /** Optional secret-store options. */
  secretStoreOptions?: Omit<InMemorySecretStoreOptions, 'workspaceId' | 'now'>;
}

/**
 * One-call assembly of a complete, in-process policy stack wired
 * together. The returned stack is internally consistent: the engine
 * consults the policy store, the issuer signs with the secret store's
 * current key, and the verifier looks up tokens by key id in the
 * secret store's key ring. Tests and local dev use this; production
 * may replace individual components (e.g. the in-memory engine) with
 * adapters without breaking the rest of the stack.
 */
export function createInMemoryPolicyStack(opts: FagaosPolicyStackOptions = { workspaceId: 'default' }): FagaosPolicyStack {
  const secretStore = new InMemorySecretStore({
    workspaceId: opts.workspaceId,
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.secretStoreOptions ?? {}),
  });
  if (opts.seedKeys) {
    for (const k of opts.seedKeys) {
      secretStore.importKey({ keyId: k.keyId, secret: k.secret, purpose: 'capability-signing', createdAt: k.createdAt });
    }
  } else {
    const rotateInput: { keyId?: string; purpose: 'capability-signing'; label?: string; now?: string } = { purpose: 'capability-signing' };
    if (opts.now) rotateInput.now = opts.now().toISOString();
    secretStore.rotate(rotateInput);
  }
  const decisionStore = new InMemoryPolicyDecisionStore(opts.now ? { now: opts.now } : {});
  const engine = new InMemoryCedarLikePolicyEngine({ store: decisionStore });
  if (opts.initialPolicy) {
    engine.addRules(opts.initialPolicy);
  }
  const issuer = createCapabilityIssuer({ secretStore, workspaceId: opts.workspaceId, ...(opts.now ? { now: opts.now } : {}) });
  const verifier = createCapabilityVerifier({ secretStore, engine, workspaceId: opts.workspaceId, ...(opts.now ? { now: opts.now } : {}) });
  const administrator = createPolicyAdministrator({ store: decisionStore, ...(opts.now ? { now: opts.now } : {}) });
  return { engine, secretStore, issuer, verifier, administrator, decisionStore };
}

/** Re-export the implementation classes for advanced consumers. */
export {
  InMemoryCedarLikePolicyEngine,
  InMemorySecretStore,
  FileBackedSecretStore,
  InMemoryPolicyDecisionStore,
  createCapabilityIssuer,
  createCapabilityVerifier,
  createPolicyAdministrator,
};
