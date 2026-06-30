/**
 * Policy, capability, and secret primitives for FagaOS.
 *
 * The shape of these types is the contract between every package
 * that participates in authorisation (the control plane, the
 * connector gateway, the desktop-bridge, the orchestrator). Keep
 * this file boring: Zod schemas, exported types, no behaviour.
 */
import { z } from 'zod';

/* =========================================================================
 * Phase 0 / Phase 1 surface (preserved for backwards compatibility)
 * =======================================================================*/

/**
 * The original Phase 0 / Phase 1 `PolicyEngine` interface. It still
 * describes the *contract* every engine must implement, but the
 * Phase 2 surface adds versioned rule sets, key rotation, signed
 * capability tokens, and governance. See `PolicyEngineV2` for the
 * full Phase 2 contract; `PolicyEngine` remains the v1 surface and
 * is the type most call-sites use.
 */
export const PolicyRequestSchema = z.object({
  actor: z.object({ id: z.string().min(1) }),
  action: z.object({
    namespace: z.string().min(1),
    name: z.string().min(1),
  }),
  resource: z.object({
    type: z.string().min(1),
    id: z.string().min(1),
  }),
  context: z.record(z.unknown()).optional(),
});
export type PolicyRequest = z.infer<typeof PolicyRequestSchema>;

export interface PolicyDecision {
  allow: boolean;
  reason?: string;
  /** Identifier of the rule that produced the decision, when matched. */
  ruleId?: string;
}

export interface PolicyEngine {
  decide(request: PolicyRequest): Promise<PolicyDecision>;
}

/* =========================================================================
 * Phase 2: Cedar-like rule language
 * =======================================================================*/

const PrincipalMatchSchema = z.union([
  z.object({ type: z.literal('id'), id: z.string().min(1) }),
  z.object({ type: z.literal('prefix'), prefix: z.string().min(1) }),
  z.object({ type: z.literal('any') }),
  z.object({ type: z.literal('role'), role: z.string().min(1) }),
]);
export type PrincipalMatch = z.infer<typeof PrincipalMatchSchema>;

const ActionMatchSchema = z.union([
  z.object({ type: z.literal('exact'), namespace: z.string().min(1), name: z.string().min(1) }),
  z.object({ type: z.literal('namespace'), namespace: z.string().min(1), name: z.string().min(1).optional() }),
  z.object({ type: z.literal('any') }),
]);
export type ActionMatch = z.infer<typeof ActionMatchSchema>;

const ResourceMatchSchema = z.union([
  z.object({ type: z.literal('exact'), resourceType: z.string().min(1), id: z.string().min(1) }),
  z.object({ type: z.literal('type'), resourceType: z.string().min(1) }),
  z.object({ type: z.literal('any') }),
]);
export type ResourceMatch = z.infer<typeof ResourceMatchSchema>;

/**
 * Numeric/boolean/string conditions on the request's `context`. A
 * condition is satisfied iff every leaf expression matches. Operators
 * supported in Phase 2:
 *
 *   - `eq`, `neq`        — strict equality
 *   - `lt`, `lte`, `gt`, `gte` — numeric comparison
 *   - `in`               — membership in a literal array
 *   - `startsWith`       — string prefix
 *   - `exists`           — context key is present (any value, including null)
 */
export const ConditionSchema: z.ZodType<ConditionNode> = z.lazy(() =>
  z.union([
    z.object({ op: z.enum(['all', 'any', 'not']), children: z.array(ConditionSchema) }),
    z.object({ op: z.literal('eq'), path: z.string().min(1), value: z.union([z.string(), z.number(), z.boolean(), z.null()]) }),
    z.object({ op: z.literal('neq'), path: z.string().min(1), value: z.union([z.string(), z.number(), z.boolean(), z.null()]) }),
    z.object({ op: z.literal('lt'), path: z.string().min(1), value: z.number() }),
    z.object({ op: z.literal('lte'), path: z.string().min(1), value: z.number() }),
    z.object({ op: z.literal('gt'), path: z.string().min(1), value: z.number() }),
    z.object({ op: z.literal('gte'), path: z.string().min(1), value: z.number() }),
    z.object({ op: z.literal('in'), path: z.string().min(1), values: z.array(z.union([z.string(), z.number()])).min(1) }),
    z.object({ op: z.literal('startsWith'), path: z.string().min(1), value: z.string().min(1) }),
    z.object({ op: z.literal('exists'), path: z.string().min(1) }),
  ]),
);

