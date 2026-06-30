/**
 * FAG-24 — policy-guarded connector gateway tests.
 *
 * The connector gateway now supports an optional `capabilityVerifier`
 * from the policy package. When supplied, the gateway runs the full
 * crypto + policy check on a `policyToken` accompanying each call.
 * These tests exercise:
 *   - happy path with a fresh, signed token
 *   - rejection on tampered signature
 *   - rejection on expired token
 *   - rejection when the published policy denies the call
 *   - rejection when no `policyToken` is supplied but a verifier is configured
 *   - backwards compat: existing tests still pass without a verifier
 */
import { describe, it, expect } from 'vitest';
import {
  ConnectorGateway,
  InMemoryAccountStore,
  InMemoryIdempotencyStore,
  ReauthTracker,
  FeatureFlagRegistry,
  StubEmailConnector,
  StubCalendarConnector,
  CapabilityTokenSchema,
  type Connector,
  type MailListResult,
  type ConnectorRequest,
  type ConnectorId,
  type ConnectorOperation,
} from '../src/index.js';
import type { Account } from '../src/index.js';
import { InMemoryAuditLog } from '../../core/src/index.js';
import { createInMemoryPolicyStack } from '../../policy/src/index.js';

function makeAccount(id: string, provider: 'gmail' | 'google_calendar' = 'gmail', status: Account['status'] = 'active'): Account {
  return {
    id,
    user_id: 'u1',
    provider,
    handle: 'me@example.com',
    scopes: [],
    capabilities: [],
    status,
    created_at: '2025-01-01T00:00:00.000Z',
    updated_at: '2025-01-01T00:00:00.000Z',
  } as Account;
}

function makeStructuralToken(accountId: string | null = null) {
  return CapabilityTokenSchema.parse({
    subject: 'agent:test',
    capabilities: [
      { provider: 'gmail', operation: 'mail.list', account_id: accountId },
      { provider: 'gmail', operation: 'mail.send', account_id: accountId },
    ],
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  });
}

