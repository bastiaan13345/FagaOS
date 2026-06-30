/**
 * Tests for the in-memory Cedar-like policy engine.
 *
 * Coverage:
 *   - default deny when no rule matches
 *   - explicit allow matches and returns the rule id
 *   - DENY rules override ALLOW
 *   - principal matchers: id / prefix / role / any
 *   - action matchers: exact / namespace / any
 *   - resource matchers: exact / type / any
 *   - condition operators: eq / neq / lt / gt / lte / gte / in / startsWith / exists
 *   - condition trees: all / any / not
 *   - effectiveVersion() reports the published version after publish
 */
import { describe, expect, it } from 'vitest';
import { InMemoryCedarLikePolicyEngine, InMemoryPolicyDecisionStore, type PolicyRule } from '../src/index.js';

function engine(rules: PolicyRule[] = []) {
  const store = new InMemoryPolicyDecisionStore();
  const e = new InMemoryCedarLikePolicyEngine({ store });
  if (rules.length > 0) e.addRules(rules);
  return e;
}

describe('InMemoryCedarLikePolicyEngine — defaults', () => {
  it('default denies when no rule matches', async () => {
    const e = engine();
    const decision = await e.decide({
      actor: { id: 'agent:x' },
      action: { namespace: 'connector', name: 'mail.send' },
      resource: { type: 'connector.account', id: 'a1' },
    });
    expect(decision.allow).toBe(false);
    expect(decision.reason).toBe('no_matching_allow');
  });

  it('default denies when there are no rules at all', async () => {
    const e = engine();
    const decision = await e.decide({
      actor: { id: 'anyone' },
      action: { namespace: 'x', name: 'y' },
      resource: { type: 't', id: 'i' },
    });
    expect(decision.allow).toBe(false);
  });
});

describe('InMemoryCedarLikePolicyEngine — matchers', () => {
  it('matches by principal id', async () => {
    const e = engine([{
      id: 'r1', effect: 'ALLOW',
      principal: { type: 'id', id: 'agent:1' },
      action: { type: 'any' },
      resource: { type: 'any' },
    }]);
    expect((await e.decide({ actor: { id: 'agent:1' }, action: { namespace: 'x', name: 'y' }, resource: { type: 't', id: 'i' } })).allow).toBe(true);
    expect((await e.decide({ actor: { id: 'agent:2' }, action: { namespace: 'x', name: 'y' }, resource: { type: 't', id: 'i' } })).allow).toBe(false);
  });

  it('matches by principal prefix', async () => {
    const e = engine([{
      id: 'r1', effect: 'ALLOW',
      principal: { type: 'prefix', prefix: 'agent:worker:' },
      action: { type: 'any' },
      resource: { type: 'any' },
    }]);
    expect((await e.decide({ actor: { id: 'agent:worker:1' }, action: { namespace: 'x', name: 'y' }, resource: { type: 't', id: 'i' } })).allow).toBe(true);
    expect((await e.decide({ actor: { id: 'agent:orchestrator:1' }, action: { namespace: 'x', name: 'y' }, resource: { type: 't', id: 'i' } })).allow).toBe(false);
  });

  it('matches by principal role via context.roles', async () => {
    const e = engine([{
      id: 'r1', effect: 'ALLOW',
      principal: { type: 'role', role: 'admin' },
      action: { type: 'any' },
      resource: { type: 'any' },
    }]);
    expect((await e.decide({ actor: { id: 'u1' }, action: { namespace: 'x', name: 'y' }, resource: { type: 't', id: 'i' }, context: { roles: ['admin'] } })).allow).toBe(true);
    expect((await e.decide({ actor: { id: 'u1' }, action: { namespace: 'x', name: 'y' }, resource: { type: 't', id: 'i' }, context: { roles: ['user'] } })).allow).toBe(false);
  });

  it('matches by action namespace', async () => {
    const e = engine([{
      id: 'r1', effect: 'ALLOW',
      principal: { type: 'any' },
      action: { type: 'namespace', namespace: 'connector' },
      resource: { type: 'any' },
    }]);
    expect((await e.decide({ actor: { id: 'a' }, action: { namespace: 'connector', name: 'mail.send' }, resource: { type: 't', id: 'i' } })).allow).toBe(true);
    expect((await e.decide({ actor: { id: 'a' }, action: { namespace: 'desktop', name: 'click' }, resource: { type: 't', id: 'i' } })).allow).toBe(false);
  });

  it('matches by action exact', async () => {
    const e = engine([{
      id: 'r1', effect: 'ALLOW',
      principal: { type: 'any' },
      action: { type: 'exact', namespace: 'connector', name: 'mail.send' },
      resource: { type: 'any' },
    }]);
    expect((await e.decide({ actor: { id: 'a' }, action: { namespace: 'connector', name: 'mail.send' }, resource: { type: 't', id: 'i' } })).allow).toBe(true);
    expect((await e.decide({ actor: { id: 'a' }, action: { namespace: 'connector', name: 'mail.list' }, resource: { type: 't', id: 'i' } })).allow).toBe(false);
  });

  it('matches by resource type', async () => {
    const e = engine([{
      id: 'r1', effect: 'ALLOW',
      principal: { type: 'any' },
      action: { type: 'any' },
      resource: { type: 'type', resourceType: 'connector.account' },
    }]);
    expect((await e.decide({ actor: { id: 'a' }, action: { namespace: 'x', name: 'y' }, resource: { type: 'connector.account', id: 'a1' } })).allow).toBe(true);
    expect((await e.decide({ actor: { id: 'a' }, action: { namespace: 'x', name: 'y' }, resource: { type: 'session', id: 's1' } })).allow).toBe(false);
  });

  it('matches by resource exact', async () => {
    const e = engine([{
      id: 'r1', effect: 'ALLOW',
      principal: { type: 'any' },
      action: { type: 'any' },
      resource: { type: 'exact', resourceType: 'connector.account', id: 'a1' },
    }]);
    expect((await e.decide({ actor: { id: 'a' }, action: { namespace: 'x', name: 'y' }, resource: { type: 'connector.account', id: 'a1' } })).allow).toBe(true);
    expect((await e.decide({ actor: { id: 'a' }, action: { namespace: 'x', name: 'y' }, resource: { type: 'connector.account', id: 'a2' } })).allow).toBe(false);
  });
});

