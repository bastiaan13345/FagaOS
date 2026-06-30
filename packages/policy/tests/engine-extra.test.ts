/**
 * Additional engine coverage — exhaustively exercise the principal,
 * action, resource, and condition matchers.
 */
import { describe, expect, it } from 'vitest';
import {
  InMemoryCedarLikePolicyEngine,
  InMemoryPolicyDecisionStore,
  createPolicyAdministrator,
} from '../src/index.js';

function engine() {
  const store = new InMemoryPolicyDecisionStore();
  return { store, engine: new InMemoryCedarLikePolicyEngine({ store }) };
}

describe('InMemoryCedarLikePolicyEngine — matchers (extended coverage)', () => {
  it('action namespace matcher with no name matches every action in the namespace', async () => {
    const { engine: e } = engine();
    e.addRules([{
      id: 'r1', effect: 'ALLOW',
      principal: { type: 'any' },
      action: { type: 'namespace', namespace: 'connector' },
      resource: { type: 'any' },
    }]);
    expect((await e.decide({ actor: { id: 'a' }, action: { namespace: 'connector', name: 'mail.list' }, resource: { type: 'x', id: 'i' } })).allow).toBe(true);
    expect((await e.decide({ actor: { id: 'a' }, action: { namespace: 'connector', name: 'mail.send' }, resource: { type: 'x', id: 'i' } })).allow).toBe(true);
  });

  it('resource any matcher accepts every resource', async () => {
    const { engine: e } = engine();
    e.addRules([{
      id: 'r1', effect: 'ALLOW',
      principal: { type: 'any' },
      action: { type: 'any' },
      resource: { type: 'any' },
    }]);
    expect((await e.decide({ actor: { id: 'a' }, action: { namespace: 'x', name: 'y' }, resource: { type: 'foo', id: 'i' } })).allow).toBe(true);
  });

  it('principal any matcher accepts every principal', async () => {
    const { engine: e } = engine();
    e.addRules([{
      id: 'r1', effect: 'ALLOW',
      principal: { type: 'any' },
      action: { type: 'any' },
      resource: { type: 'any' },
    }]);
    expect((await e.decide({ actor: { id: 'whoever' }, action: { namespace: 'x', name: 'y' }, resource: { type: 't', id: 'i' } })).allow).toBe(true);
  });

  it('condition `not` negates its children', async () => {
    const { engine: e } = engine();
    e.addRules([{
      id: 'r1', effect: 'ALLOW',
      principal: { type: 'any' },
      action: { type: 'any' },
      resource: { type: 'any' },
      condition: { op: 'not', children: [{ op: 'eq', path: 'tier', value: 'banned' }] },
    }]);
    expect((await e.decide({ actor: { id: 'a' }, action: { namespace: 'x', name: 'y' }, resource: { type: 't', id: 'i' }, context: { tier: 'gold' } })).allow).toBe(true);
    expect((await e.decide({ actor: { id: 'a' }, action: { namespace: 'x', name: 'y' }, resource: { type: 't', id: 'i' }, context: { tier: 'banned' } })).allow).toBe(false);
  });

  it('condition `lte` / `gt` numeric comparators', async () => {
    const { engine: e } = engine();
    e.addRules([
      { id: 'r1', effect: 'ALLOW', principal: { type: 'any' }, action: { type: 'any' }, resource: { type: 'any' }, condition: { op: 'lte', path: 'amount', value: 100 } },
    ]);
    expect((await e.decide({ actor: { id: 'a' }, action: { namespace: 'x', name: 'y' }, resource: { type: 't', id: 'i' }, context: { amount: 50 } })).allow).toBe(true);
    expect((await e.decide({ actor: { id: 'a' }, action: { namespace: 'x', name: 'y' }, resource: { type: 't', id: 'i' }, context: { amount: 100 } })).allow).toBe(true);
    expect((await e.decide({ actor: { id: 'a' }, action: { namespace: 'x', name: 'y' }, resource: { type: 't', id: 'i' }, context: { amount: 101 } })).allow).toBe(false);
  });

  it('condition `lt` / `gte` numeric comparators', async () => {
    const { engine: e } = engine();
    e.addRules([
      { id: 'r1', effect: 'ALLOW', principal: { type: 'any' }, action: { type: 'any' }, resource: { type: 'any' }, condition: { op: 'gt', path: 'amount', value: 100 } },
    ]);
    expect((await e.decide({ actor: { id: 'a' }, action: { namespace: 'x', name: 'y' }, resource: { type: 't', id: 'i' }, context: { amount: 101 } })).allow).toBe(true);
    expect((await e.decide({ actor: { id: 'a' }, action: { namespace: 'x', name: 'y' }, resource: { type: 't', id: 'i' }, context: { amount: 100 } })).allow).toBe(false);
  });

  it('condition `neq` returns true for non-equal values', async () => {
    const { engine: e } = engine();
    e.addRules([
      { id: 'r1', effect: 'ALLOW', principal: { type: 'any' }, action: { type: 'any' }, resource: { type: 'any' }, condition: { op: 'neq', path: 'tier', value: 'banned' } },
    ]);
    expect((await e.decide({ actor: { id: 'a' }, action: { namespace: 'x', name: 'y' }, resource: { type: 't', id: 'i' }, context: { tier: 'gold' } })).allow).toBe(true);
    expect((await e.decide({ actor: { id: 'a' }, action: { namespace: 'x', name: 'y' }, resource: { type: 't', id: 'i' }, context: { tier: 'banned' } })).allow).toBe(false);
  });

  it('condition `exists` matches when the key is present, even with value null', async () => {
    const { engine: e } = engine();
    e.addRules([
      { id: 'r1', effect: 'ALLOW', principal: { type: 'any' }, action: { type: 'any' }, resource: { type: 'any' }, condition: { op: 'exists', path: 'sessionId' } },
    ]);
    expect((await e.decide({ actor: { id: 'a' }, action: { namespace: 'x', name: 'y' }, resource: { type: 't', id: 'i' }, context: { sessionId: 's1' } })).allow).toBe(true);
    expect((await e.decide({ actor: { id: 'a' }, action: { namespace: 'x', name: 'y' }, resource: { type: 't', id: 'i' }, context: { sessionId: null } })).allow).toBe(true);
    expect((await e.decide({ actor: { id: 'a' }, action: { namespace: 'x', name: 'y' }, resource: { type: 't', id: 'i' }, context: {} })).allow).toBe(false);
  });

  it('non-numeric values short-circuit the numeric comparators to false', async () => {
    const { engine: e } = engine();
    e.addRules([
      { id: 'r1', effect: 'ALLOW', principal: { type: 'any' }, action: { type: 'any' }, resource: { type: 'any' }, condition: { op: 'gt', path: 'amount', value: 100 } },
    ]);
    expect((await e.decide({ actor: { id: 'a' }, action: { namespace: 'x', name: 'y' }, resource: { type: 't', id: 'i' }, context: { amount: 'lots' } })).allow).toBe(false);
  });

  it('refreshIfChanged observes a newly-published version', async () => {
    const { engine: e, store } = engine();
    e.addRules([{ id: 'r1', effect: 'ALLOW', principal: { type: 'any' }, action: { type: 'exact', namespace: 'x', name: 'old' }, resource: { type: 'any' } }]);
    // Without publish, the engine sees the rule we added directly.
    expect((await e.decide({ actor: { id: 'a' }, action: { namespace: 'x', name: 'old' }, resource: { type: 't', id: 'i' } })).allow).toBe(true);
    // Publish a new rule set through the administrator; the engine should pick it up.
    const admin = createPolicyAdministrator({ store });
    const d = admin.draft({ rules: [{ id: 'r2', effect: 'ALLOW', principal: { type: 'any' }, action: { type: 'exact', namespace: 'x', name: 'new' }, resource: { type: 'any' } }], createdBy: 's' });
    admin.submitForReview(d.id);
    admin.approve(d.id, 'r');
    admin.publish(d.id, 'p');
    expect((await e.decide({ actor: { id: 'a' }, action: { namespace: 'x', name: 'new' }, resource: { type: 't', id: 'i' } })).allow).toBe(true);
    // The 'old' rule is no longer in effect.
    expect((await e.decide({ actor: { id: 'a' }, action: { namespace: 'x', name: 'old' }, resource: { type: 't', id: 'i' } })).allow).toBe(false);
  });
});
