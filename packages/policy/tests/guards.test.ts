/**
 * Tests for the policy-guard helpers in `guards.ts`.
 *
 * The guard helpers bridge the connector gateway and desktop-bridge
 * to the policy `CapabilityVerifier`. They translate a structured
 * operation descriptor into a `PolicyRequest`, run the verifier,
 * and return a uniform decision.
 */
import { describe, expect, it } from 'vitest';
import {
  createInMemoryPolicyStack,
  guardCall,
  tokenCoversOperation,
  verifyCall,
  type OperationDescriptor,
} from '../src/index.js';

function makeDescriptor(overrides: Partial<OperationDescriptor> = {}): OperationDescriptor {
  return {
    actorId: 'agent:test',
    namespace: 'connector',
    name: 'mail.send',
    resourceType: 'connector.account',
    resourceId: 'a1',
    context: { provider: 'gmail' },
    ...overrides,
  };
}

describe('tokenCoversOperation — happy path', () => {
  it('matches when the capability covers the operation', async () => {
    const stack = createInMemoryPolicyStack({ workspaceId: 'w1' });
    // Publish a permissive policy so the issuer is happy.
    const d = stack.administrator.draft({
      rules: [{ id: 'allow', effect: 'ALLOW', principal: { type: 'any' }, action: { type: 'any' }, resource: { type: 'any' } }],
      createdBy: 's',
    });
    stack.administrator.submitForReview(d.id);
    stack.administrator.approve(d.id, 'r');
    stack.administrator.publish(d.id, 'p');
    const token = stack.issuer.mint({
      subject: 'agent:test',
      capabilities: [{ namespace: 'connector', action: 'mail.send', resourceType: 'connector.account' }],
      ttlMs: 60_000,
    });
    expect(tokenCoversOperation(token, makeDescriptor())).toBe(true);
  });

  it('rejects when the namespace does not match', async () => {
    const stack = createInMemoryPolicyStack({ workspaceId: 'w1' });
    const d = stack.administrator.draft({
      rules: [{ id: 'allow', effect: 'ALLOW', principal: { type: 'any' }, action: { type: 'any' }, resource: { type: 'any' } }],
      createdBy: 's',
    });
    stack.administrator.submitForReview(d.id);
    stack.administrator.approve(d.id, 'r');
    stack.administrator.publish(d.id, 'p');
    const token = stack.issuer.mint({
      subject: 'agent:test',
      capabilities: [{ namespace: 'desktop', action: 'click', resourceType: 'session' }],
      ttlMs: 60_000,
    });
    expect(tokenCoversOperation(token, makeDescriptor({ namespace: 'connector', name: 'mail.send' }))).toBe(false);
  });

  it('rejects when the action does not match', async () => {
    const stack = createInMemoryPolicyStack({ workspaceId: 'w1' });
    const d = stack.administrator.draft({
      rules: [{ id: 'allow', effect: 'ALLOW', principal: { type: 'any' }, action: { type: 'any' }, resource: { type: 'any' } }],
      createdBy: 's',
    });
    stack.administrator.submitForReview(d.id);
    stack.administrator.approve(d.id, 'r');
    stack.administrator.publish(d.id, 'p');
    const token = stack.issuer.mint({
      subject: 'agent:test',
      capabilities: [{ namespace: 'connector', action: 'mail.list', resourceType: 'connector.account' }],
      ttlMs: 60_000,
    });
    expect(tokenCoversOperation(token, makeDescriptor({ name: 'mail.send' }))).toBe(false);
  });

  it('rejects when the resourceType does not match', async () => {
    const stack = createInMemoryPolicyStack({ workspaceId: 'w1' });
    const d = stack.administrator.draft({
      rules: [{ id: 'allow', effect: 'ALLOW', principal: { type: 'any' }, action: { type: 'any' }, resource: { type: 'any' } }],
      createdBy: 's',
    });
    stack.administrator.submitForReview(d.id);
    stack.administrator.approve(d.id, 'r');
    stack.administrator.publish(d.id, 'p');
    const token = stack.issuer.mint({
      subject: 'agent:test',
      capabilities: [{ namespace: 'connector', action: 'mail.send', resourceType: 'session' }],
      ttlMs: 60_000,
    });
    expect(tokenCoversOperation(token, makeDescriptor({ resourceType: 'connector.account' }))).toBe(false);
  });

  it('respects a wildcard resourceId (null) for any resourceId', async () => {
    const stack = createInMemoryPolicyStack({ workspaceId: 'w1' });
    const d = stack.administrator.draft({
      rules: [{ id: 'allow', effect: 'ALLOW', principal: { type: 'any' }, action: { type: 'any' }, resource: { type: 'any' } }],
      createdBy: 's',
    });
    stack.administrator.submitForReview(d.id);
    stack.administrator.approve(d.id, 'r');
    stack.administrator.publish(d.id, 'p');
    const token = stack.issuer.mint({
      subject: 'agent:test',
      capabilities: [{ namespace: 'connector', action: 'mail.send', resourceType: 'connector.account', resourceId: null }],
      ttlMs: 60_000,
    });
    expect(tokenCoversOperation(token, makeDescriptor({ resourceId: 'any-account' }))).toBe(true);
  });

  it('rejects when the resourceId does not match a specific capability', async () => {
    const stack = createInMemoryPolicyStack({ workspaceId: 'w1' });
    const d = stack.administrator.draft({
      rules: [{ id: 'allow', effect: 'ALLOW', principal: { type: 'any' }, action: { type: 'any' }, resource: { type: 'any' } }],
      createdBy: 's',
    });
    stack.administrator.submitForReview(d.id);
    stack.administrator.approve(d.id, 'r');
    stack.administrator.publish(d.id, 'p');
    const token = stack.issuer.mint({
      subject: 'agent:test',
      capabilities: [{ namespace: 'connector', action: 'mail.send', resourceType: 'connector.account', resourceId: 'a1' }],
      ttlMs: 60_000,
    });
    expect(tokenCoversOperation(token, makeDescriptor({ resourceId: 'a2' }))).toBe(false);
  });

  it('rejects an expired token even if the capability covers the operation', async () => {
    const stack = createInMemoryPolicyStack({ workspaceId: 'w1' });
    const d = stack.administrator.draft({
      rules: [{ id: 'allow', effect: 'ALLOW', principal: { type: 'any' }, action: { type: 'any' }, resource: { type: 'any' } }],
      createdBy: 's',
    });
    stack.administrator.submitForReview(d.id);
    stack.administrator.approve(d.id, 'r');
    stack.administrator.publish(d.id, 'p');
    const token = stack.issuer.mint({
      subject: 'agent:test',
      capabilities: [{ namespace: 'connector', action: 'mail.send', resourceType: 'connector.account' }],
      ttlMs: 60_000,
    });
    // Force expiry by mutating the body's expiresAt to the past.
    const expired = { ...token, body: { ...token.body, expiresAt: new Date(Date.now() - 1000).toISOString() } };
    expect(tokenCoversOperation(expired, makeDescriptor())).toBe(false);
  });
});