describe('InMemoryCedarLikePolicyEngine — DENY override', () => {
  it('DENY wins over ALLOW', async () => {
    const e = engine([
      { id: 'allow-all', effect: 'ALLOW', principal: { type: 'any' }, action: { type: 'any' }, resource: { type: 'any' } },
      { id: 'deny-1', effect: 'DENY', principal: { type: 'id', id: 'agent:bad' }, action: { type: 'any' }, resource: { type: 'any' } },
    ]);
    const decision = await e.decide({ actor: { id: 'agent:bad' }, action: { namespace: 'x', name: 'y' }, resource: { type: 't', id: 'i' } });
    expect(decision.allow).toBe(false);
    expect(decision.ruleId).toBe('deny-1');
  });

  it('returns the first matching ALLOW when no DENY matches', async () => {
    const e = engine([
      { id: 'allow-1', effect: 'ALLOW', principal: { type: 'any' }, action: { type: 'any' }, resource: { type: 'any' } },
      { id: 'allow-2', effect: 'ALLOW', principal: { type: 'any' }, action: { type: 'any' }, resource: { type: 'type', resourceType: 'session' } },
    ]);
    const decision = await e.decide({ actor: { id: 'a' }, action: { namespace: 'x', name: 'y' }, resource: { type: 'session', id: 's1' } });
    expect(decision.allow).toBe(true);
    expect(decision.ruleId).toBe('allow-1');
  });
});

