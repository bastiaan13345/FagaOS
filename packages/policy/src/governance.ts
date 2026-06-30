/**
 * Policy administration.
 *
 * The administrator wraps the `PolicyDecisionStore` with the
 * lifecycle operations an admin UI / API would call:
 *
 *   draft(...)                — create a new version in `draft` state
 *   updateDraft(...)          — patch the rules / change-note on a draft
 *   submitForReview(...)      — move a draft to `in_review`
 *   review(...)               — record a reviewer's decision
 *   approve(...)              — convenience wrapper for review(approve)
 *   publish(...)              — promote an approved version to live;
 *                              retires the previously published one
 *   retire(...)               — manually retire a published version
 *
 * Every transition validates that the version is in the right state
 * for the operation; invalid transitions raise `GovernanceError`.
 *
 * The administrator is the consumer-facing facade; the engine and the
 * issuer/verifier do not depend on it. The engine watches
 * `store.getPublished()` at construction time and on every read, so
 * a publish() call is observed by the next decide() call.
 */
import { z } from 'zod';
import {
  type PolicyAdministrator,
  type PolicyDecisionStore,
  type PolicyReview,
  type PolicyReviewDecision,
  type PolicyRule,
  type PolicyVersion,
} from './types.js';

export interface PolicyAdministratorOptions {
  store: PolicyDecisionStore;
  now?: () => Date;
  /**
   * Optional sink called after every state change. Useful for
   * emitting audit entries. The default is a no-op.
   */
  onChange?: (event: GovernanceEvent) => void;
}

export const GovernanceEventSchema = z.object({
  type: z.enum(['draft', 'update', 'submit', 'review', 'publish', 'retire']),
  versionId: z.string().min(1),
  version: z.number().int().positive(),
  actor: z.string().min(1),
  at: z.string().datetime(),
  decision: z.enum(['approve', 'reject', 'request_changes']).optional(),
});
export type GovernanceEvent = z.infer<typeof GovernanceEventSchema>;

export function createPolicyAdministrator(opts: PolicyAdministratorOptions): PolicyAdministrator {
  const now = opts.now ?? (() => new Date());
  const emit = opts.onChange
    ? (event: Omit<GovernanceEvent, 'at'>) => opts.onChange!({ ...event, at: now().toISOString() })
    : (_event: Omit<GovernanceEvent, 'at'>) => undefined;

  return {
    draft(input) {
      const v = opts.store.saveDraft(input);
      emit({ type: 'draft', versionId: v.id, version: v.version, actor: input.createdBy });
      return v;
    },
    updateDraft(versionId, patch) {
      const v = opts.store.updateDraft(versionId, patch);
      // The updatedBy is not part of the patch surface; the API layer
      // tracks it via the audit/observability hook. Emit a generic
      // event so the sink has *something* to record.
      emit({ type: 'update', versionId: v.id, version: v.version, actor: 'system' });
      return v;
    },
    submitForReview(versionId) {
      const v = opts.store.submitForReview(versionId);
      emit({ type: 'submit', versionId: v.id, version: v.version, actor: 'system' });
      return v;
    },
    review(versionId, input) {
      const r = opts.store.recordReview(versionId, input);
      emit({ type: 'review', versionId: r.version.id, version: r.version.version, actor: input.reviewer, decision: input.decision });
      return r;
    },
    approve(versionId, reviewer, reason) {
      const r = opts.store.recordReview(versionId, { reviewer, decision: 'approve', ...(reason !== undefined ? { reason } : {}) });
      emit({ type: 'review', versionId: r.version.id, version: r.version.version, actor: reviewer, decision: 'approve' });
      return r;
    },
    publish(versionId, publishedBy) {
      const r = opts.store.publish(versionId, publishedBy);
      emit({ type: 'publish', versionId: r.version.id, version: r.version.version, actor: publishedBy });
      return r;
    },
    retire(versionId) {
      const v = opts.store.retire(versionId);
      emit({ type: 'retire', versionId: v.id, version: v.version, actor: 'system' });
      return v;
    },
    getPublished() {
      return opts.store.getPublished();
    },
    getVersion(versionId) {
      return opts.store.getVersion(versionId);
    },
    listVersions() {
      return opts.store.listVersions();
    },
    listReviews(versionId) {
      return opts.store.listReviews(versionId);
    },
  };
}

/* Re-exports for downstream consumers. */
export type { PolicyReview, PolicyReviewDecision, PolicyRule, PolicyVersion };
