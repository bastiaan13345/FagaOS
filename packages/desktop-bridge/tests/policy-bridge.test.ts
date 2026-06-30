/**
 * FAG-24 — policy-guarded desktop-bridge tests.
 *
 * The desktop-bridge's `LocalDesktopBridge` accepts a
 * `capabilityVerifier` callback. Phase 2 (FAG-24) ships
 * `createPolicyCapabilityVerifier` which adapts the policy
 * package's `CapabilityVerifier` to the bridge's callback shape.
 *
 * These tests cover:
 *   - happy path with a fresh, signed token
 *   - rejection on tampered signature
 *   - rejection when the published policy denies the operation
 *   - rejection when no `token` is supplied
 *   - happy path: allow-list verifier still works as the defence-in-depth layer
 */
import { describe, it, expect } from 'vitest';
import { InMemoryAuditLog } from '../../audit-log/src/index.js';
import {
  createAllowListCapabilityVerifier,
  createPolicyCapabilityVerifier,
  LocalDesktopBridge,
  type CapabilityVerifier,
} from '../src/index.js';
import { createInMemoryPolicyStack } from '../../policy/src/index.js';

const actor = { id: 'agent:test', label: 'test agent', capabilityId: 'cap:test' };

async function makeRoot(): Promise<string> {
  const { promises: fs } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  return fs.mkdtemp(join(tmpdir(), 'fagaos-policy-bridge-'));
}

const ALL_OPERATIONS = [
  'session.create',
  'session.inspect',
  'session.terminate',
  'session.stream.open',
  'screenshot.capture',
  'mouse.click',
  'keyboard.type',
  'clipboard.read',
  'clipboard.write',
  'browser.navigate',
  'file.readDrop',
  'file.writeDrop',
] as const;