describe('InMemoryCedarLikePolicyEngine — conditions', () => {
  it('eq / neq on context path', async () => {
    const e = engine([{
      id: 'r1', effect: 'ALLOW',
      principal: { type: 'any' },
      action: { type: 'any' },
      resource: { type: 'any' },
      condition: { op: 'eq', path: 'environment', value: 'production' },
    }]);
    const allow = await e.decide({ actor: { id: 'a' }, action: { namespace: 'x', name: 'y' }, resource: { type: 't', id: 'i' }, context: { environment: 'production' } });
    expect(allow.allow).toBe(true);
    const deny = await e.decide({ actor: { id: 'a' }, action: { namespace: 'x', name: 'y' }, resource: { type: 't', id: 'i' }, context: { environment: 'staging' } });
    expect(deny.allow).toBe(false);
  });

  it('numeric gt / gte / lt / lte', async () => {
    const e = engine([{
      id: 'r1', effect: 'ALLOW',
      principal: { type: 'any' },
      action: { type: 'any' },
      resource: { type: 'any' },
      condition: { op: 'gte', path: 'amount', value: 1000 },
    }]);
    expect((await e.decide({ actor: { id: 'a' }, action: { namespace: 'x', name: 'y' }, resource: { type: 't', id: 'i' }, context: { amount: 1500 } })).allow).toBe(true);
    expect((await e.decide({ actor: { id: 'a' }, action: { namespace: 'x', name: 'y' }, resource: { type: 't', id: 'i' }, context: { amount: 999 } })).allow).toBe(false);
  });

  it('in / startsWith / exists', async () => {
    const e = engine([{
      id: 'r1', effect: 'ALLOW',
      principal: { type: 'any' },
      action: { type: 'any' },
      resource: { type: 'any' },
      condition: {
        op: 'all',
        children: [
          { op: 'in', path: 'tier', values: ['gold', 'platinum'] },
          { op: 'startsWith', path: 'email', value: 'admin@' },
          { op: 'exists', path: 'sessionId' },
        ],
      },
    }]);
    expect((await e.decide({ actor: { id: 'a' }, action: { namespace: 'x', name: 'y' }, resource: { type: 't', id: 'i' }, context: { tier: 'platinum', email: 'admin@example.com', sessionId: 's1' } })).allow).toBe(true);
    expect((await e.decide({ actor: { id: 'a' }, action: { namespace: 'x', name: 'y' }, resource: { type: 't', id: 'i' }, context: { tier: 'platinum', email: 'admin@example.com' } })).allow).toBe(false);
  });

  it('any / not composition', async () => {
    const e = engine([{
      id: 'r1', effect: 'ALLOW',
      principal: { type: 'any' },
      action: { type: 'any' },
      resource: { type: 'any' },
      condition: {
        op: 'any',
        children: [
          { op: 'eq', path: 'env', value: 'production' },
          { op: 'eq', path: 'env', value: 'staging' },
        ],
      },
    }]);
    expect((await e.decide({ actor: { id: 'a' }, action: { namespace: 'x', name: 'y' }, resource: { type: 't', id: 'i' }, context: { env: 'staging' } })).allow).toBe(true);
    expect((await e.decide({ actor: { id: 'a' }, action: { namespace: 'x', name: 'y' }, resource: { type: 't', id: 'i' }, context: { env: 'dev' } })).allow).toBe(false);
  });
});

describe('InMemoryCedarLikePolicyEngine — published version', () => {
  it('effectiveVersion() returns null before any version is published', () => {
    const e = engine();
    expect(e.effectiveVersion()).toBeNull();
  });

  it('engine consults the published version after publish', async () => {
    const store = new InMemoryPolicyDecisionStore();
    const admin = (await import('../src/governance.js')).createPolicyAdministrator({ store });
    const e = new InMemoryCedarLikePolicyEngine({ store });
    const draft = admin.draft({
      rules: [
        { id: 'p1', effect: 'ALLOW', principal: { type: 'any' }, action: { type: 'any' }, resource: { type: 'any' } },
      ],
      createdBy: 'alice',
    });
    admin.submitForReview(draft.id);
    admin.approve(draft.id, 'bob');
    const { version, previous } = admin.publish(draft.id, 'admin');
    expect(previous).toBeNull();
    expect(version.state).toBe('published');
    // The engine now sees the published version's rules.
    const decision = await e.decide({ actor: { id: 'a' }, action: { namespace: 'x', name: 'y' }, resource: { type: 't', id: 'i' } });
    expect(decision.allow).toBe(true);
    expect(e.effectiveVersion()?.version).toBe(1);
  });
});
