/**
 * In-memory policy decision store.
 *
 * The store is the durable boundary the policy engine and the
 * administrator read from. The in-memory implementation is the
 * local-dev default. A SQLite or Postgres adapter slots in via
 * the `PolicyDecisionStore` interface; the engine and administrator
 * do not change.
 *
 * Versioning
 * ──────────
 *   - Every version is a snapshot of the rule set + governance
 *     metadata (state, reviewers, approval, publication).
 *   - Versions form a linked list: when a new version is published,
 *     the previous published version is moved to `superseded`.
 *   - `publishedVersion` always points to the live one.
 *
 * Concurrency
 * ───────────
 *   The in-memory implementation is single-process and uses
 *   synchronised internal state. A multi-process deployment needs
 *   a different backend (the same caveat as the audit log).
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  PolicyReviewSchema,
  PolicyVersionSchema,
  type PolicyDecisionStore,
  type PolicyReview,
  type PolicyReviewDecision,
  type PolicyRule,
  type PolicyVersion,
  type PolicyVersionState,
} from './types.js';
import { GovernanceError, PolicyError } from './errors.js';

export interface InMemoryPolicyDecisionStoreOptions {
  now?: () => Date;
  /** Initial published version, if any. Used by tests for seed data. */
  seedPublished?: PolicyVersion;
}

const STORAGE_VERSION = 1;

export class InMemoryPolicyDecisionStore implements PolicyDecisionStore {
  private readonly now: () => Date;
  private versions: PolicyVersion[] = [];
  private reviews: PolicyReview[] = [];
  private publishedId: string | null = null;
  private nextVersion = 1;

  constructor(opts: InMemoryPolicyDecisionStoreOptions = {}) {
    this.now = opts.now ?? (() => new Date());
    if (opts.seedPublished) {
      const validated = PolicyVersionSchema.parse(opts.seedPublished);
      this.versions.push(validated);
      this.publishedId = validated.id;
      this.nextVersion = Math.max(this.nextVersion, validated.version + 1);
    }
  }

  /* ----------------------- Read surface ----------------------------- */

  getVersion(versionId: string): PolicyVersion | null {
    const v = this.versions.find((x) => x.id === versionId);
    return v ? cloneVersion(v) : null;
  }

  getPublished(): PolicyVersion | null {
    if (!this.publishedId) return null;
    return this.getVersion(this.publishedId);
  }

  listVersions(): ReadonlyArray<PolicyVersion> {
    return [...this.versions]
      .sort((a, b) => b.version - a.version)
      .map(cloneVersion);
  }

  listReviews(versionId: string): ReadonlyArray<PolicyReview> {
    return this.reviews
      .filter((r) => r.versionId === versionId)
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
      .map(cloneReview);
  }

  /* ----------------------- Write surface ---------------------------- */

  saveDraft(input: { rules: PolicyRule[]; createdBy: string; changeNote?: string }): PolicyVersion {
    const ts = this.now().toISOString();
    const version: PolicyVersion = PolicyVersionSchema.parse({
      id: `pol_${randomUUID()}`,
      version: this.nextVersion++,
      state: 'draft',
      rules: input.rules,
      ...(input.changeNote !== undefined ? { changeNote: input.changeNote } : {}),
      updatedAt: ts,
      createdAt: ts,
      createdBy: input.createdBy,
    });
    this.versions.push(version);
    return cloneVersion(version);
  }

  updateDraft(versionId: string, patch: { rules?: PolicyRule[]; changeNote?: string }): PolicyVersion {
    const v = this.requireVersion(versionId);
    if (v.state !== 'draft') {
      throw new GovernanceError('governance_version_not_in_state', `version "${versionId}" is in state "${v.state}"; only drafts can be updated`, {
        versionId,
        state: v.state,
      });
    }
    const next: PolicyVersion = PolicyVersionSchema.parse({
      ...v,
      rules: patch.rules ?? v.rules,
      ...(patch.changeNote !== undefined ? { changeNote: patch.changeNote } : {}),
      updatedAt: this.now().toISOString(),
    });
    this.replaceVersion(next);
    return cloneVersion(next);
  }

  submitForReview(versionId: string): PolicyVersion {
    const v = this.requireVersion(versionId);
    if (v.state !== 'draft') {
      throw new GovernanceError('governance_invalid_transition', `version "${versionId}" is in state "${v.state}"; only drafts can be submitted for review`, {
        versionId,
        state: v.state,
      });
    }
    if (v.rules.length === 0) {
      throw new GovernanceError('governance_invalid_transition', `version "${versionId}" has no rules and cannot be submitted for review`, {
        versionId,
      });
    }
    const next = transitionTo(v, 'in_review', this.now().toISOString());
    this.replaceVersion(next);
    return cloneVersion(next);
  }

