/**
 * Tests for the policy governance workflow.
 *
 * Coverage:
 *   - draft → submitForReview → approve → publish happy path
 *   - reject returns the version to draft
 *   - request_changes returns the version to draft
 *   - publish retires the previously published version
 *   - invalid transitions raise GovernanceError
 *   - retire moves a published version to retired
 *   - the engine observes the published version after publish
 */
import { describe, expect, it } from 'vitest';
import {
  createPolicyAdministrator,
  InMemoryPolicyDecisionStore,
  type PolicyRule,
} from '../src/index.js';

function newAdmin(now: () => Date = () => new Date('2025-01-01T00:00:00.000Z')) {
  return createPolicyAdministrator({ store: new InMemoryPolicyDecisionStore({ now }), now });
}

const allowAll: PolicyRule = { id: 'allow-all', effect: 'ALLOW', principal: { type: 'any' }, action: { type: 'any' }, resource: { type: 'any' } };

describe('PolicyAdministrator — happy path', () => {
  it('draft → submitForReview → approve → publish', () => {
    const admin = newAdmin();
    const draft = admin.draft({ rules: [allowAll], createdBy: 'alice' });
    expect(draft.state).toBe('draft');
    expect(draft.version).toBe(1);

    const inReview = admin.submitForReview(draft.id);
    expect(inReview.state).toBe('in_review');

    const { version: approved, review } = admin.approve(draft.id, 'bob');
    expect(approved.state).toBe('approved');
    expect(approved.approvedBy).toBe('bob');
    expect(review.decision).toBe('approve');

    const { version: published, previous } = admin.publish(approved.id, 'admin');
    expect(published.state).toBe('published');
    expect(previous).toBeNull();
    expect(admin.getPublished()?.id).toBe(published.id);
  });

  it('publish retires the previously published version', () => {
    const admin = newAdmin();
    const d1 = admin.draft({ rules: [allowAll], createdBy: 'a' });
    admin.submitForReview(d1.id); admin.approve(d1.id, 'r'); admin.publish(d1.id, 'p');
    const d2 = admin.draft({ rules: [allowAll], createdBy: 'a' });
    admin.submitForReview(d2.id); admin.approve(d2.id, 'r');
    const { previous } = admin.publish(d2.id, 'p');
    expect(previous?.id).toBe(d1.id);
    expect(admin.getVersion(d1.id)?.state).toBe('superseded');
  });
});

describe('PolicyAdministrator — review decisions', () => {
  it('reject returns the version to draft', () => {
    const admin = newAdmin();
    const d = admin.draft({ rules: [allowAll], createdBy: 'a' });
    admin.submitForReview(d.id);
    const { version } = admin.review(d.id, { reviewer: 'r', decision: 'reject', reason: 'too broad' });
    expect(version.state).toBe('draft');
    expect(admin.listReviews(d.id)[0]?.reason).toBe('too broad');
  });

  it('request_changes returns the version to draft', () => {
    const admin = newAdmin();
    const d = admin.draft({ rules: [allowAll], createdBy: 'a' });
    admin.submitForReview(d.id);
    const { version } = admin.review(d.id, { reviewer: 'r', decision: 'request_changes', reason: 'add a deny rule' });
    expect(version.state).toBe('draft');
  });

  it('approve from in_review transitions to approved', () => {
    const admin = newAdmin();
    const d = admin.draft({ rules: [allowAll], createdBy: 'a' });
    admin.submitForReview(d.id);
    const { version } = admin.approve(d.id, 'r');
    expect(version.state).toBe('approved');
  });
});

describe('PolicyAdministrator — invalid transitions', () => {
  it('submitForReview on a non-draft version throws', () => {
    const admin = newAdmin();
    const d = admin.draft({ rules: [allowAll], createdBy: 'a' });
    admin.submitForReview(d.id);
    expect(() => admin.submitForReview(d.id)).toThrow(/state/);
  });

  it('publish an unapproved version throws', () => {
    const admin = newAdmin();
    const d = admin.draft({ rules: [allowAll], createdBy: 'a' });
    expect(() => admin.publish(d.id, 'p')).toThrow(/state/);
  });

  it('updateDraft on a non-draft version throws', () => {
    const admin = newAdmin();
    const d = admin.draft({ rules: [allowAll], createdBy: 'a' });
    admin.submitForReview(d.id);
    expect(() => admin.updateDraft(d.id, { changeNote: 'later' })).toThrow(/state/);
  });

  it('submitting a draft with no rules throws', () => {
    const admin = newAdmin();
    const d = admin.draft({ rules: [], createdBy: 'a' });
    expect(() => admin.submitForReview(d.id)).toThrow(/no rules/);
  });
});

describe('PolicyAdministrator — retire', () => {
  it('retire moves a published version to retired', () => {
    const admin = newAdmin();
    const d = admin.draft({ rules: [allowAll], createdBy: 'a' });
    admin.submitForReview(d.id); admin.approve(d.id, 'r'); admin.publish(d.id, 'p');
    const retired = admin.retire(d.id);
    expect(retired.state).toBe('retired');
    expect(admin.getPublished()).toBeNull();
  });

  it('retire on a non-published version throws', () => {
    const admin = newAdmin();
    const d = admin.draft({ rules: [allowAll], createdBy: 'a' });
    expect(() => admin.retire(d.id)).toThrow(/state/);
  });
});

describe('PolicyAdministrator — version history', () => {
  it('listVersions returns the versions newest-first', () => {
    const admin = newAdmin();
    const a = admin.draft({ rules: [allowAll], createdBy: 'a' });
    admin.submitForReview(a.id); admin.approve(a.id, 'r'); admin.publish(a.id, 'p');
    const b = admin.draft({ rules: [allowAll], createdBy: 'a' });
    const versions = admin.listVersions();
    expect(versions[0]?.id).toBe(b.id);
    expect(versions[1]?.id).toBe(a.id);
  });

  it('listReviews returns reviews in created-order', () => {
    const admin = newAdmin();
    const d = admin.draft({ rules: [allowAll], createdBy: 'a' });
    admin.submitForReview(d.id);
    admin.review(d.id, { reviewer: 'r1', decision: 'request_changes' });
    admin.submitForReview(d.id);
    admin.review(d.id, { reviewer: 'r2', decision: 'approve' });
    const reviews = admin.listReviews(d.id);
    expect(reviews).toHaveLength(2);
    expect(reviews[0]?.reviewer).toBe('r1');
    expect(reviews[1]?.reviewer).toBe('r2');
  });
});

describe('PolicyAdministrator — onChange hook', () => {
  it('emits a governance event for every transition', () => {
    const events: unknown[] = [];
    const store = new InMemoryPolicyDecisionStore();
    const admin = createPolicyAdministrator({
      store,
      onChange: (e) => events.push(e),
    });
    const d = admin.draft({ rules: [allowAll], createdBy: 'alice' });
    admin.submitForReview(d.id);
    admin.approve(d.id, 'bob');
    admin.publish(d.id, 'admin');
    const types = events.map((e) => (e as { type: string }).type);
    expect(types).toEqual(['draft', 'submit', 'review', 'publish']);
  });
});
