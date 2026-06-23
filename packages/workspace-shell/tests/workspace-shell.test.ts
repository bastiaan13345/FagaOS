import { describe, expect, it } from 'vitest';
import { AgentCardSchema, type AgentCard } from '../../agent-manifest/src/index.js';
import { createInMemoryAuditLog } from '../../audit-log/src/index.js';
import {
  ControlPlane,
  createInMemoryCardRegistry,
} from '../../control-plane/src/index.js';
import {
  ControlPlaneWorkspaceOperationsAdapter,
  createMockWorkspaceShellAdapter,
  loadWorkspaceShell,
  renderWorkspaceShellHtml,
  WORKSPACE_NAV_ITEMS,
  type PermissionSet,
  type WorkspaceShellSnapshot,
} from '../src/index.js';

const basePermissions: PermissionSet = {
  dashboard: 'allow',
  agents: 'allow',
  tasks: 'allow',
  sessions: 'allow',
  inboxes: 'allow',
  calendar: 'allow',
  browserDesktop: 'allow',
  approvals: 'allow',
  auditLog: 'allow',
  settings: 'allow',
};

describe('@fagaos/workspace-shell', () => {
  it('defines persistent navigation for every first workspace view', () => {
    expect(WORKSPACE_NAV_ITEMS.map((item) => item.id)).toEqual([
      'dashboard',
      'agents',
      'tasks',
      'sessions',
      'inboxes',
      'calendar',
      'browserDesktop',
      'approvals',
      'auditLog',
      'settings',
    ]);
    expect(WORKSPACE_NAV_ITEMS.map((item) => item.label)).toEqual([
      'Dashboard',
      'Agents',
      'Tasks',
      'Sessions',
      'Inboxes',
      'Calendar',
      'Browser/Desktop',
      'Approvals',
      'Audit Log',
      'Settings',
    ]);
  });

  it('loads dashboard health, approval urgency, account health, escalations, and audit activity from a typed adapter', async () => {
    const adapter = createMockWorkspaceShellAdapter({
      agents: [
        {
          id: 'agent.ops',
          name: 'Ops Agent',
          role: 'operator',
          status: 'running',
          currentTaskId: 'task.1',
          recentFailureCount: 0,
        },
        {
          id: 'agent.mail',
          name: 'Mail Agent',
          role: 'inbox triage',
          status: 'degraded',
          recentFailureCount: 2,
        },
      ],
      tasks: [
        { id: 'task.1', title: 'Prepare agenda', status: 'running', assigneeId: 'agent.ops', priority: 'high' },
        {
          id: 'task.2',
          title: 'Send follow-up',
          status: 'waiting_on_approval',
          assigneeId: 'agent.mail',
          priority: 'medium',
        },
      ],
      sessions: [
        {
          id: 'session.1',
          agentId: 'agent.ops',
          taskId: 'task.1',
          state: 'running',
          lastHeartbeatAt: '2026-06-15T12:00:00.000Z',
          currentAction: 'browser.navigate',
          pendingApprovalCount: 0,
        },
      ],
      accounts: [
        {
          id: 'account.gmail',
          provider: 'gmail',
          handle: 'ops@example.com',
          status: 'active',
          capabilities: ['read_mail', 'send_mail'],
        },
        {
          id: 'account.calendar',
          provider: 'google_calendar',
          handle: 'calendar@example.com',
          status: 'reauth_required',
          capabilities: ['list_events', 'create_event'],
        },
      ],
      approvals: [
        {
          id: 'approval.1',
          action: 'send_mail',
          state: 'requested',
          risk: 'external send',
          resourceLabel: 'Follow-up email',
          taskId: 'task.2',
          requestedAt: '2026-06-15T12:05:00.000Z',
        },
      ],
      escalations: [
        {
          id: 'escalation.1',
          severity: 'warning',
          title: 'Calendar account needs reauth',
          state: 'open',
          source: 'account.calendar',
          createdAt: '2026-06-15T12:03:00.000Z',
        },
      ],
      auditEntries: [
        {
          id: 'audit.1',
          sequence: 42,
          actor: 'agent.ops',
          action: 'tool.invoke',
          resource: 'browser.navigate',
          outcome: 'ok',
          createdAt: '2026-06-15T12:04:00.000Z',
        },
      ],
      permissions: basePermissions,
    });

    const shell = await loadWorkspaceShell(adapter, { activeView: 'dashboard' });

    expect(shell.dashboard.agentHealth).toMatchObject({
      total: 2,
      active: 1,
      degraded: 1,
    });
    expect(shell.dashboard.taskSummary).toMatchObject({
      active: 1,
      waitingOnApproval: 1,
    });
    expect(shell.dashboard.pendingApprovals.total).toBe(1);
    expect(shell.dashboard.connectedAccountHealth).toMatchObject({
      healthy: 1,
      reauthRequired: 1,
    });
    expect(shell.dashboard.recentEscalations[0]?.title).toBe('Calendar account needs reauth');
    expect(shell.dashboard.recentAuditActivity[0]?.action).toBe('tool.invoke');
  });

  it('renders empty states for every top-level view when read models are empty', async () => {
    const shell = await loadWorkspaceShell(createMockWorkspaceShellAdapter({ permissions: basePermissions }), {
      activeView: 'agents',
    });

    expect(Object.fromEntries(shell.views.map((view) => [view.id, view.state.kind]))).toEqual({
      dashboard: 'ready',
      agents: 'empty',
      tasks: 'empty',
      sessions: 'empty',
      inboxes: 'empty',
      calendar: 'empty',
      browserDesktop: 'empty',
      approvals: 'empty',
      auditLog: 'empty',
      settings: 'ready',
    });
    expect(renderWorkspaceShellHtml(shell)).toContain('No agents configured');
    expect(renderWorkspaceShellHtml(shell)).toContain('Audit visibility starts here');
  });

  it('marks degraded backend responses without hiding the rest of the shell', async () => {
    const shell = await loadWorkspaceShell(
      createMockWorkspaceShellAdapter({
        permissions: basePermissions,
        failures: {
          sessions: new Error('control-plane read model unavailable'),
          auditEntries: new Error('audit store unavailable'),
        },
      }),
      { activeView: 'sessions' },
    );

    expect(shell.views.find((view) => view.id === 'sessions')?.state).toEqual({
      kind: 'error',
      message: 'control-plane read model unavailable',
    });
    expect(shell.views.find((view) => view.id === 'auditLog')?.state).toEqual({
      kind: 'error',
      message: 'audit store unavailable',
    });
    expect(shell.views.find((view) => view.id === 'approvals')?.state.kind).toBe('empty');
    expect(shell.degradedSources).toEqual(['sessions', 'auditEntries']);
  });

  it('honors permission-denied views and keeps approval and audit navigation visible', async () => {
    const permissions: PermissionSet = {
      ...basePermissions,
      browserDesktop: 'deny',
      settings: 'deny',
    };
    const shell = await loadWorkspaceShell(createMockWorkspaceShellAdapter({ permissions }), {
      activeView: 'browserDesktop',
    });

    expect(shell.views.find((view) => view.id === 'browserDesktop')?.state).toEqual({
      kind: 'permission_denied',
      message: 'You do not have permission to view Browser/Desktop.',
    });
    expect(shell.nav.find((item) => item.id === 'approvals')?.isVisible).toBe(true);
    expect(shell.nav.find((item) => item.id === 'auditLog')?.isVisible).toBe(true);
    expect(renderWorkspaceShellHtml(shell)).toContain('Permission required');
  });

  it('supports loading states while adapters resolve asynchronously', () => {
    const snapshot: WorkspaceShellSnapshot = {
      nav: WORKSPACE_NAV_ITEMS.map((item) => ({
        ...item,
        isActive: item.id === 'dashboard',
        isVisible: true,
        permission: 'allow',
      })),
      activeView: 'dashboard',
      dashboard: {
        agentHealth: { total: 0, active: 0, degraded: 0, paused: 0 },
        taskSummary: { active: 0, waitingOnApproval: 0, blocked: 0, completed: 0 },
        sessionSummary: { running: 0, suspect: 0, waiting: 0 },
        pendingApprovals: { total: 0, urgent: 0 },
        connectedAccountHealth: { total: 0, healthy: 0, reauthRequired: 0, degraded: 0 },
        recentEscalations: [],
        recentAuditActivity: [],
      },
      views: WORKSPACE_NAV_ITEMS.map((item) => ({
        id: item.id,
        label: item.label,
        state: { kind: 'loading', message: `Loading ${item.label}...` },
      })),
      degradedSources: [],
    };

    const html = renderWorkspaceShellHtml(snapshot);

    expect(html).toContain('Loading Dashboard...');
    expect(html).toContain('aria-busy="true"');
  });

  it('builds agent, task, session, and audit read models from durable control-plane state', async () => {
    const fixture = await createControlPlaneFixture();
    const task = await fixture.controlPlane.enqueueTask({
      sessionId: fixture.sessionId,
      tool: 'browser.navigate',
      arguments: { url: 'https://example.test' },
      createdBy: { id: 'user:alice', type: 'user' },
      capabilityCheck: { ok: true, policyId: 'policy.browser' },
      maxAttempts: 2,
    });
    await fixture.controlPlane.claimTask({ workerId: 'worker-1', leaseMs: 30_000 });

    const adapter = new ControlPlaneWorkspaceOperationsAdapter({
      controlPlane: fixture.controlPlane,
      audit: fixture.audit,
      cards: fixture.cards,
      now: () => new Date('2026-06-15T12:00:10.000Z'),
    });

    await expect(adapter.listAgents()).resolves.toEqual([
      expect.objectContaining({
        id: 'agent.ops',
        name: 'Ops Agent',
        status: 'running',
        currentTaskId: task.id,
        capabilities: ['browser.navigate', 'email.send'],
        policyScope: 'policy.browser',
        recentTaskIds: [task.id],
        health: expect.objectContaining({ state: 'running', recentFailureCount: 0 }),
      }),
    ]);
    await expect(adapter.listTasks()).resolves.toEqual([
      expect.objectContaining({
        id: task.id,
        status: 'running',
        assigneeId: 'agent.ops',
        sessionId: fixture.sessionId,
        dependencies: [fixture.sessionId],
        timeline: expect.arrayContaining([
          expect.objectContaining({ state: 'queued', source: 'task.enqueue' }),
          expect.objectContaining({ state: 'running', source: 'task.claim' }),
        ]),
      }),
    ]);
    await expect(adapter.listSessions()).resolves.toEqual([
      expect.objectContaining({
        id: fixture.sessionId,
        agentId: 'agent.ops',
        taskId: task.id,
        state: 'running',
        currentAgentTool: 'browser.navigate',
        pendingApprovalCount: 0,
        runtimeMs: 10_000,
        cost: { amount: 0, currency: 'USD' },
      }),
    ]);
    await expect(adapter.listAuditEntries()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actor: 'user:alice',
          action: 'task.enqueue',
          resource: task.id,
          outcome: 'ok',
        }),
      ]),
    );
  });

  it('maps denied capability checks and stale leases into permission-safe workflow states', async () => {
    const fixture = await createControlPlaneFixture();
    const denied = await fixture.controlPlane.enqueueTask({
      sessionId: fixture.sessionId,
      tool: 'email.send',
      arguments: {},
      createdBy: { id: 'user:alice', type: 'user' },
      capabilityCheck: { ok: false, reason: 'requires approval' },
    });
    const stale = await fixture.controlPlane.enqueueTask({
      sessionId: fixture.sessionId,
      tool: 'browser.navigate',
      arguments: {},
      createdBy: { id: 'user:alice', type: 'user' },
      capabilityCheck: { ok: true },
    });
    await fixture.controlPlane.claimTask({ workerId: 'worker-1', leaseMs: 1_000 });

    const adapter = new ControlPlaneWorkspaceOperationsAdapter({
      controlPlane: fixture.controlPlane,
      audit: fixture.audit,
      cards: fixture.cards,
      now: () => new Date('2026-06-15T12:00:02.000Z'),
    });

    const tasks = await adapter.listTasks();
    const sessions = await adapter.listSessions();

    expect(tasks.find((task) => task.id === denied.id)?.status).toBe('waiting_on_approval');
    expect(tasks.find((task) => task.id === stale.id)?.status).toBe('blocked');
    expect(sessions[0]?.state).toBe('suspect');
  });

  it('requires explicit operator permissions before intervention actions mutate control-plane state', async () => {
    const fixture = await createControlPlaneFixture();
    const task = await fixture.controlPlane.enqueueTask({
      sessionId: fixture.sessionId,
      tool: 'browser.navigate',
      arguments: {},
      createdBy: { id: 'user:alice', type: 'user' },
      capabilityCheck: { ok: true },
    });
    const adapter = new ControlPlaneWorkspaceOperationsAdapter({
      controlPlane: fixture.controlPlane,
      audit: fixture.audit,
      cards: fixture.cards,
    });

    await expect(
      adapter.cancelTask({
        taskId: task.id,
        reason: 'operator denied test',
        actor: { id: 'user:bob', type: 'user', permissions: [] },
      }),
    ).rejects.toMatchObject({ code: 'permission_denied' });
    expect(fixture.controlPlane.getTask(task.id).state).toBe('queued');

    await adapter.cancelTask({
      taskId: task.id,
      reason: 'operator request',
      actor: { id: 'user:alice', type: 'user', permissions: ['tasks:cancel'] },
    });
    expect(fixture.controlPlane.getTask(task.id)).toMatchObject({
      state: 'cancelled',
      terminalReason: 'operator request',
    });

    await expect(
      adapter.killSession({
        sessionId: fixture.sessionId,
        reason: 'operator denied test',
        actor: { id: 'user:bob', type: 'user', permissions: [] },
      }),
    ).rejects.toMatchObject({ code: 'permission_denied' });

    await adapter.killSession({
      sessionId: fixture.sessionId,
      reason: 'operator kill',
      actor: { id: 'user:alice', type: 'user', permissions: ['sessions:kill'] },
    });
    expect(fixture.controlPlane.getSession(fixture.sessionId).state).toBe('killed');
  });
});