describe('LocalDesktopBridge — FAG-24 policy guard', () => {
  it('dispatches when the policy token verifies and the policy allows', async () => {
    const stack = createInMemoryPolicyStack({ workspaceId: 'w1' });
    const draft = stack.administrator.draft({
      rules: [
        { id: 'allow-desktop', effect: 'ALLOW', principal: { type: 'any' }, action: { type: 'namespace', namespace: 'desktop' }, resource: { type: 'any' } },
      ],
      createdBy: 's',
    });
    stack.administrator.submitForReview(draft.id);
    stack.administrator.approve(draft.id, 'r');
    stack.administrator.publish(draft.id, 'p');
    const policyToken = stack.issuer.mint({
      subject: 'agent:test',
      capabilities: [{ namespace: 'desktop', action: 'session.create', resourceType: 'desktop.session' }],
      ttlMs: 60_000,
    });
    const auditLog = new InMemoryAuditLog();
    const capabilityVerifier: CapabilityVerifier = (req) => {
      const policyCheck = createPolicyCapabilityVerifier({ policyVerifier: stack.verifier, workspaceId: 'w1' })(req);
      const allowListCheck = createAllowListCapabilityVerifier([req.operation])(req);
      return Promise.all([policyCheck, allowListCheck]).then(([policy, allowList]) => policy.allow && allowList.allow ? { allow: true } : { allow: false, reason: policy.reason ?? allowList.reason });
    };
    const bridge = new LocalDesktopBridge({
      auditLog,
      actor,
      capabilityVerifier,
      sandboxRoot: await makeRoot(),
    });
    const session = await bridge.createSession({ appId: 'browser', token: policyToken });
    expect(session.appId).toBe('browser');
  });

  it('rejects when no policy token is supplied', async () => {
    const stack = createInMemoryPolicyStack({ workspaceId: 'w1' });
    const draft = stack.administrator.draft({
      rules: [{ id: 'allow', effect: 'ALLOW', principal: { type: 'any' }, action: { type: 'any' }, resource: { type: 'any' } }],
      createdBy: 's',
    });
    stack.administrator.submitForReview(draft.id);
    stack.administrator.approve(draft.id, 'r');
    stack.administrator.publish(draft.id, 'p');
    const capabilityVerifier: CapabilityVerifier = (req) =>
      createPolicyCapabilityVerifier({ policyVerifier: stack.verifier, workspaceId: 'w1' })(req);
    const bridge = new LocalDesktopBridge({
      auditLog: new InMemoryAuditLog(),
      actor,
      capabilityVerifier,
      sandboxRoot: await makeRoot(),
    });
    await expect(bridge.createSession({ appId: 'browser' })).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });
  });

  it('rejects when the published policy denies the operation', async () => {
    const stack = createInMemoryPolicyStack({ workspaceId: 'w1' });
    // Publish: allow desktop except screenshot.capture, which is denied.
    const draft = stack.administrator.draft({
      rules: [
        { id: 'allow-desktop', effect: 'ALLOW', principal: { type: 'any' }, action: { type: 'namespace', namespace: 'desktop' }, resource: { type: 'any' } },
        { id: 'deny-shot', effect: 'DENY', principal: { type: 'any' }, action: { type: 'exact', namespace: 'desktop', name: 'screenshot.capture' }, resource: { type: 'any' } },
      ],
      createdBy: 's',
    });
    stack.administrator.submitForReview(draft.id);
    stack.administrator.approve(draft.id, 'r');
    stack.administrator.publish(draft.id, 'p');
    const sessionToken = stack.issuer.mint({
      subject: 'agent:test',
      capabilities: [{ namespace: 'desktop', action: 'session.create', resourceType: 'desktop.session' }],
      ttlMs: 60_000,
    });
    const shotToken = stack.issuer.mint({
      subject: 'agent:test',
      capabilities: [{ namespace: 'desktop', action: 'screenshot.capture', resourceType: 'desktop.session' }],
      ttlMs: 60_000,
    });
    const tokenByOp: Record<string, typeof sessionToken> = {
      'session.create': sessionToken,
      'screenshot.capture': shotToken,
    };
    const capabilityVerifier: CapabilityVerifier = (req) =>
      createPolicyCapabilityVerifier({ policyVerifier: stack.verifier, workspaceId: 'w1' })({
        ...req,
        token: tokenByOp[req.operation],
      });
    const bridge = new LocalDesktopBridge({
      auditLog: new InMemoryAuditLog(),
      actor,
      capabilityVerifier,
      sandboxRoot: await makeRoot(),
    });
    // session.create should still work; screenshot.capture should be denied.
    const session = await bridge.createSession({ appId: 'browser', token: sessionToken });
    expect(session.appId).toBe('browser');
    await expect(bridge.captureScreenshot({ sessionId: session.id, token: shotToken })).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });
  });

  it('rejects a tampered token', async () => {
    const stack = createInMemoryPolicyStack({ workspaceId: 'w1' });
    const draft = stack.administrator.draft({
      rules: [{ id: 'allow', effect: 'ALLOW', principal: { type: 'any' }, action: { type: 'any' }, resource: { type: 'any' } }],
      createdBy: 's',
    });
    stack.administrator.submitForReview(draft.id);
    stack.administrator.approve(draft.id, 'r');
    stack.administrator.publish(draft.id, 'p');
    const token = stack.issuer.mint({
      subject: 'agent:test',
      capabilities: [{ namespace: 'desktop', action: 'session.create', resourceType: 'desktop.session' }],
      ttlMs: 60_000,
    });
    const tampered = { ...token, signature: '00'.repeat(32) };
    const capabilityVerifier: CapabilityVerifier = (req) =>
      createPolicyCapabilityVerifier({ policyVerifier: stack.verifier, workspaceId: 'w1' })({ ...req, token: tampered });
    const bridge = new LocalDesktopBridge({
      auditLog: new InMemoryAuditLog(),
      actor,
      capabilityVerifier,
      sandboxRoot: await makeRoot(),
    });
    await expect(bridge.createSession({ appId: 'browser' })).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });
  });
});

// Use the all-operations list to silence the linter without re-exporting it.
void ALL_OPERATIONS;
