/**
 * Tests for capability token mint/verify, including key rotation,
 * stale-key rejection, and policy-driven denial.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  createInMemoryPolicyStack,
  type FagaosPolicyStack,
} from '../src/index.js';

const ONE_HOUR = 60 * 60 * 1000;
let stack: FagaosPolicyStack;
let currentTime = new Date('2025-01-01T00:00:00.000Z');
function clock() { return currentTime; }

beforeEach(() => {
  currentTime = new Date('2025-01-01T00:00:00.000Z');
  stack = createInMemoryPolicyStack({
    workspaceId: 'w1',
    now: clock,
    secretStoreOptions: { graceWindowMs: ONE_HOUR },
  });
});

afterEach(() => {
  // No explicit teardown; each test rebuilds.
});

describe('CapabilityIssuer — happy path', () => {
  it('mints a token signed with the current key id', () => {
    const token = stack.issuer.mint({
      subject: 'agent:test',
      capabilities: [{ namespace: 'connector', action: 'mail.send', resourceType: 'connector.account', resourceId: 'a1' }],
      ttlMs: 60_000,
    });
    expect(token.body.algorithm).toBe('hmac-sha256-v1');
    expect(token.body.workspaceId).toBe('w1');
    expect(token.signature).toMatch(/^[0-9a-f]{64}$/);
    expect(token.body.keyId).toBe(stack.issuer.currentKeyId());
  });

  it('rejects ttlMs <= 0', () => {
    expect(() => stack.issuer.mint({
      subject: 'a',
      capabilities: [{ namespace: 'x', action: 'y', resourceType: 't' }],
      ttlMs: 0,
    })).toThrow(/ttlMs must be positive/);
  });

  it('rejects ttlMs above the issuer cap', () => {
    expect(() => stack.issuer.mint({
      subject: 'a',
      capabilities: [{ namespace: 'x', action: 'y', resourceType: 't' }],
      ttlMs: 25 * 60 * 60 * 1000,
    })).toThrow(/cap/);
  });

  it('rejects an empty capability list', () => {
    expect(() => stack.issuer.mint({ subject: 'a', capabilities: [], ttlMs: 1000 })).toThrow(/at least one/);
  });
});

describe('CapabilityVerifier — happy path', () => {
  it('verifies a freshly minted token when policy allows', async () => {
    // Publish an allow-all policy so the verifier's policy check passes.
    const draft = stack.administrator.draft({
      rules: [
        { id: 'allow-all', effect: 'ALLOW', principal: { type: 'any' }, action: { type: 'any' }, resource: { type: 'any' } },
      ],
      createdBy: 'system',
    });
    stack.administrator.submitForReview(draft.id);
    stack.administrator.approve(draft.id, 'reviewer');
    stack.administrator.publish(draft.id, 'admin');

    const token = stack.issuer.mint({
      subject: 'agent:test',
      capabilities: [{ namespace: 'connector', action: 'mail.send', resourceType: 'connector.account', resourceId: 'a1' }],
      ttlMs: 60_000,
    });
    const r = await stack.verifier.verify({
      token,
      request: {
        actor: { id: 'agent:test' },
        action: { namespace: 'connector', name: 'mail.send' },
        resource: { type: 'connector.account', id: 'a1' },
      },
    });
    expect(r.ok).toBe(true);
  });
});

describe('CapabilityVerifier — rejection paths', () => {
  it('rejects a malformed token', async () => {
    const r = await stack.verifier.verify({
      token: { body: { subject: 'a', capabilities: [], issuedAt: '2025-01-01T00:00:00.000Z', expiresAt: '2025-01-01T00:00:00.000Z', workspaceId: 'w1', keyId: 'k', algorithm: 'hmac-sha256-v1' }, signature: '00'.repeat(32) } as never,
      request: { actor: { id: 'a' }, action: { namespace: 'x', name: 'y' }, resource: { type: 't', id: 'i' } },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('token_malformed');
  });

  it('rejects an unknown signing key', async () => {
    const token = stack.issuer.mint({
      subject: 'agent:test',
      capabilities: [{ namespace: 'connector', action: 'mail.send', resourceType: 'connector.account' }],
      ttlMs: 60_000,
    });
    // Forget the key from the store; the verifier no longer knows about it.
    stack.secretStore.forgetKey(token.body.keyId);
    const r = await stack.verifier.verify({
      token,
      request: { actor: { id: 'a' }, action: { namespace: 'connector', name: 'mail.send' }, resource: { type: 'connector.account', id: 'a1' } },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('token_unknown_key');
  });

  it('rejects a token whose signature was tampered with', async () => {
    const token = stack.issuer.mint({
      subject: 'agent:test',
      capabilities: [{ namespace: 'connector', action: 'mail.send', resourceType: 'connector.account' }],
      ttlMs: 60_000,
    });
    // Flip a hex nibble in the signature.
    const tampered = { ...token, signature: 'ff'.repeat(32) };
    const r = await stack.verifier.verify({
      token: tampered,
      request: { actor: { id: 'a' }, action: { namespace: 'connector', name: 'mail.send' }, resource: { type: 'connector.account', id: 'a1' } },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('token_signature_invalid');
  });

  it('rejects an expired token', async () => {
    const token = stack.issuer.mint({
      subject: 'agent:test',
      capabilities: [{ namespace: 'connector', action: 'mail.send', resourceType: 'connector.account' }],
      ttlMs: 60_000,
    });
    // Advance 2 minutes.
    currentTime = new Date(currentTime.getTime() + 2 * 60_000);
    const r = await stack.verifier.verify({
      token,
      request: { actor: { id: 'a' }, action: { namespace: 'connector', name: 'mail.send' }, resource: { type: 'connector.account', id: 'a1' } },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('token_expired');
  });

  it('rejects a token with a notBefore in the future', async () => {
    const future = new Date(currentTime.getTime() + 60_000);
    const token = stack.issuer.mint({
      subject: 'agent:test',
      capabilities: [{ namespace: 'connector', action: 'mail.send', resourceType: 'connector.account' }],
      ttlMs: 5 * 60_000,
      notBefore: future,
    });
    const r = await stack.verifier.verify({
      token,
      request: { actor: { id: 'a' }, action: { namespace: 'connector', name: 'mail.send' }, resource: { type: 'connector.account', id: 'a1' } },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('token_not_yet_valid');
  });

  it('rejects when the token scope does not cover the request', async () => {
    const token = stack.issuer.mint({
      subject: 'agent:test',
      capabilities: [{ namespace: 'connector', action: 'mail.list', resourceType: 'connector.account' }],
      ttlMs: 60_000,
    });
    const r = await stack.verifier.verify({
      token,
      request: { actor: { id: 'a' }, action: { namespace: 'connector', name: 'mail.send' }, resource: { type: 'connector.account', id: 'a1' } },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('token_scope_mismatch');
  });

  it('rejects when the policy engine denies the request', async () => {
    // Publish a DENY-all policy.
    const draft = stack.administrator.draft({
      rules: [
        { id: 'deny-all', effect: 'DENY', principal: { type: 'any' }, action: { type: 'any' }, resource: { type: 'any' } },
      ],
      createdBy: 'system',
    });
    stack.administrator.submitForReview(draft.id);
    stack.administrator.approve(draft.id, 'reviewer');
    stack.administrator.publish(draft.id, 'admin');

    const token = stack.issuer.mint({
      subject: 'agent:test',
      capabilities: [{ namespace: 'connector', action: 'mail.send', resourceType: 'connector.account' }],
      ttlMs: 60_000,
    });
    const r = await stack.verifier.verify({
      token,
      request: { actor: { id: 'a' }, action: { namespace: 'connector', name: 'mail.send' }, resource: { type: 'connector.account', id: 'a1' } },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('deny');
  });

  it('rejects when the token is for a different workspace', async () => {
    const other = createInMemoryPolicyStack({ workspaceId: 'w2', now: clock });
    const token = other.issuer.mint({
      subject: 'a',
      capabilities: [{ namespace: 'x', action: 'y', resourceType: 't' }],
      ttlMs: 60_000,
    });
    const r = await stack.verifier.verify({
      token,
      request: { actor: { id: 'a' }, action: { namespace: 'x', name: 'y' }, resource: { type: 't', id: 'i' } },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('token_workspace_mismatch');
  });
});

describe('CapabilityVerifier — key rotation', () => {
  it('a token signed by the previous key still verifies during the grace window', async () => {
    const token = stack.issuer.mint({
      subject: 'agent:test',
      capabilities: [{ namespace: 'connector', action: 'mail.send', resourceType: 'connector.account' }],
      ttlMs: 60_000,
    });
    // Rotate; the previous key is now retired but within the grace window.
    stack.secretStore.rotate({ purpose: 'capability-signing' });
    // Mint a fresh token with the new key so the engine has an allow rule.
    const fresh = stack.issuer.mint({
      subject: 'agent:test',
      capabilities: [{ namespace: 'connector', action: 'mail.send', resourceType: 'connector.account' }],
      ttlMs: 60_000,
    });
    // The old token should still verify (it was signed during the
    // active window and the key is still within its grace period).
    // The policy is empty (no allow) so the engine will deny. We
    // can't directly test grace here without a policy. Instead,
    // publish an allow rule and re-test.
    const draft = stack.administrator.draft({
      rules: [
        { id: 'allow', effect: 'ALLOW', principal: { type: 'any' }, action: { type: 'any' }, resource: { type: 'any' } },
      ],
      createdBy: 's',
    });
    stack.administrator.submitForReview(draft.id);
    stack.administrator.approve(draft.id, 'r');
    stack.administrator.publish(draft.id, 'p');
    const r2 = await stack.verifier.verify({
      token,
      request: { actor: { id: 'a' }, action: { namespace: 'connector', name: 'mail.send' }, resource: { type: 'connector.account', id: 'a1' } },
    });
    expect(r2.ok).toBe(true);
    void fresh;
  });

  it('rejects a token signed by a key past the grace window', async () => {
    const token = stack.issuer.mint({
      subject: 'agent:test',
      capabilities: [{ namespace: 'connector', action: 'mail.send', resourceType: 'connector.account' }],
      // 4h TTL so the token is still valid by expiry even after we
      // advance the clock by 2h to test the key-grace-window path.
      ttlMs: 4 * 60 * 60 * 1000,
    });
    // Rotate; previous key is retired.
    stack.secretStore.rotate({ purpose: 'capability-signing' });
    // Advance 2 hours past the 1h grace window.
    currentTime = new Date(currentTime.getTime() + 2 * 60 * 60 * 1000);
    const r = await stack.verifier.verify({
      token,
      request: { actor: { id: 'a' }, action: { namespace: 'connector', name: 'mail.send' }, resource: { type: 'connector.account', id: 'a1' } },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('key_retired');
  });

  it('a freshly minted token with the new key verifies after rotation', async () => {
    // Publish an allow rule.
    const draft = stack.administrator.draft({
      rules: [
        { id: 'allow', effect: 'ALLOW', principal: { type: 'any' }, action: { type: 'any' }, resource: { type: 'any' } },
      ],
      createdBy: 's',
    });
    stack.administrator.submitForReview(draft.id);
    stack.administrator.approve(draft.id, 'r');
    stack.administrator.publish(draft.id, 'p');
    // Rotate.
    stack.secretStore.rotate({ purpose: 'capability-signing' });
    const token = stack.issuer.mint({
      subject: 'a',
      capabilities: [{ namespace: 'connector', action: 'mail.send', resourceType: 'connector.account' }],
      ttlMs: 60_000,
    });
    const r = await stack.verifier.verify({
      token,
      request: { actor: { id: 'a' }, action: { namespace: 'connector', name: 'mail.send' }, resource: { type: 'connector.account', id: 'a1' } },
    });
    expect(r.ok).toBe(true);
  });
});

describe('CapabilityVerifier — token import resilience', () => {
  it('a stack can be reconstructed from a seed key and still verify', async () => {
    // Use a fixed-key stack so we can read the secret bytes back out
    // and replay them in a fresh store.
    const keyBytes = randomBytes(32);
    const keyId = 'seed-key-1';
    const seeded = createInMemoryPolicyStack({
      workspaceId: 'w1',
      now: clock,
      seedKeys: [{ keyId, secret: keyBytes, createdAt: currentTime.toISOString() }],
    });
    // Publish an allow rule.
    const draft = seeded.administrator.draft({
      rules: [{ id: 'allow', effect: 'ALLOW', principal: { type: 'any' }, action: { type: 'any' }, resource: { type: 'any' } }],
      createdBy: 's',
    });
    seeded.administrator.submitForReview(draft.id);
    seeded.administrator.approve(draft.id, 'r');
    seeded.administrator.publish(draft.id, 'p');
    const token = seeded.issuer.mint({
      subject: 'a',
      capabilities: [{ namespace: 'x', action: 'y', resourceType: 't' }],
      ttlMs: 60_000,
    });
    // Now construct a second stack with the *same* key bytes.
    const other = createInMemoryPolicyStack({
      workspaceId: 'w1',
      now: clock,
      seedKeys: [{ keyId, secret: keyBytes, createdAt: currentTime.toISOString() }],
    });
    // Publish the same allow rule.
    const draft2 = other.administrator.draft({
      rules: [{ id: 'allow', effect: 'ALLOW', principal: { type: 'any' }, action: { type: 'any' }, resource: { type: 'any' } }],
      createdBy: 's',
    });
    other.administrator.submitForReview(draft2.id);
    other.administrator.approve(draft2.id, 'r');
    other.administrator.publish(draft2.id, 'p');
    const r = await other.verifier.verify({
      token,
      request: { actor: { id: 'a' }, action: { namespace: 'x', name: 'y' }, resource: { type: 't', id: 'i' } },
    });
    expect(r.ok).toBe(true);
  });
});