export type ConditionLeaf =
  | { op: 'eq' | 'neq'; path: string; value: string | number | boolean | null }
  | { op: 'lt' | 'lte' | 'gt' | 'gte'; path: string; value: number }
  | { op: 'in'; path: string; values: Array<string | number> }
  | { op: 'startsWith'; path: string; value: string }
  | { op: 'exists'; path: string };

export type ConditionNode = { op: 'all' | 'any' | 'not'; children: ConditionNode[] } | ConditionLeaf;

export const PolicyRuleSchema = z.object({
  id: z.string().min(1),
  effect: z.enum(['ALLOW', 'DENY']),
  description: z.string().optional(),
  principal: PrincipalMatchSchema,
  action: ActionMatchSchema,
  resource: ResourceMatchSchema,
  condition: ConditionSchema.optional(),
});
export type PolicyRule = z.infer<typeof PolicyRuleSchema>;

/* =========================================================================
 * Phase 2: Capability tokens
 * =======================================================================*/

/**
 * The body of a capability token. This is the canonical, signed
 * payload. The wire form is a JSON object containing `body` (this
 * shape) and `signature` (HMAC hex over the canonical JSON of `body`).
 */
export const CapabilityTokenBodySchema = z.object({
  /** Subject — agent id, user id, or "system:<component>". */
  subject: z.string().min(1),
  /** Granted capability rules. The verifier confirms the requested
   *  action matches at least one of these. */
  capabilities: z.array(z.object({
    namespace: z.string().min(1),
    action: z.string().min(1),
    resourceType: z.string().min(1),
    /** Optional resource id; null/undefined means "any resource of this type". */
    resourceId: z.string().nullable().optional(),
    /** Optional numeric / boolean constraints. Same shape as Condition leaves. */
    constraints: z.array(ConditionSchema).optional(),
  })).min(1),
  /** RFC 3339 issuance timestamp. */
  issuedAt: z.string().datetime(),
  /** RFC 3339 expiry timestamp. */
  expiresAt: z.string().datetime(),
  /** Optional RFC 3339 not-before timestamp. */
  notBefore: z.string().datetime().optional(),
  /** Workspace this token is bound to. */
  workspaceId: z.string().min(1),
  /** Identifier of the signing key used for this token's signature. */
  keyId: z.string().min(1),
  /** Algorithm tag — currently always "hmac-sha256-v1". */
  algorithm: z.literal('hmac-sha256-v1'),
});
export type CapabilityTokenBody = z.infer<typeof CapabilityTokenBodySchema>;

export const CapabilityTokenSchema = z.object({
  body: CapabilityTokenBodySchema,
  /** Hex-encoded HMAC-SHA-256 over the canonical JSON of `body`. */
  signature: z.string().regex(/^[0-9a-f]{64}$/),
});
export type CapabilityToken = z.infer<typeof CapabilityTokenSchema>;

/* =========================================================================
 * Phase 2: Secret store primitives
 * =======================================================================*/

export const SecretPurposeSchema = z.enum([
  'capability-signing',
  'provider-credentials',
  'audit-checkpoint',
  'other',
]);
export type SecretPurpose = z.infer<typeof SecretPurposeSchema>;

export const SecretMaterialSchema = z.object({
  keyId: z.string().min(1),
  purpose: SecretPurposeSchema,
  /** Raw key bytes. */
  secret: z.instanceof(Buffer),
  /** RFC 3339 creation timestamp. */
  createdAt: z.string().datetime(),
  /** RFC 3339 activation timestamp (when the key became the active key). */
  activatedAt: z.string().datetime().nullable(),
  /** RFC 3339 retirement timestamp (when the key was rotated out of active use). */
  retiredAt: z.string().datetime().nullable(),
  /** Optional human-readable label. */
  label: z.string().optional(),
});
export type SecretMaterial = z.infer<typeof SecretMaterialSchema>;