function card(): AgentCard {
  return AgentCardSchema.parse({
    id: 'agent.ops',
    name: 'Ops Agent',
    description: 'Runs browser and email operations',
    version: '1.0.0',
    owner: { id: 'team:ops' },
    auth: { kind: 'none' },
    capabilities: [
      { name: 'browser.navigate', scope: 'workspace' },
      { name: 'email.send', scope: 'external' },
    ],
    toolServers: [
      {
        id: 'browser',
        implementation: 'tool.browser',
        category: 'browser',
        endpoints: ['browser-mcp'],
      },
    ],
    mcpEndpoints: [
      {
        id: 'browser-mcp',
        name: 'Browser MCP',
        role: 'client',
        transport: 'stdio',
        command: 'browser-mcp',
      },
    ],
  });
}

async function createControlPlaneFixture(): Promise<{
  audit: ReturnType<typeof createInMemoryAuditLog>;
  cards: ReturnType<typeof createInMemoryCardRegistry>;
  controlPlane: ControlPlane;
  sessionId: string;
}> {
  const audit = createInMemoryAuditLog({ clock: () => new Date('2026-06-15T12:00:00.000Z') });
  const cards = createInMemoryCardRegistry();
  cards.register(card());
  const controlPlane = new ControlPlane({
    audit,
    cards,
    clock: () => new Date('2026-06-15T12:00:00.000Z'),
  });
  const session = await controlPlane.createSession({
    agentId: 'agent.ops',
    createdBy: { id: 'user:alice', type: 'user' },
    input: { taskId: 'task.manual' },
  });
  return { audit, cards, controlPlane, sessionId: session.id };
}
