export type WorkspaceViewId =
  | 'dashboard'
  | 'agents'
  | 'tasks'
  | 'sessions'
  | 'inboxes'
  | 'calendar'
  | 'browserDesktop'
  | 'approvals'
  | 'auditLog'
  | 'settings';

export type PermissionState = 'allow' | 'deny';
export type PermissionSet = Record<WorkspaceViewId, PermissionState>;

export interface WorkspaceNavItemDefinition {
  id: WorkspaceViewId;
  label: string;
  href: string;
}

export interface WorkspaceNavItem extends WorkspaceNavItemDefinition {
  isActive: boolean;
  isVisible: boolean;
  permission: PermissionState;
}

export type AgentStatus =
  | 'active'
  | 'idle'
  | 'running'
  | 'paused'
  | 'degraded'
  | 'disabled'
  | 'archived';
export type TaskStatus =
  | 'draft'
  | 'queued'
  | 'running'
  | 'waiting_on_approval'
  | 'waiting_on_human'
  | 'waiting_on_provider'
  | 'blocked'
  | 'failed'
  | 'cancelled'
  | 'completed'
  | 'archived';
export type WorkspaceSessionState =
  | 'idle'
  | 'running'
  | 'waiting'
  | 'suspect'
  | 'restarting'
  | 'completed'
  | 'dead'
  | 'crashed'
  | 'killed';
export type AccountHealthStatus =
  | 'not_connected'
  | 'linking'
  | 'active'
  | 'reauth_required'
  | 'paused'
  | 'revoked'
  | 'error';
export type ApprovalState =
  | 'requested'
  | 'viewed'
  | 'approved'
  | 'denied'
  | 'edited'
  | 'expired'
  | 'cancelled'
  | 'superseded'
  | 'executed'
  | 'failed';
export type EscalationSeverity = 'info' | 'warning' | 'critical';
export type EscalationState = 'open' | 'acknowledged' | 'resolved';
export type AuditOutcome = 'ok' | 'denied' | 'failed';

export interface WorkspaceAgent {
  id: string;
  name: string;
  role: string;
  status: AgentStatus;
  currentTaskId?: string;
  recentFailureCount: number;
}

export interface WorkspaceTask {
  id: string;
  title: string;
  status: TaskStatus;
  assigneeId: string;
  priority: 'low' | 'medium' | 'high' | 'urgent';
}

export interface WorkspaceSession {
  id: string;
  agentId: string;
  taskId: string;
  state: WorkspaceSessionState;
  lastHeartbeatAt: string;
  currentAction: string;
  pendingApprovalCount: number;
}

export interface WorkspaceAccount {
  id: string;
  provider: string;
  handle: string;
  status: AccountHealthStatus;
  capabilities: string[];
}

export interface WorkspaceApproval {
  id: string;
  action: string;
  state: ApprovalState;
  risk: string;
  resourceLabel: string;
  taskId: string;
  requestedAt: string;
}

export interface WorkspaceEscalation {
  id: string;
  severity: EscalationSeverity;
  title: string;
  state: EscalationState;
  source: string;
  createdAt: string;
}

export interface WorkspaceAuditEntry {
  id: string;
  sequence: number;
  actor: string;
  action: string;
  resource: string;
  outcome: AuditOutcome;
  createdAt: string;
}

export interface WorkspaceReadModels {
  agents: WorkspaceAgent[];
  tasks: WorkspaceTask[];
  sessions: WorkspaceSession[];
  accounts: WorkspaceAccount[];
  approvals: WorkspaceApproval[];
  escalations: WorkspaceEscalation[];
  auditEntries: WorkspaceAuditEntry[];
  permissions: PermissionSet;
}

export type WorkspaceReadModelName = keyof WorkspaceReadModels;

export interface WorkspaceShellAdapter {
  listAgents(): Promise<WorkspaceAgent[]>;
  listTasks(): Promise<WorkspaceTask[]>;
  listSessions(): Promise<WorkspaceSession[]>;
  listAccounts(): Promise<WorkspaceAccount[]>;
  listApprovals(): Promise<WorkspaceApproval[]>;
  listEscalations(): Promise<WorkspaceEscalation[]>;
  listAuditEntries(): Promise<WorkspaceAuditEntry[]>;
  getPermissions(): Promise<PermissionSet>;
}

export interface WorkspaceShellOptions {
  activeView: WorkspaceViewId;
}