export interface SecretStore {
  /**
   * Rotate: create a new key for the given purpose, mark it active,
   * and retire the current active key. Returns the new key id.
   */
  rotate(input: { keyId?: string; purpose: SecretPurpose; label?: string; now?: string }): SecretMaterial;
  /**
   * Import a pre-existing key. The caller supplies the keyId and the
   * secret bytes. Useful for restoring from a backup, for tests, or
   * for the first run of a workspace that already has keys.
   */
  importKey(input: { keyId: string; secret: Buffer; purpose: SecretPurpose; createdAt?: string; activatedAt?: string | null; label?: string }): SecretMaterial;
  /**
   * Get a key by id. Throws if the key id is unknown.
   */
  getKey(keyId: string): SecretMaterial;
  /**
   * Get the current active key for a purpose, or null if no key
   * exists for that purpose yet.
   */
  getActiveKey(purpose: SecretPurpose): SecretMaterial | null;
  /**
   * List every key ever created for the workspace, including retired
   * ones, in creation order.
   */
  listKeys(): ReadonlyArray<SecretMaterial>;
  /**
   * Manually mark a key as retired. Tokens signed by the key remain
   * verifiable while the key is within its grace window (the key's
   * `retiredAt` is the cut-off). Past the cut-off, the verifier
   * rejects the token.
   */
  retireKey(keyId: string, now?: string): SecretMaterial;
  /**
   * Hard-delete a key. After this, any token signed with the key
   * cannot be verified. Use only for confirmed compromise or for
   * cancelling an in-progress rotation.
   */
  forgetKey(keyId: string): void;
  /**
   * Workspace identifier the store is bound to.
   */
  readonly workspaceId: string;
  /**
   * Default grace window (ms) during which a retired key still
   * verifies. Tokens whose `issuedAt` is older than `retiredAt -
   * graceMs` are rejected outright. Tokens issued *before* the
   * retirement are also rejected once their `expiresAt` is in the
   * past, as usual.
   */
  readonly graceWindowMs: number;
}

/* =========================================================================
 * Phase 2: Policy governance
 * =======================================================================*/

export const PolicyVersionStateSchema = z.enum([
  'draft',
  'in_review',
  'approved',
  'published',
  'superseded',
  'retired',
]);
export type PolicyVersionState = z.infer<typeof PolicyVersionStateSchema>;

export const PolicyReviewDecisionSchema = z.enum([
  'request_changes',
  'approve',
  'reject',
]);
export type PolicyReviewDecision = z.infer<typeof PolicyReviewDecisionSchema>;

export const PolicyReviewSchema = z.object({
  id: z.string().min(1),
  versionId: z.string().min(1),
  reviewer: z.string().min(1),
  decision: PolicyReviewDecisionSchema,
  reason: z.string().optional(),
  createdAt: z.string().datetime(),
});
export type PolicyReview = z.infer<typeof PolicyReviewSchema>;

export const PolicyVersionSchema = z.object({
  id: z.string().min(1),
  /** Monotonically increasing version number scoped to the workspace. */
  version: z.number().int().positive(),
  state: PolicyVersionStateSchema,
  rules: z.array(PolicyRuleSchema),
  /** Free-form human note describing intent. */
  changeNote: z.string().optional(),
  /** RFC 3339 timestamp of last state change. */
  updatedAt: z.string().datetime(),
  createdAt: z.string().datetime(),
  /** Identity that drafted this version. */
  createdBy: z.string().min(1),
  /** Identity that approved this version (only set once approved). */
  approvedBy: z.string().nullable().optional(),
  /** Identity that published this version (only set once published). */
  publishedBy: z.string().nullable().optional(),
});
export type PolicyVersion = z.infer<typeof PolicyVersionSchema>;

export interface PolicyDecisionStore {
  /** Idempotent insert of a new draft. Returns the persisted version. */
  saveDraft(input: { rules: PolicyRule[]; createdBy: string; changeNote?: string }): PolicyVersion;
  /** Update an existing draft. Throws if the version is not in `draft` state. */
  updateDraft(versionId: string, patch: { rules?: PolicyRule[]; changeNote?: string }): PolicyVersion;
  /** Transition a draft to in_review. */
  submitForReview(versionId: string): PolicyVersion;
  /** Apply a review decision. May transition to approved or back to draft. */
  recordReview(versionId: string, review: { reviewer: string; decision: PolicyReviewDecision; reason?: string }): { version: PolicyVersion; review: PolicyReview };
  /** Publish an approved version. Retires the currently published version (if any). */
  publish(versionId: string, publishedBy: string): { version: PolicyVersion; previous: PolicyVersion | null };
  /** Manually retire a published version (without publishing a successor). */
  retire(versionId: string): PolicyVersion;
  /** Get a version by id. */
  getVersion(versionId: string): PolicyVersion | null;
  /** Get the currently published version, or null if no policy is published. */
  getPublished(): PolicyVersion | null;
  /** List versions, newest first. */
  listVersions(): ReadonlyArray<PolicyVersion>;
  /** List reviews for a version, oldest first. */
  listReviews(versionId: string): ReadonlyArray<PolicyReview>;
}

