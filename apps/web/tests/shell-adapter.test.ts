import { describe, expect, it } from 'vitest';
import { ControlPlaneHttpShellAdapter } from '../src/lib/shell/adapter';
import { AuditEntrySchema, type AuditEntry, type Task } from '../src/lib/api/types';
import type { ControlPlaneClient } from '../src/lib/api/client';

const baseUrl = 'http://control-plane.test';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    sessionId: 'session-1',
    tool: 'browser.navigate',
    arguments: {},
    state: 'queued',
    createdAt: '2026-06-15T12:00:00.000Z',
    updatedAt: '2026-06-15T12:00:00.000Z',
    scheduledAt: '2026-06-15T12:00:00.000Z',
    attempt: 0,
    maxAttempts: 3,
    createdBy: { id: 'user:alice', type: 'user' },
    auditCorrelationId: 'corr-1',
    capabilityCheck: { ok: true },
    ...overrides,
  };
}

function makeAuditEntry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return AuditEntrySchema.parse({
    id: 'audit-1',
    seq: 1,
    ts: '2026-06-15T12:00:00.000Z',
    actor: { id: 'user:alice', type: 'user' },
    action: 'card.register',
    resource: { kind: 'agent', id: 'agent.ops' },
    data: {},
    prevHash: '0'.repeat(64),
    hash: '0'.repeat(64),
    signedCheckpoint: { algorithm: 'ed25519-stub-v1', payload: 'p', signature: 's' },
    ...overrides,
  });
}

interface ClientOverrides {
  recoverTasks?: Task[];
  auditLog?: AuditEntry[];
  recoverFails?: boolean;
  auditLogFails?: boolean;
}

function makeClient(overrides: ClientOverrides = {}): ControlPlaneClient {
  return {
    baseUrl,
    async health() {
      return { ok: true };
    },
    async createSession() {
      throw new Error('not used');
    },
    async getSession() {
      throw new Error('not used');
    },
    async deleteSession() {
      return;
    },
    async invokeTool() {
      throw new Error('not used');
    },
    async killSession() {
      return;
    },
    async getSessionAuditLog() {
      if (overrides.auditLogFails) throw new Error('boom');
      return overrides.auditLog ?? [];
    },
    async registerCard() {
      return;
    },
    async enqueueTask() {
      throw new Error('not used');
    },
    async claimTask() {
      return null;
    },
    async recoverTasks() {
      if (overrides.recoverFails) throw new Error('boom');
      return overrides.recoverTasks ?? [];
    },
    async getTask() {
      throw new Error('not used');
    },
    async heartbeatTask() {
      throw new Error('not used');
    },
    async completeTask() {
      throw new Error('not used');
    },
    async failTask() {
      throw new Error('not used');
    },
    async cancelTask() {
      throw new Error('not used');
    },
  };
}

