/**
 * @fagaos/policy — Policy Engine adapter (Cedar, deferred to Phase 1).
 *
 * The policy engine mints capability tokens and answers "may agent X do
 * action Y to resource Z?" queries. It is the single authority for
 * authorisation. Agents cannot modify policy; the FagaOS architecture
 * treats that as a hard invariant.
 *
 * Phase 0 (FAG-8) ships the interface only. Phase 1 will bind to Cedar.
 */

export interface PolicyRequest {
  actor: { id: string };
  action: { namespace: string; name: string };
  resource: { type: string; id: string };
  context?: Record<string, unknown>;
}

export interface PolicyDecision {
  allow: boolean;
  reason?: string;
}

export interface PolicyEngine {
  decide(request: PolicyRequest): Promise<PolicyDecision>;
}

export const POLICY_ENGINE_NOT_IMPLEMENTED =
  'Policy engine binding lands in Phase 1 (Cedar). Phase 0 ships the interface only.';