describe('verifyCall — full pipeline', () => {
  it('returns ok when the token verifies and the policy allows', async () => {
    const stack = createInMemoryPolicyStack({ workspaceId: 'w1' });
    const d = stack.administrator.draft({
      rules: [{ id: 'allow', effect: 'ALLOW', principal: { type: 'any' }, action: { type: 'any' }, resource: { type: 'any' } }],
      createdBy: 's',
    });
    stack.administrator.submitForReview(d.id);
    stack.administrator.approve(d.id, 'r');
    stack.administrator.publish(d.id, 'p');
    const token = stack.issuer.mint({
      subject: 'agent:test',
      capabilities: [{ namespace: 'connector', action: 'mail.send', resourceType: 'connector.account' }],
      ttlMs: 60_000,
    });
    const r = await verifyCall(stack.verifier, token, makeDescriptor());
    expect(r.ok).toBe(true);
  });

  it('returns a denial when the policy engine denies', async () => {
    const stack = createInMemoryPolicyStack({ workspaceId: 'w1' });
    const d = stack.administrator.draft({
      rules: [{ id: 'deny', effect: 'DENY', principal: { type: 'any' }, action: { type: 'any' }, resource: { type: 'any' } }],
      createdBy: 's',
    });
    stack.administrator.submitForReview(d.id);
    stack.administrator.approve(d.id, 'r');
    stack.administrator.publish(d.id, 'p');
    const token = stack.issuer.mint({
      subject: 'agent:test',
      capabilities: [{ namespace: 'connector', action: 'mail.send', resourceType: 'connector.account' }],
      ttlMs: 60_000,
    });
    const r = await verifyCall(stack.verifier, token, makeDescriptor());
    expect(r.ok).toBe(false);
  });
});

describe('guardCall — composed check', () => {
  it('rejects with token_scope_mismatch when the token does not cover the operation', async () => {
    const stack = createInMemoryPolicyStack({ workspaceId: 'w1' });
    const token = stack.issuer.mint({
      subject: 'a',
      capabilities: [{ namespace: 'connector', action: 'mail.list', resourceType: 'connector.account' }],
      ttlMs: 60_000,
    });
    const r = await guardCall(stack.verifier, token, makeDescriptor({ name: 'mail.send' }));
    expect(r.allow).toBe(false);
    if (!r.allow) expect(r.code).toBe('token_scope_mismatch');
  });

  it('returns allow when the token covers the operation and the policy allows', async () => {
    const stack = createInMemoryPolicyStack({ workspaceId: 'w1' });
    const d = stack.administrator.draft({
      rules: [{ id: 'allow', effect: 'ALLOW', principal: { type: 'any' }, action: { type: 'any' }, resource: { type: 'any' } }],
      createdBy: 's',
    });
    stack.administrator.submitForReview(d.id);
    stack.administrator.approve(d.id, 'r');
    stack.administrator.publish(d.id, 'p');
    const token = stack.issuer.mint({
      subject: 'a',
      capabilities: [{ namespace: 'connector', action: 'mail.send', resourceType: 'connector.account' }],
      ttlMs: 60_000,
    });
    const r = await guardCall(stack.verifier, token, makeDescriptor());
    expect(r.allow).toBe(true);
  });

  it('returns deny when the policy engine rejects', async () => {
    const stack = createInMemoryPolicyStack({ workspaceId: 'w1' });
    const d = stack.administrator.draft({
      rules: [{ id: 'deny', effect: 'DENY', principal: { type: 'any' }, action: { type: 'any' }, resource: { type: 'any' } }],
      createdBy: 's',
    });
    stack.administrator.submitForReview(d.id);
    stack.administrator.approve(d.id, 'r');
    stack.administrator.publish(d.id, 'p');
    const token = stack.issuer.mint({
      subject: 'a',
      capabilities: [{ namespace: 'connector', action: 'mail.send', resourceType: 'connector.account' }],
      ttlMs: 60_000,
    });
    const r = await guardCall(stack.verifier, token, makeDescriptor());
    expect(r.allow).toBe(false);
    if (!r.allow) expect(r.code).toBe('deny');
  });
});