describe('ControlPlaneHttpShellAdapter', () => {
  it('lists agents discovered from card.register audit entries', async () => {
    const entry = makeAuditEntry({
      action: 'card.register',
      resource: { kind: 'agent', id: 'agent.ops' },
    });
    const task = makeTask();
    const adapter = new ControlPlaneHttpShellAdapter({
      client: makeClient({ recoverTasks: [task], auditLog: [entry] }),
    });
    const agents = await adapter.listAgents();
    expect(agents).toEqual([
      expect.objectContaining({
        id: 'agent.ops',
        name: 'agent.ops',
        status: 'idle',
        recentFailureCount: 0,
      }),
    ]);
  });

  it('deduplicates agents when multiple register events exist for the same id', async () => {
    const entries = [
      makeAuditEntry({ id: 'audit-1', seq: 1, action: 'card.register', resource: { kind: 'agent', id: 'agent.ops' } }),
      makeAuditEntry({ id: 'audit-2', seq: 2, action: 'card.register', resource: { kind: 'agent', id: 'agent.ops' } }),
    ];
    const adapter = new ControlPlaneHttpShellAdapter({
      client: makeClient({ recoverTasks: [makeTask()], auditLog: entries }),
    });
    const agents = await adapter.listAgents();
    expect(agents).toHaveLength(1);
  });

  it('lists tasks and maps their state to a workspace status', async () => {
    const adapter = new ControlPlaneHttpShellAdapter({
      client: makeClient({
        recoverTasks: [
          makeTask({ id: 't-queued', state: 'queued' }),
          makeTask({ id: 't-claimed', state: 'claimed' }),
          makeTask({ id: 't-done', state: 'completed' }),
          makeTask({ id: 't-failed', state: 'failed' }),
          makeTask({ id: 't-cancelled', state: 'cancelled' }),
        ],
      }),
    });
    const tasks = await adapter.listTasks();
    expect(tasks.map((task) => task.status)).toEqual([
      'queued',
      'running',
      'completed',
      'failed',
      'cancelled',
    ]);
  });

  it('marks tasks as waiting_on_approval when the capability check fails', async () => {
    const adapter = new ControlPlaneHttpShellAdapter({
      client: makeClient({
        recoverTasks: [
          makeTask({
            id: 't-approval',
            state: 'queued',
            capabilityCheck: { ok: false, reason: 'needs approval' },
          }),
        ],
      }),
    });
    const tasks = await adapter.listTasks();
    expect(tasks[0]?.status).toBe('waiting_on_approval');
    expect(tasks[0]?.priority).toBe('urgent');
  });

  it('returns an empty list of sessions, accounts, approvals, and escalations', async () => {
    const adapter = new ControlPlaneHttpShellAdapter({
      client: makeClient({ recoverTasks: [makeTask()], auditLog: [] }),
    });
    expect(await adapter.listSessions()).toEqual([]);
    expect(await adapter.listAccounts()).toEqual([]);
    expect(await adapter.listApprovals()).toEqual([]);
    expect(await adapter.listEscalations()).toEqual([]);
  });

  it('maps audit entries to a workspace audit view, classifying denied and failed outcomes', async () => {
    const entries = [
      makeAuditEntry({ id: 'a-1', seq: 1, action: 'tool.invoke' }),
      makeAuditEntry({ id: 'a-2', seq: 2, action: 'tool.deny' }),
      makeAuditEntry({ id: 'a-3', seq: 3, action: 'tool.fail' }),
    ];
    const adapter = new ControlPlaneHttpShellAdapter({
      client: makeClient({ recoverTasks: [makeTask()], auditLog: entries }),
    });
    const audit = await adapter.listAuditEntries();
    expect(audit.map((entry) => entry.outcome)).toEqual(['ok', 'denied', 'failed']);
  });

  it('returns the default permission set (all allow)', async () => {
    const adapter = new ControlPlaneHttpShellAdapter({
      client: makeClient({ recoverTasks: [], auditLog: [] }),
    });
    const permissions = await adapter.getPermissions();
    expect(permissions['dashboard']).toBe('allow');
    expect(permissions['settings']).toBe('allow');
  });

  it('honors a custom permission set', async () => {
    const adapter = new ControlPlaneHttpShellAdapter({
      client: makeClient({ recoverTasks: [], auditLog: [] }),
      permissions: {
        dashboard: 'allow',
        agents: 'deny',
        tasks: 'allow',
        sessions: 'allow',
        inboxes: 'allow',
        calendar: 'allow',
        browserDesktop: 'allow',
        approvals: 'allow',
        auditLog: 'allow',
        settings: 'allow',
      },
    });
    const permissions = await adapter.getPermissions();
    expect(permissions['agents']).toBe('deny');
  });

  it('falls back to an empty agent list when the audit replay is unavailable', async () => {
    const adapter = new ControlPlaneHttpShellAdapter({
      client: makeClient({ recoverTasks: [], auditLog: [], recoverFails: true }),
    });
    const agents = await adapter.listAgents();
    expect(agents).toEqual([]);
  });

  it('skips per-session audit reads that fail and keeps the remaining ones', async () => {
    const taskA = makeTask({ id: 't-a', sessionId: 'session-a' });
    const taskB = makeTask({ id: 't-b', sessionId: 'session-b' });
    const entryB = makeAuditEntry({ id: 'a-b', resource: { kind: 'agent', id: 'agent.b' } });
    let callCount = 0;
    const client: ControlPlaneClient = {
      ...makeClient({ recoverTasks: [taskA, taskB] }),
      async getSessionAuditLog(sessionId) {
        callCount += 1;
        if (sessionId === 'session-a') throw new Error('boom');
        return [entryB];
      },
    };
    const adapter = new ControlPlaneHttpShellAdapter({ client });
    const audit = await adapter.listAuditEntries();
    expect(callCount).toBeGreaterThan(0);
    expect(audit).toEqual([expect.objectContaining({ id: 'a-b' })]);
  });
});