export interface DashboardSummary {
  agentHealth: {
    total: number;
    active: number;
    degraded: number;
    paused: number;
  };
  taskSummary: {
    active: number;
    waitingOnApproval: number;
    blocked: number;
    completed: number;
  };
  sessionSummary: {
    running: number;
    suspect: number;
    waiting: number;
  };
  pendingApprovals: {
    total: number;
    urgent: number;
  };
  connectedAccountHealth: {
    total: number;
    healthy: number;
    reauthRequired: number;
    degraded: number;
  };
  recentEscalations: WorkspaceEscalation[];
  recentAuditActivity: WorkspaceAuditEntry[];
}

export type WorkspaceViewState =
  | { kind: 'loading'; message: string }
  | { kind: 'empty'; message: string }
  | { kind: 'error'; message: string }
  | { kind: 'permission_denied'; message: string }
  | { kind: 'ready'; summary: string };

export interface WorkspaceViewSnapshot {
  id: WorkspaceViewId;
  label: string;
  state: WorkspaceViewState;
}

export interface WorkspaceShellSnapshot {
  nav: WorkspaceNavItem[];
  activeView: WorkspaceViewId;
  dashboard: DashboardSummary;
  views: WorkspaceViewSnapshot[];
  degradedSources: WorkspaceReadModelName[];
}

export const WORKSPACE_NAV_ITEMS: WorkspaceNavItemDefinition[] = [
  { id: 'dashboard', label: 'Dashboard', href: '/dashboard' },
  { id: 'agents', label: 'Agents', href: '/agents' },
  { id: 'tasks', label: 'Tasks', href: '/tasks' },
  { id: 'sessions', label: 'Sessions', href: '/sessions' },
  { id: 'inboxes', label: 'Inboxes', href: '/inboxes' },
  { id: 'calendar', label: 'Calendar', href: '/calendar' },
  { id: 'browserDesktop', label: 'Browser/Desktop', href: '/browser-desktop' },
  { id: 'approvals', label: 'Approvals', href: '/approvals' },
  { id: 'auditLog', label: 'Audit Log', href: '/audit-log' },
  { id: 'settings', label: 'Settings', href: '/settings' },
];

