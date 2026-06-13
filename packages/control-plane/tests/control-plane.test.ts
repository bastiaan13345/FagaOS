import { describe, it, expect, beforeEach } from 'vitest';
import {
  ControlPlane,
  createInMemoryCardRegistry,
  stubToolGateway,
  ControlPlaneError,
  type ToolGateway,
} from '../src/index.js';
import { createInMemoryAuditLog } from '@fagaos/audit-log';
import type { z } from 'zod';
import { AgentCardSchema } from '@fagaos/agent-manifest';

type AgentCardInput = z.input<typeof AgentCardSchema>;

function echoCard(): AgentCardInput {
  return {
    id: 'agent.test.echo',
    name: 'Echo Agent',
    version: '0.1.0',
    owner: { id: 'team:platform' },
    auth: { kind: 'none' },
    capabilities: [{ name: 'echo' }, { name: 'fs.read', scope: '/tmp' }],
    mcpEndpoints: [
      { id: 'mcp.in', name: 'Inbound', role: 'server', transport: 'http+sse', url: 'https://mcp.local/echo' },
    ],
    toolServers: [
      { id: 'fs', implementation: '@fagaos/tool-server-fs', category: 'filesystem', endpoints: ['mcp.in'] },
    ],
  };
}

describe('@fagaos/control-plane — session lifecycle', () => {
  let cp: ControlPlane;
  let audit: ReturnType<typeof createInMemoryAuditLog>;

  beforeEach(async () => {
    audit = createInMemoryAuditLog();
    const cards = createInMemoryCardRegistry();
    cards.register(echoCard());
    cp = new ControlPlane({ audit, cards });
  });

  it('registers a card and audits the registration', async () => {
    const audit2 = createInMemoryAuditLog();
    const cards = createInMemoryCardRegistry();
    const cp2 = new ControlPlane({ audit: audit2, cards });
    await cp2.registerCard(echoCard());
    const v = await audit2.verify();
    expect(v.ok).toBe(true);
    const entries = await audit2.read();
    expect(entries[0]?.action).toBe('card.register');
  });

  it('creates a session bound to a registered card', async () => {
    const s = await cp.createSession({
      agentId: 'agent.test.echo',
      createdBy: { id: 'user:alice', type: 'user' },
      input: { prompt: 'hi' },
    });
    expect(s.state).toBe('running');
    expect(s.agentId).toBe('agent.test.echo');
    expect(s.agentVersion).toBe('0.1.0');
    const v = await audit.verify();
    expect(v.ok).toBe(true);
    const entries = await audit.read();
    expect(entries[0]?.action).toBe('session.create');
  });

  it('rejects session creation when the agent id is unknown', async () => {
    await expect(
      cp.createSession({
        agentId: 'agent.does.not.exist',
        createdBy: { id: 'user:alice', type: 'user' },
        input: {},
      }),
    ).rejects.toMatchObject({ code: 'agent_card_not_found' });
  });

  it('retrieves and deletes a session', async () => {
    const s = await cp.createSession({
      agentId: 'agent.test.echo',
      createdBy: { id: 'user:alice', type: 'user' },
      input: {},
    });
    const got = cp.getSession(s.id);
    expect(got.id).toBe(s.id);
    await cp.deleteSession(s.id);
    expect(() => cp.getSession(s.id)).toThrow(ControlPlaneError);
  });
});

describe('@fagaos/control-plane — tool invocation', () => {
  let cp: ControlPlane;
  let audit: ReturnType<typeof createInMemoryAuditLog>;

  beforeEach(() => {
    audit = createInMemoryAuditLog();
    const cards = createInMemoryCardRegistry();
    cards.register(echoCard());
    cp = new ControlPlane({ audit, cards });
  });

  it('invokes a tool through the stub gateway and records the audit entry', async () => {
    const s = await cp.createSession({
      agentId: 'agent.test.echo',
      createdBy: { id: 'user:alice', type: 'user' },
      input: {},
    });
    const result = await cp.invokeTool(s.id, { arguments: { msg: 'hi' } }, 'echo');
    expect(result.ok).toBe(true);
    expect(result.result?.['echoArgs']).toEqual({ msg: 'hi' });
    const log = await cp.getSessionLog(s.id);
    const actions = log.map((e) => e.action);
    expect(actions).toContain('session.create');
    expect(actions).toContain('tool.invoke');
  });

  it('refuses tool calls on a non-running session', async () => {
    const s = await cp.createSession({
      agentId: 'agent.test.echo',
      createdBy: { id: 'user:alice', type: 'user' },
      input: {},
    });
    await cp.killSession(s.id, 'test');
    await expect(
      cp.invokeTool(s.id, { arguments: {} }, 'echo'),
    ).rejects.toMatchObject({ code: 'session_not_running' });
  });

  it('routes tool calls through a custom gateway', async () => {
    const cards = createInMemoryCardRegistry();
    cards.register(echoCard());
    const localAudit = createInMemoryAuditLog();
    let lastTool: string | null = null;
    const gateway: ToolGateway = async (_session, inv) => {
      lastTool = inv.tool;
      return {
        ok: true,
        result: { from: 'custom' },
        error: null,
        durationMs: 0,
        correlationId: 'corr-1',
      };
    };
    const cp2 = new ControlPlane({ audit: localAudit, cards, toolGateway: gateway });
    const s = await cp2.createSession({
      agentId: 'agent.test.echo',
      createdBy: { id: 'user:alice', type: 'user' },
      input: {},
    });
    const r = await cp2.invokeTool(s.id, { arguments: {} }, 'browser.click');
    expect(r.result?.['from']).toBe('custom');
    expect(lastTool).toBe('browser.click');
  });
});

