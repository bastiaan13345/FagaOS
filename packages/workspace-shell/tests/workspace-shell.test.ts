import { describe, expect, it } from 'vitest';
import {
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
});