const EMPTY_PERMISSIONS: PermissionSet = {
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

export interface MockWorkspaceShellAdapterInput extends Partial<WorkspaceReadModels> {
  failures?: Partial<Record<WorkspaceReadModelName, Error>>;
}

type ReadModelsWithoutPermissions = Omit<WorkspaceReadModels, 'permissions'>;

const EMPTY_READ_MODELS: ReadModelsWithoutPermissions = {
  agents: [],
  tasks: [],
  sessions: [],
  accounts: [],
  approvals: [],
  escalations: [],
  auditEntries: [],
};

export function createMockWorkspaceShellAdapter(
  input: MockWorkspaceShellAdapterInput = {},
): WorkspaceShellAdapter {
  const readModels: WorkspaceReadModels = {
    agents: input.agents ?? [],
    tasks: input.tasks ?? [],
    sessions: input.sessions ?? [],
    accounts: input.accounts ?? [],
    approvals: input.approvals ?? [],
    escalations: input.escalations ?? [],
    auditEntries: input.auditEntries ?? [],
    permissions: input.permissions ?? EMPTY_PERMISSIONS,
  };
  const failures = input.failures ?? {};

  return {
    listAgents: () => resolveModel('agents', readModels.agents, failures),
    listTasks: () => resolveModel('tasks', readModels.tasks, failures),
    listSessions: () => resolveModel('sessions', readModels.sessions, failures),
    listAccounts: () => resolveModel('accounts', readModels.accounts, failures),
    listApprovals: () => resolveModel('approvals', readModels.approvals, failures),
    listEscalations: () => resolveModel('escalations', readModels.escalations, failures),
    listAuditEntries: () => resolveModel('auditEntries', readModels.auditEntries, failures),
    getPermissions: () => resolveModel('permissions', readModels.permissions, failures),
  };
}

async function resolveModel<T>(
  source: WorkspaceReadModelName,
  value: T,
  failures: Partial<Record<WorkspaceReadModelName, Error>>,
): Promise<T> {
  const failure = failures[source];
  if (failure) throw failure;
  return value;
}

export async function loadWorkspaceShell(
  adapter: WorkspaceShellAdapter,
  options: WorkspaceShellOptions,
): Promise<WorkspaceShellSnapshot> {
  const results = await Promise.allSettled([
    adapter.listAgents(),
    adapter.listTasks(),
    adapter.listSessions(),
    adapter.listAccounts(),
    adapter.listApprovals(),
    adapter.listEscalations(),
    adapter.listAuditEntries(),
    adapter.getPermissions(),
  ]);

  const [
    agentsResult,
    tasksResult,
    sessionsResult,
    accountsResult,
    approvalsResult,
    escalationsResult,
    auditEntriesResult,
    permissionsResult,
  ] = results;

  const models: WorkspaceReadModels = {
    agents: resultValue(agentsResult, EMPTY_READ_MODELS.agents),
    tasks: resultValue(tasksResult, EMPTY_READ_MODELS.tasks),
    sessions: resultValue(sessionsResult, EMPTY_READ_MODELS.sessions),
    accounts: resultValue(accountsResult, EMPTY_READ_MODELS.accounts),
    approvals: resultValue(approvalsResult, EMPTY_READ_MODELS.approvals),
    escalations: resultValue(escalationsResult, EMPTY_READ_MODELS.escalations),
    auditEntries: resultValue(auditEntriesResult, EMPTY_READ_MODELS.auditEntries),
    permissions: resultValue(permissionsResult, EMPTY_PERMISSIONS),
  };

  const failures: Partial<Record<WorkspaceReadModelName, string>> = {};
  recordFailure(failures, 'agents', agentsResult);
  recordFailure(failures, 'tasks', tasksResult);
  recordFailure(failures, 'sessions', sessionsResult);
  recordFailure(failures, 'accounts', accountsResult);
  recordFailure(failures, 'approvals', approvalsResult);
  recordFailure(failures, 'escalations', escalationsResult);
  recordFailure(failures, 'auditEntries', auditEntriesResult);
  recordFailure(failures, 'permissions', permissionsResult);

  const nav = WORKSPACE_NAV_ITEMS.map((item) => ({
    ...item,
    isActive: item.id === options.activeView,
    isVisible: true,
    permission: models.permissions[item.id],
  }));

  return {
    nav,
    activeView: options.activeView,
    dashboard: buildDashboard(models),
    views: buildViewSnapshots(models, failures),
    degradedSources: Object.keys(failures) as WorkspaceReadModelName[],
  };
}

function resultValue<T>(result: PromiseSettledResult<T>, fallback: T): T {
  return result.status === 'fulfilled' ? result.value : fallback;
}

function recordFailure<T>(
  failures: Partial<Record<WorkspaceReadModelName, string>>,
  source: WorkspaceReadModelName,
  result: PromiseSettledResult<T>,
): void {
  if (result.status === 'rejected') {
    failures[source] = errorMessage(result.reason);
  }
}

function errorMessage(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  if (typeof reason === 'string') return reason;
  return 'Read model unavailable';
}

function buildDashboard(models: WorkspaceReadModels): DashboardSummary {
  return {
    agentHealth: {
      total: models.agents.length,
      active: models.agents.filter(isActiveAgent).length,
      degraded: models.agents.filter(isDegradedAgent).length,
      paused: models.agents.filter(isPausedAgent).length,
    },
    taskSummary: {
      active: models.tasks.filter(isActiveTask).length,
      waitingOnApproval: models.tasks.filter(isWaitingOnApprovalTask).length,
      blocked: models.tasks.filter(isBlockedTask).length,
      completed: models.tasks.filter(isCompletedTask).length,
    },
    sessionSummary: {
      running: models.sessions.filter((session) => session.state === 'running').length,
      suspect: models.sessions.filter(isSuspectSession).length,
      waiting: models.sessions.filter((session) => session.state === 'waiting').length,
    },
    pendingApprovals: {
      total: models.approvals.filter(isPendingApproval).length,
      urgent: models.approvals.filter(isUrgentApproval).length,
    },
    connectedAccountHealth: {
      total: models.accounts.length,
      healthy: models.accounts.filter((account) => account.status === 'active').length,
      reauthRequired: models.accounts.filter((account) => account.status === 'reauth_required').length,
      degraded: models.accounts.filter(isDegradedAccount).length,
    },
    recentEscalations: [...models.escalations]
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .slice(0, 5),
    recentAuditActivity: [...models.auditEntries].sort((a, b) => b.sequence - a.sequence).slice(0, 5),
  };
}

function isActiveAgent(agent: WorkspaceAgent): boolean {
  return agent.status === 'running' || agent.status === 'active';
}

function isDegradedAgent(agent: WorkspaceAgent): boolean {
  return agent.status === 'degraded';
}

function isPausedAgent(agent: WorkspaceAgent): boolean {
  return agent.status === 'paused';
}

function isActiveTask(task: WorkspaceTask): boolean {
  return task.status === 'running' || task.status === 'queued';
}

function isWaitingOnApprovalTask(task: WorkspaceTask): boolean {
  return task.status === 'waiting_on_approval';
}

function isBlockedTask(task: WorkspaceTask): boolean {
  return task.status === 'blocked' || task.status === 'failed';
}

function isCompletedTask(task: WorkspaceTask): boolean {
  return task.status === 'completed';
}

function isSuspectSession(session: WorkspaceSession): boolean {
  return session.state === 'suspect' || session.state === 'crashed';
}

function isPendingApproval(approval: WorkspaceApproval): boolean {
  return approval.state === 'requested' || approval.state === 'viewed';
}

function isUrgentApproval(approval: WorkspaceApproval): boolean {
  return approval.state === 'requested' && approval.risk.toLowerCase().includes('external');
}

function isDegradedAccount(account: WorkspaceAccount): boolean {
  return account.status === 'revoked' || account.status === 'error' || account.status === 'paused';
}

function buildViewSnapshots(
  models: WorkspaceReadModels,
  failures: Partial<Record<WorkspaceReadModelName, string>>,
): WorkspaceViewSnapshot[] {
  return WORKSPACE_NAV_ITEMS.map((item) => {
    if (models.permissions[item.id] === 'deny') {
      return {
        id: item.id,
        label: item.label,
        state: { kind: 'permission_denied', message: `You do not have permission to view ${item.label}.` },
      };
    }

    const failure = failureForView(item.id, failures);
    if (failure) {
      return { id: item.id, label: item.label, state: { kind: 'error', message: failure } };
    }

    return {
      id: item.id,
      label: item.label,
      state: stateForReadyView(item, models),
    };
  });
}

function failureForView(
  viewId: WorkspaceViewId,
  failures: Partial<Record<WorkspaceReadModelName, string>>,
): string | undefined {
  switch (viewId) {
    case 'dashboard':
      return firstFailure(failures, [
        'agents',
        'tasks',
        'sessions',
        'accounts',
        'approvals',
        'escalations',
        'auditEntries',
      ]);
    case 'agents':
      return failures.agents;
    case 'tasks':
      return failures.tasks;
    case 'sessions':
      return failures.sessions;
    case 'inboxes':
    case 'calendar':
      return failures.accounts;
    case 'browserDesktop':
      return failures.sessions;
    case 'approvals':
      return failures.approvals;
    case 'auditLog':
      return failures.auditEntries;
    case 'settings':
      return failures.permissions;
  }
}

function firstFailure(
  failures: Partial<Record<WorkspaceReadModelName, string>>,
  sources: WorkspaceReadModelName[],
): string | undefined {
  return sources.map((source) => failures[source]).find((message): message is string => Boolean(message));
}

function stateForReadyView(
  item: WorkspaceNavItemDefinition,
  models: WorkspaceReadModels,
): WorkspaceViewState {
  const count = viewCount(item.id, models);
  if (count === 0 && item.id !== 'dashboard' && item.id !== 'settings') {
    return { kind: 'empty', message: emptyMessage(item.id) };
  }
  return { kind: 'ready', summary: readySummary(item.id, count) };
}

function viewCount(viewId: WorkspaceViewId, models: WorkspaceReadModels): number {
  switch (viewId) {
    case 'dashboard':
      return 1;
    case 'agents':
      return models.agents.length;
    case 'tasks':
      return models.tasks.length;
    case 'sessions':
      return models.sessions.length;
    case 'inboxes':
      return models.accounts.filter(hasInboxCapability).length;
    case 'calendar':
      return models.accounts.filter(hasCalendarCapability).length;
    case 'browserDesktop':
      return models.sessions.filter(isBrowserOrDesktopSession).length;
    case 'approvals':
      return models.approvals.length;
    case 'auditLog':
      return models.auditEntries.length;
    case 'settings':
      return 1;
  }
}

function hasInboxCapability(account: WorkspaceAccount): boolean {
  return account.capabilities.some(
    (capability) => capability.includes('mail') || capability.includes('conversation'),
  );
}

function hasCalendarCapability(account: WorkspaceAccount): boolean {
  return account.capabilities.some((capability) => capability.includes('event'));
}

function isBrowserOrDesktopSession(session: WorkspaceSession): boolean {
  return session.currentAction.startsWith('browser.') || session.currentAction.startsWith('desktop.');
}

function emptyMessage(viewId: WorkspaceViewId): string {
  switch (viewId) {
    case 'agents':
      return 'No agents configured';
    case 'tasks':
      return 'No tasks delegated';
    case 'sessions':
      return 'No active sessions';
    case 'inboxes':
      return 'No inbox accounts connected';
    case 'calendar':
      return 'No calendars connected';
    case 'browserDesktop':
      return 'No browser or desktop sessions';
    case 'approvals':
      return 'No approvals waiting';
    case 'auditLog':
      return 'Audit visibility starts here';
    case 'dashboard':
    case 'settings':
      return '';
  }
}

function readySummary(viewId: WorkspaceViewId, count: number): string {
  switch (viewId) {
    case 'dashboard':
      return 'Workspace operations overview';
    case 'settings':
      return 'Workspace policy and account settings';
    default:
      return `${count} ${count === 1 ? 'item' : 'items'}`;
  }
}

export function renderWorkspaceShellHtml(snapshot: WorkspaceShellSnapshot): string {
  const activeView = snapshot.views.find((view) => view.id === snapshot.activeView) ?? snapshot.views[0];
  const viewState = activeView?.state ?? { kind: 'error', message: 'View unavailable' };

  return [
    '<main class="workspace-shell">',
    '<aside class="workspace-shell__nav" aria-label="Workspace">',
    '<a class="workspace-shell__brand" href="/dashboard">FagaOS</a>',
    '<nav>',
    snapshot.nav.map(renderNavItem).join(''),
    '</nav>',
    '</aside>',
    '<section class="workspace-shell__content">',
    renderDashboard(snapshot.dashboard),
    renderViewState(activeView?.label ?? 'Workspace', viewState),
    renderInactiveViewStates(snapshot.views, snapshot.activeView),
    '</section>',
    '</main>',
  ].join('');
}

function renderNavItem(item: WorkspaceNavItem): string {
  const active = item.isActive ? ' aria-current="page"' : '';
  const denied = item.permission === 'deny' ? ' data-permission="denied"' : '';
  return `<a href="${escapeHtml(item.href)}"${active}${denied}>${escapeHtml(item.label)}</a>`;
}

function renderDashboard(dashboard: DashboardSummary): string {
  return [
    '<section class="workspace-shell__dashboard" aria-label="Dashboard summary">',
    `<article><h2>Agent health</h2><strong>${dashboard.agentHealth.active}/${dashboard.agentHealth.total}</strong><span>${dashboard.agentHealth.degraded} degraded</span></article>`,
    `<article><h2>Active tasks</h2><strong>${dashboard.taskSummary.active}</strong><span>${dashboard.taskSummary.waitingOnApproval} waiting approval</span></article>`,
    `<article><h2>Pending approvals</h2><strong>${dashboard.pendingApprovals.total}</strong><span>${dashboard.pendingApprovals.urgent} urgent</span></article>`,
    `<article><h2>Connected accounts</h2><strong>${dashboard.connectedAccountHealth.healthy}/${dashboard.connectedAccountHealth.total}</strong><span>${dashboard.connectedAccountHealth.reauthRequired} need reauth</span></article>`,
    renderRecentList('Recent escalations', dashboard.recentEscalations.map((item) => item.title)),
    renderRecentList('Recent audit activity', dashboard.recentAuditActivity.map((item) => `${item.actor} ${item.action}`)),
    '</section>',
  ].join('');
}

function renderRecentList(label: string, items: string[]): string {
  const body =
    items.length > 0
      ? `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`
      : '<p>No recent activity</p>';
  return `<article><h2>${escapeHtml(label)}</h2>${body}</article>`;
}

function renderViewState(label: string, state: WorkspaceViewState): string {
  switch (state.kind) {
    case 'loading':
      return `<section aria-busy="true"><h1>${escapeHtml(label)}</h1><p>${escapeHtml(state.message)}</p></section>`;
    case 'empty':
      return `<section><h1>${escapeHtml(label)}</h1><p>${escapeHtml(state.message)}</p></section>`;
    case 'error':
      return `<section role="alert"><h1>${escapeHtml(label)}</h1><p>${escapeHtml(state.message)}</p></section>`;
    case 'permission_denied':
      return `<section><h1>Permission required</h1><p>${escapeHtml(state.message)}</p></section>`;
    case 'ready':
      return `<section><h1>${escapeHtml(label)}</h1><p>${escapeHtml(state.summary)}</p></section>`;
  }
}

function renderInactiveViewStates(
  views: WorkspaceViewSnapshot[],
  activeView: WorkspaceViewId,
): string {
  return views
    .filter((view) => view.id !== activeView)
    .map(
      (view) =>
        `<template data-view-state="${escapeHtml(view.id)}">${renderViewState(view.label, view.state)}</template>`,
    )
    .join('');
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