describe('@fagaos/control-plane — kill', () => {
  it('transitions running -> killed and audits the reason', async () => {
    const audit = createInMemoryAuditLog();
    const cards = createInMemoryCardRegistry();
    cards.register(echoCard());
    const cp = new ControlPlane({ audit, cards });
    const s = await cp.createSession({
      agentId: 'agent.test.echo',
      createdBy: { id: 'user:alice', type: 'user' },
      input: {},
    });
    await cp.killSession(s.id, 'operator override');
    const after = cp.getSession(s.id);
    expect(after.state).toBe('killed');
    expect(after.terminalReason).toBe('operator override');
    const log = await cp.getSessionLog(s.id);
    expect(log.map((e) => e.action)).toContain('session.kill');
  });

  it('refuses to kill an already-terminal session', async () => {
    const audit = createInMemoryAuditLog();
    const cards = createInMemoryCardRegistry();
    cards.register(echoCard());
    const cp = new ControlPlane({ audit, cards });
    const s = await cp.createSession({
      agentId: 'agent.test.echo',
      createdBy: { id: 'user:alice', type: 'user' },
      input: {},
    });
    await cp.killSession(s.id, 'first');
    await expect(cp.killSession(s.id, 'second')).rejects.toMatchObject({
      code: 'session_already_terminal',
    });
  });
});

describe('@fagaos/control-plane — audit log integration', () => {
  it('produces a verifiable, hash-chained audit log across the full lifecycle', async () => {
    const audit = createInMemoryAuditLog();
    const cards = createInMemoryCardRegistry();
    cards.register(echoCard());
    const cp = new ControlPlane({ audit, cards });
    const s = await cp.createSession({
      agentId: 'agent.test.echo',
      createdBy: { id: 'user:alice', type: 'user' },
      input: { prompt: 'test' },
    });
    await cp.invokeTool(s.id, { arguments: { x: 1 } }, 'echo');
    await cp.invokeTool(s.id, { arguments: { y: 2 } }, 'echo');
    await cp.killSession(s.id, 'done');
    const result = await audit.verify();
    expect(result.ok).toBe(true);
    expect(result.inspected).toBeGreaterThanOrEqual(4);
    const all = await audit.read();
    const actions = all.map((e) => e.action);
    expect(actions).toEqual(
      expect.arrayContaining(['session.create', 'tool.invoke', 'session.kill']),
    );
  });

  it('audit entries carry actor, action, resource, and timestamp', async () => {
    const audit = createInMemoryAuditLog();
    const cards = createInMemoryCardRegistry();
    cards.register(echoCard());
    const cp = new ControlPlane({ audit, cards });
    await cp.createSession({
      agentId: 'agent.test.echo',
      createdBy: { id: 'user:alice', type: 'user' },
      input: {},
    });
    const entries = await audit.read();
    const e = entries[0]!;
    expect(e.actor.id).toBe('user:alice');
    expect(e.actor.type).toBe('user');
    expect(e.action).toBe('session.create');
    expect(e.resource.kind).toBe('session');
    expect(e.ts).toMatch(/T/);
  });
});

describe('@fagaos/control-plane — stub gateway', () => {
  it('exposes a stub gateway that records every call', async () => {
    const audit = createInMemoryAuditLog();
    const cards = createInMemoryCardRegistry();
    cards.register(echoCard());
    const cp = new ControlPlane({ audit, cards, toolGateway: stubToolGateway });
    const s = await cp.createSession({
      agentId: 'agent.test.echo',
      createdBy: { id: 'user:alice', type: 'user' },
      input: {},
    });
    const r = await cp.invokeTool(s.id, { arguments: { x: 1 } }, 'whatever.tool');
    expect(r.ok).toBe(true);
    expect(r.result?.['notice']).toMatch(/FAG-4 \/ FAG-5/);
  });
});