  recordReview(versionId: string, review: { reviewer: string; decision: PolicyReviewDecision; reason?: string }): { version: PolicyVersion; review: PolicyReview } {
    const v = this.requireVersion(versionId);
    if (!['draft', 'in_review'].includes(v.state)) {
      throw new GovernanceError('governance_version_not_in_state', `version "${versionId}" is in state "${v.state}"; only drafts or in_review versions accept reviews`, {
        versionId,
        state: v.state,
      });
    }
    const persisted: PolicyReview = PolicyReviewSchema.parse({
      id: `rev_${randomUUID()}`,
      versionId,
      reviewer: review.reviewer,
      decision: review.decision,
      ...(review.reason !== undefined ? { reason: review.reason } : {}),
      createdAt: this.now().toISOString(),
    });
    this.reviews.push(persisted);
    let next: PolicyVersion = v;
    if (review.decision === 'approve') {
      next = transitionTo(v, 'approved', this.now().toISOString(), { approvedBy: review.reviewer });
    } else if (review.decision === 'reject') {
      // Rejected: back to draft so the author can iterate.
      next = transitionTo(v, 'draft', this.now().toISOString());
    } else if (review.decision === 'request_changes') {
      // request_changes returns to draft for revisions.
      next = transitionTo(v, 'draft', this.now().toISOString());
    }
    this.replaceVersion(next);
    return { version: cloneVersion(next), review: cloneReview(persisted) };
  }

  publish(versionId: string, publishedBy: string): { version: PolicyVersion; previous: PolicyVersion | null } {
    const v = this.requireVersion(versionId);
    if (v.state !== 'approved') {
      throw new GovernanceError('governance_version_not_in_state', `version "${versionId}" is in state "${v.state}"; only approved versions can be published`, {
        versionId,
        state: v.state,
      });
    }
    const previous = this.publishedId ? this.versions.find((x) => x.id === this.publishedId) ?? null : null;
    if (previous) {
      const retired = transitionTo(previous, 'superseded', this.now().toISOString());
      this.replaceVersion(retired);
    }
    const published = transitionTo(v, 'published', this.now().toISOString(), { publishedBy });
    this.replaceVersion(published);
    this.publishedId = published.id;
    return { version: cloneVersion(published), previous: previous ? cloneVersion(previous) : null };
  }

  retire(versionId: string): PolicyVersion {
    const v = this.requireVersion(versionId);
    if (v.state !== 'published') {
      throw new GovernanceError('governance_version_not_in_state', `version "${versionId}" is in state "${v.state}"; only published versions can be retired`, {
        versionId,
        state: v.state,
      });
    }
    const next = transitionTo(v, 'retired', this.now().toISOString());
    this.replaceVersion(next);
    if (this.publishedId === versionId) this.publishedId = null;
    return cloneVersion(next);
  }

  /* ---------------------- Internal helpers -------------------------- */

  private requireVersion(versionId: string): PolicyVersion {
    const v = this.versions.find((x) => x.id === versionId);
    if (!v) {
      throw new GovernanceError('governance_version_not_found', `no policy version with id "${versionId}"`, { versionId });
    }
    return v;
  }

  private replaceVersion(next: PolicyVersion): void {
    const idx = this.versions.findIndex((x) => x.id === next.id);
    if (idx < 0) {
      this.versions.push(next);
    } else {
      this.versions[idx] = next;
    }
  }
}

function transitionTo(
  v: PolicyVersion,
  state: PolicyVersionState,
  updatedAt: string,
  patch: { approvedBy?: string; publishedBy?: string } = {},
): PolicyVersion {
  return PolicyVersionSchema.parse({
    ...v,
    state,
    updatedAt,
    ...(patch.approvedBy !== undefined ? { approvedBy: patch.approvedBy } : {}),
    ...(patch.publishedBy !== undefined ? { publishedBy: patch.publishedBy } : {}),
  });
}

function cloneVersion(v: PolicyVersion): PolicyVersion {
  return {
    ...v,
    rules: v.rules.map((r) => ({ ...r })),
  };
}

function cloneReview(r: PolicyReview): PolicyReview {
  return { ...r };
}

/* ---------------------- Persistent snapshot ------------------------ */

/**
 * Snapshot/load helpers for the in-memory store. Used by tests to
 * persist the policy state to disk between runs. The file format
 * is the same JSON shape the SQLite/Postgres adapters will use.
 */
export const PolicyStoreSnapshotSchema = z.object({
  version: z.literal(STORAGE_VERSION),
  versions: z.array(PolicyVersionSchema),
  reviews: z.array(PolicyReviewSchema),
  publishedId: z.string().nullable(),
  nextVersion: z.number().int().positive(),
});
export type PolicyStoreSnapshot = z.infer<typeof PolicyStoreSnapshotSchema>;

export function snapshotPolicyStore(store: InMemoryPolicyDecisionStore): PolicyStoreSnapshot {
  // The store's internal fields are private; this helper exposes
  // them via a public read API. The cast is safe because the in-memory
  // implementation is the only thing that can be snapshotted here.
  const internal = store as unknown as {
    versions: PolicyVersion[];
    reviews: PolicyReview[];
    publishedId: string | null;
    nextVersion: number;
  };
  return {
    version: STORAGE_VERSION,
    versions: internal.versions.map(cloneVersion),
    reviews: internal.reviews.map(cloneReview),
    publishedId: internal.publishedId,
    nextVersion: internal.nextVersion,
  };
}

export function loadPolicyStoreSnapshot(snap: PolicyStoreSnapshot): InMemoryPolicyDecisionStore {
  const store = new InMemoryPolicyDecisionStore();
  const internal = store as unknown as {
    versions: PolicyVersion[];
    reviews: PolicyReview[];
    publishedId: string | null;
    nextVersion: number;
  };
  internal.versions = snap.versions.map(cloneVersion);
  internal.reviews = snap.reviews.map(cloneReview);
  internal.publishedId = snap.publishedId;
  internal.nextVersion = snap.nextVersion;
  return store;
}

/* Suppress unused-import for the PolicyError re-export gate. */
export { PolicyError };