export interface PolicyAdministrator {
  draft(input: { rules: PolicyRule[]; createdBy: string; changeNote?: string }): PolicyVersion;
  updateDraft(versionId: string, patch: { rules?: PolicyRule[]; changeNote?: string }): PolicyVersion;
  submitForReview(versionId: string): PolicyVersion;
  review(versionId: string, input: { reviewer: string; decision: PolicyReviewDecision; reason?: string }): { version: PolicyVersion; review: PolicyReview };
  approve(versionId: string, reviewer: string, reason?: string): { version: PolicyVersion; review: PolicyReview };
  publish(versionId: string, publishedBy: string): { version: PolicyVersion; previous: PolicyVersion | null };
  retire(versionId: string): PolicyVersion;
  getPublished(): PolicyVersion | null;
  getVersion(versionId: string): PolicyVersion | null;
  listVersions(): ReadonlyArray<PolicyVersion>;
  listReviews(versionId: string): ReadonlyArray<PolicyReview>;
}

/* =========================================================================
 * Phase 2: Issuer / verifier
 * =======================================================================*/

export interface CapabilityIssuer {
  /** Mint a signed token. The `ttlMs` is required and bounded to 24h. */
  mint(input: {
    subject: string;
    capabilities: CapabilityTokenBody['capabilities'];
    ttlMs: number;
    notBefore?: Date;
    metadata?: { sessionId?: string; agentCardId?: string };
  }): CapabilityToken;
  /**
   * The active signing key id. Use this to decide whether an
   * incoming token (with its own `keyId`) is current, retiring, or
   * already retired.
   */
  currentKeyId(): string;
}

export type VerifyRejection =
  | { ok: false; code: 'token_malformed'; message: string }
  | { ok: false; code: 'token_unsupported_algorithm'; message: string }
  | { ok: false; code: 'token_unknown_key'; message: string }
  | { ok: false; code: 'token_signature_invalid'; message: string }
  | { ok: false; code: 'token_expired'; message: string }
  | { ok: false; code: 'token_not_yet_valid'; message: string }
  | { ok: false; code: 'token_scope_mismatch'; message: string }
  | { ok: false; code: 'token_workspace_mismatch'; message: string }
  | { ok: false; code: 'key_retired'; message: string }
  | { ok: false; code: 'deny'; message: string; ruleId?: string };

export type VerifyResult = { ok: true; token: CapabilityToken } | VerifyRejection;

export interface CapabilityVerifier {
  /**
   * Verify a token: parse, signature, key id, expiry, then call
   * the policy engine. The request is the action the caller is
   * attempting; the verifier answers whether the token authorises
   * it.
   */
  verify(input: {
    token: CapabilityToken;
    request: PolicyRequest;
  }): Promise<VerifyResult>;
  /**
   * Look up a token by key id — used by tests to inspect grace-window
   * behaviour. Not part of the public path; verifier verifies using
   * the token's embedded key id directly.
   */
  resolveKey(keyId: string): SecretMaterial;
}

/* =========================================================================
 * Phase 2: Engine surface
 * =======================================================================*/

export interface PolicyEngineV2 extends PolicyEngine {
  /** Replace the rule set. Used by the engine's `addRules` etc. */
  addRules(rules: PolicyRule[]): void;
  /** Drop every rule and re-install. */
  reset(rules?: PolicyRule[]): void;
  /** Inspect the current rule set (read-only). */
  currentRules(): ReadonlyArray<PolicyRule>;
  /** The policy version currently in force. */
  effectiveVersion(): { versionId: string; version: number } | null;
}