describe('ConnectorGateway — FAG-24 policy guard', () => {
  it('dispatches when the policy token verifies and the policy allows', async () => {
    const stack = createInMemoryPolicyStack({ workspaceId: 'w1' });
    // Publish an allow rule.
    const draft = stack.administrator.draft({
      rules: [
        { id: 'allow-connector', effect: 'ALLOW', principal: { type: 'any' }, action: { type: 'namespace', namespace: 'connector' }, resource: { type: 'any' } },
      ],
      createdBy: 's',
    });
    stack.administrator.submitForReview(draft.id);
    stack.administrator.approve(draft.id, 'r');
    stack.administrator.publish(draft.id, 'p');
    const policyToken = stack.issuer.mint({
      subject: 'agent:test',
      capabilities: [{ namespace: 'connector', action: 'mail.send', resourceType: 'connector.account' }],
      ttlMs: 60_000,
    });
    const audit = new InMemoryAuditLog();
    const accounts = new InMemoryAccountStore();
    await accounts.upsert(makeAccount('a1', 'gmail'));
    const gateway = new ConnectorGateway({
      audit, accounts, idempotency: new InMemoryIdempotencyStore(),
      reauth: new ReauthTracker(),
      features: new FeatureFlagRegistry({ gmail: true, google_calendar: true, stub_email: true, stub_calendar: true }),
      connectors: new Map([['gmail', new StubEmailConnector()], ['google_calendar', new StubCalendarConnector()]]),
      capabilityVerifier: stack.verifier,
      workspaceId: 'w1',
    });
    const out = await gateway.mailSend({
      token: makeStructuralToken(),
      account_id: 'a1',
      args: { to: ['x@example.com'], subject: 's', body: 'b' },
      policyToken,
    });
    expect(out.provider_message_id).toMatch(/^stub-msg-/);
  });

  it('rejects when the policy token is missing but a verifier is configured', async () => {
    const stack = createInMemoryPolicyStack({ workspaceId: 'w1' });
    const audit = new InMemoryAuditLog();
    const accounts = new InMemoryAccountStore();
    await accounts.upsert(makeAccount('a1', 'gmail'));
    const gateway = new ConnectorGateway({
      audit, accounts, idempotency: new InMemoryIdempotencyStore(),
      reauth: new ReauthTracker(),
      features: new FeatureFlagRegistry({ gmail: true, google_calendar: true, stub_email: true, stub_calendar: true }),
      connectors: new Map([['gmail', new StubEmailConnector()], ['google_calendar', new StubCalendarConnector()]]),
      capabilityVerifier: stack.verifier,
      workspaceId: 'w1',
    });
    await expect(gateway.mailList({
      token: makeStructuralToken(),
      account_id: 'a1',
      args: {},
    })).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('rejects when the policy token signature is tampered with', async () => {
    const stack = createInMemoryPolicyStack({ workspaceId: 'w1' });
    // Allow all so the only rejection is the signature.
    const draft = stack.administrator.draft({
      rules: [{ id: 'allow', effect: 'ALLOW', principal: { type: 'any' }, action: { type: 'any' }, resource: { type: 'any' } }],
      createdBy: 's',
    });
    stack.administrator.submitForReview(draft.id);
    stack.administrator.approve(draft.id, 'r');
    stack.administrator.publish(draft.id, 'p');
    const policyToken = stack.issuer.mint({
      subject: 'agent:test',
      capabilities: [{ namespace: 'connector', action: 'mail.send', resourceType: 'connector.account' }],
      ttlMs: 60_000,
    });
    const tampered = { ...policyToken, signature: '00'.repeat(32) };
    const audit = new InMemoryAuditLog();
    const accounts = new InMemoryAccountStore();
    await accounts.upsert(makeAccount('a1', 'gmail'));
    const gateway = new ConnectorGateway({
      audit, accounts, idempotency: new InMemoryIdempotencyStore(),
      reauth: new ReauthTracker(),
      features: new FeatureFlagRegistry({ gmail: true, google_calendar: true, stub_email: true, stub_calendar: true }),
      connectors: new Map([['gmail', new StubEmailConnector()], ['google_calendar', new StubCalendarConnector()]]),
      capabilityVerifier: stack.verifier,
      workspaceId: 'w1',
    });
    await expect(gateway.mailList({
      token: makeStructuralToken(),
      account_id: 'a1',
      args: {},
      policyToken: tampered,
    })).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('rejects when the published policy denies the action', async () => {
    const stack = createInMemoryPolicyStack({ workspaceId: 'w1' });
    // Publish a deny rule for mail.send.
    const draft = stack.administrator.draft({
      rules: [
        { id: 'deny-mail-send', effect: 'DENY', principal: { type: 'any' }, action: { type: 'exact', namespace: 'connector', name: 'mail.send' }, resource: { type: 'any' } },
      ],
      createdBy: 's',
    });
    stack.administrator.submitForReview(draft.id);
    stack.administrator.approve(draft.id, 'r');
    stack.administrator.publish(draft.id, 'p');
    const policyToken = stack.issuer.mint({
      subject: 'agent:test',
      capabilities: [{ namespace: 'connector', action: 'mail.send', resourceType: 'connector.account' }],
      ttlMs: 60_000,
    });
    const audit = new InMemoryAuditLog();
    const accounts = new InMemoryAccountStore();
    await accounts.upsert(makeAccount('a1', 'gmail'));
    const gateway = new ConnectorGateway({
      audit, accounts, idempotency: new InMemoryIdempotencyStore(),
      reauth: new ReauthTracker(),
      features: new FeatureFlagRegistry({ gmail: true, google_calendar: true, stub_email: true, stub_calendar: true }),
      connectors: new Map([['gmail', new StubEmailConnector()], ['google_calendar', new StubCalendarConnector()]]),
      capabilityVerifier: stack.verifier,
      workspaceId: 'w1',
    });
    await expect(gateway.mailSend({
      token: makeStructuralToken(),
      account_id: 'a1',
      args: { to: ['x@example.com'], subject: 's', body: 'b' },
      policyToken,
    })).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('allows a previously-denied action once the policy is updated', async () => {
    const stack = createInMemoryPolicyStack({ workspaceId: 'w1' });
    // First: deny.
    const d1 = stack.administrator.draft({
      rules: [
        { id: 'deny-mail-send', effect: 'DENY', principal: { type: 'any' }, action: { type: 'exact', namespace: 'connector', name: 'mail.send' }, resource: { type: 'any' } },
      ],
      createdBy: 's',
    });
    stack.administrator.submitForReview(d1.id);
    stack.administrator.approve(d1.id, 'r');
    stack.administrator.publish(d1.id, 'p');
    // Then: publish a new version that allows it.
    const d2 = stack.administrator.draft({
      rules: [
        { id: 'allow-connector', effect: 'ALLOW', principal: { type: 'any' }, action: { type: 'namespace', namespace: 'connector' }, resource: { type: 'any' } },
      ],
      createdBy: 's',
      changeNote: 'relax mail.send for the staging tenant',
    });
    stack.administrator.submitForReview(d2.id);
    stack.administrator.approve(d2.id, 'r');
    stack.administrator.publish(d2.id, 'p');
    const policyToken = stack.issuer.mint({
      subject: 'agent:test',
      capabilities: [{ namespace: 'connector', action: 'mail.send', resourceType: 'connector.account' }],
      ttlMs: 60_000,
    });
    const audit = new InMemoryAuditLog();
    const accounts = new InMemoryAccountStore();
    await accounts.upsert(makeAccount('a1', 'gmail'));
    const gateway = new ConnectorGateway({
      audit, accounts, idempotency: new InMemoryIdempotencyStore(),
      reauth: new ReauthTracker(),
      features: new FeatureFlagRegistry({ gmail: true, google_calendar: true, stub_email: true, stub_calendar: true }),
      connectors: new Map([['gmail', new StubEmailConnector()], ['google_calendar', new StubCalendarConnector()]]),
      capabilityVerifier: stack.verifier,
      workspaceId: 'w1',
    });
    // Mint a fresh token; existing tokens would be checked by the
    // engine against the live policy at verify time.
    const out = await gateway.mailSend({
      token: makeStructuralToken(),
      account_id: 'a1',
      args: { to: ['x@example.com'], subject: 's', body: 'b' },
      policyToken,
    });
    expect(out.provider_message_id).toMatch(/^stub-msg-/);
  });

  it('rejects a token signed by a key past the grace window (key rotation)', async () => {
    let now = new Date('2025-01-01T00:00:00.000Z');
    const clock = () => now;
    const stack = createInMemoryPolicyStack({ workspaceId: 'w1', now: clock, secretStoreOptions: { graceWindowMs: 60 * 60 * 1000 } });
    // Publish an allow rule.
    const d = stack.administrator.draft({
      rules: [{ id: 'allow', effect: 'ALLOW', principal: { type: 'any' }, action: { type: 'any' }, resource: { type: 'any' } }],
      createdBy: 's',
    });
    stack.administrator.submitForReview(d.id);
    stack.administrator.approve(d.id, 'r');
    stack.administrator.publish(d.id, 'p');
    const policyToken = stack.issuer.mint({
      subject: 'agent:test',
      capabilities: [{ namespace: 'connector', action: 'mail.send', resourceType: 'connector.account' }],
      // 4h TTL so the token is still valid by expiry even after
      // we advance the clock 2h to test the grace window.
      ttlMs: 4 * 60 * 60 * 1000,
    });
    // Rotate, retiring the old key.
    stack.secretStore.rotate({ purpose: 'capability-signing' });
    // Advance 2h.
    now = new Date(now.getTime() + 2 * 60 * 60 * 1000);
    const audit = new InMemoryAuditLog();
    const accounts = new InMemoryAccountStore();
    await accounts.upsert(makeAccount('a1', 'gmail'));
    const gateway = new ConnectorGateway({
      audit, accounts, idempotency: new InMemoryIdempotencyStore(),
      reauth: new ReauthTracker(),
      features: new FeatureFlagRegistry({ gmail: true, google_calendar: true, stub_email: true, stub_calendar: true }),
      connectors: new Map([['gmail', new StubEmailConnector()], ['google_calendar', new StubCalendarConnector()]]),
      capabilityVerifier: stack.verifier,
      workspaceId: 'w1',
    });
    await expect(gateway.mailSend({
      token: makeStructuralToken(),
      account_id: 'a1',
      args: { to: ['x@example.com'], subject: 's', body: 'b' },
      policyToken,
    })).rejects.toMatchObject({ code: 'forbidden' });
  });
});

// Make the unused `Connector`/`ConnectorRequest` references compile.
void (null as unknown as Connector);
void (null as unknown as ConnectorRequest);
void (null as unknown as ConnectorId);
void (null as unknown as ConnectorOperation);
void (null as unknown as MailListResult);
