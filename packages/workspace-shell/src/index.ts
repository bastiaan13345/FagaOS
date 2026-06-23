import type { AgentCard } from '@fagaos/agent-manifest';
import type { AuditEntry, AuditLog } from '@fagaos/audit-log';
import type {
  AgentCardRegistry,
  ControlPlane,
  ControlPlaneTask,
  Session,
} from '@fagaos/control-plane';

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
  capabilities?: string[];
  connectedAccountIds?: string[];
  policyScope?: string;
  recentTaskIds?: string[];
  health?: {
    state: AgentStatus;
    recentFailureCount: number;
    lastActiveAt?: string;
  };
  actions?: WorkspaceInterventionAction[];
}

export interface WorkspaceTask {
  id: string;
  title: string;
  status: TaskStatus;
  assigneeId: string;
  priority: 'low' | 'medium' | 'high' | 'urgent';
  sessionId?: string;
  dependencies?: string[];
  timeline?: WorkspaceTaskTimelineEntry[];
  artifacts?: WorkspaceArtifact[];
  comments?: WorkspaceComment[];
  retry?: {
    attempt: number;
    maxAttempts: number;
  };
  actions?: WorkspaceInterventionAction[];
}

export interface WorkspaceSession {
  id: string;
  agentId: string;
  taskId: string;
  state: WorkspaceSessionState;
  lastHeartbeatAt: string;
  currentAction: string;
  pendingApprovalCount: number;
  currentAgentTool?: string | null;
  checkpoints?: WorkspaceCheckpoint[];
  toolCalls?: WorkspaceToolCall[];
  pendingApprovals?: WorkspaceApproval[];
  logs?: WorkspaceAuditEntry[];
  artifacts?: WorkspaceArtifact[];
  cost?: WorkspaceCostCounter;
  runtimeMs?: number;
  actions?: WorkspaceInterventionAction[];
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

export type WorkspaceInterventionKind =
  | 'agent.edit'
  | 'agent.pause'
  | 'agent.archive'
  | 'task.retry'
  | 'task.cancel'
  | 'session.pause'
  | 'session.resume'
  | 'session.kill'
  | 'session.escalate';

export interface WorkspaceInterventionAction {
  kind: WorkspaceInterventionKind;
  label: string;
  permission: WorkspaceOperatorPermission;
  enabled: boolean;
  reason?: string;
}

export interface WorkspaceTaskTimelineEntry {
  state: TaskStatus;
  at: string;
  actor: string;
  source: string;
}

export interface WorkspaceArtifact {
  id: string;
  label: string;
  kind: string;
  createdAt: string;
}

export interface WorkspaceComment {
  id: string;
  actor: string;
  body: string;
  createdAt: string;
}

export interface WorkspaceCheckpoint {
  id: string;
  label: string;
  createdAt: string;
}

export interface WorkspaceToolCall {
  id: string;
  tool: string;
  ok: boolean;
  durationMs: number;
  createdAt: string;
  error: string | null;
}

export interface WorkspaceCostCounter {
  amount: number;
  currency: 'USD';
}

export type WorkspaceOperatorPermission =
  | 'agents:edit'
  | 'agents:pause'
  | 'agents:archive'
  | 'tasks:retry'
  | 'tasks:cancel'
  | 'sessions:pause'
  | 'sessions:resume'
  | 'sessions:kill'
  | 'sessions:escalate';

export interface WorkspaceOperationActor {
  id: string;
  type: 'user' | 'agent' | 'system';
  permissions: WorkspaceOperatorPermission[];
}

export class WorkspacePermissionError extends Error {
  readonly code = 'permission_denied';

  constructor(
    public readonly permission: WorkspaceOperatorPermission,
    message = `Missing permission: ${permission}`,
  ) {
    super(message);
    this.name = 'WorkspacePermissionError';
  }
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

export interface ControlPlaneWorkspaceOperationsAdapterOptions {
  controlPlane: ControlPlane;
  audit: AuditLog;
  cards: AgentCardRegistry;
  now?: () => Date;
}

export interface CancelWorkspaceTaskInput {
  taskId: string;
  reason: string;
  actor: WorkspaceOperationActor;
}

export interface KillWorkspaceSessionInput {
  sessionId: string;
  reason: string;
  actor: WorkspaceOperationActor;
}

export interface EscalateWorkspaceSessionInput {
  sessionId: string;
  reason: string;
  severity: EscalationSeverity;
  actor: WorkspaceOperationActor;
}

export class ControlPlaneWorkspaceOperationsAdapter implements WorkspaceShellAdapter {
  private readonly controlPlane: ControlPlane;
  private readonly audit: AuditLog;
  private readonly cards: AgentCardRegistry;
  private readonly now: () => Date;

  constructor(opts: ControlPlaneWorkspaceOperationsAdapterOptions) {
    this.controlPlane = opts.controlPlane;
    this.audit = opts.audit;
    this.cards = opts.cards;
    this.now = opts.now ?? (() => new Date());
  }

  async listAgents(): Promise<WorkspaceAgent[]> {
    const tasks = this.controlPlane.listTasks();
    const sessions = this.controlPlane.listSessions();
    return this.cards.list().map((card) => {
      const agentSessions = sessions.filter((session) => session.agentId === card.id);
      const agentTasks = tasks.filter((task) =>
        agentSessions.some((session) => session.id === task.sessionId),
      );
      const activeTask = findCurrentTask(agentTasks, this.now());
      const recentFailures = agentTasks.filter((task) => task.state === 'failed').length;
      const status = agentStatus(card, agentTasks, agentSessions, this.now());
      const policyScope = firstPolicyScope(card, agentTasks);
      return withOptionalFields<WorkspaceAgent>({
        id: card.id,
        name: card.name,
        role: card.owner.name ?? card.owner.id,
        status,
        recentFailureCount: recentFailures,
        ...optionalField('currentTaskId', activeTask?.id),
        capabilities: card.capabilities.map((capability) => capability.name),
        connectedAccountIds: accountIdsFromCard(card),
        ...optionalField('policyScope', policyScope),
        recentTaskIds: [...agentTasks]
          .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
          .slice(0, 5)
          .map((task) => task.id),
        health: withOptionalFields({
          state: status,
          recentFailureCount: recentFailures,
          ...optionalField('lastActiveAt', activeTask?.updatedAt ?? agentSessions[0]?.updatedAt),
        }),
        actions: agentActions(status),
      });
    });
  }

  async listTasks(): Promise<WorkspaceTask[]> {
    const auditEntries = await this.audit.read({ limit: 1000 });
    const sessions = this.controlPlane.listSessions();
    return this.controlPlane.listTasks().map((task) => {
      const session = sessions.find((candidate) => candidate.id === task.sessionId);
      const status = mapTaskStatus(task, this.now());
      return {
        id: task.id,
        title: task.tool,
        status,
        assigneeId: session?.agentId ?? task.createdBy.id,
        priority: taskPriority(task, status),
        sessionId: task.sessionId,
        dependencies: [task.sessionId],
        timeline: taskTimeline(task, auditEntries, this.now()),
        artifacts: artifactsFromTask(task),
        comments: commentsFromTask(task),
        retry: { attempt: task.attempt, maxAttempts: task.maxAttempts },
        actions: taskActions(task, status),
      };
    });
  }

  async listSessions(): Promise<WorkspaceSession[]> {
    const tasks = this.controlPlane.listTasks();
    const auditEntries = await this.audit.read({ limit: 1000 });
    const toolCalls = this.controlPlane.listToolInvocations();
    return this.controlPlane.listSessions().map((session) => {
      const sessionTasks = tasks.filter((task) => task.sessionId === session.id);
      const currentTask = findCurrentTask(sessionTasks, this.now());
      const currentTool = currentTask?.tool ?? latestToolCall(toolCalls, session.id)?.tool ?? null;
      const logs = auditEntries
        .filter((entry) => entry.resource.id === session.id || entry.data['sessionId'] === session.id)
        .map(mapAuditEntry);
      const pendingApprovals = approvalsForTasks(sessionTasks);
      return withOptionalFields<WorkspaceSession>({
        id: session.id,
        agentId: session.agentId,
        taskId: currentTask?.id ?? session.input['taskId']?.toString() ?? session.id,
        state: mapSessionState(session, sessionTasks, this.now()),
        lastHeartbeatAt: currentTask?.updatedAt ?? session.updatedAt,
        currentAction: currentTool ?? session.state,
        pendingApprovalCount: pendingApprovals.length,
        currentAgentTool: currentTool,
        checkpoints: checkpointsFromAudit(logs),
        toolCalls: toolCalls
          .filter((call) => call.sessionId === session.id)
          .map((call) => ({
            id: call.id,
            tool: call.tool,
            ok: call.ok,
            durationMs: call.durationMs,
            createdAt: call.createdAt,
            error: call.error,
          })),
        pendingApprovals,
        logs,
        artifacts: artifactsFromSession(session, sessionTasks),
        cost: { amount: 0, currency: 'USD' },
        runtimeMs: Math.max(0, this.now().getTime() - Date.parse(session.createdAt)),
        actions: sessionActions(session, sessionTasks, this.now()),
      });
    });
  }

  async listAccounts(): Promise<WorkspaceAccount[]> {
    return [];
  }

  async listApprovals(): Promise<WorkspaceApproval[]> {
    return approvalsForTasks(this.controlPlane.listTasks());
  }

  async listEscalations(): Promise<WorkspaceEscalation[]> {
    const tasks = this.controlPlane.listTasks();
    return tasks
      .filter((task) => mapTaskStatus(task, this.now()) === 'blocked')
      .map((task) => ({
        id: `escalation:${task.id}`,
        severity: 'warning',
        title: `Task ${task.id} requires operator review`,
        state: 'open',
        source: task.id,
        createdAt: task.updatedAt,
      }));
  }

  async listAuditEntries(): Promise<WorkspaceAuditEntry[]> {
    const entries = await this.audit.read({ limit: 1000 });
    return entries.map(mapAuditEntry);
  }

  async getPermissions(): Promise<PermissionSet> {
    return EMPTY_PERMISSIONS;
  }

  async cancelTask(input: CancelWorkspaceTaskInput): Promise<WorkspaceTask> {
    await this.requirePermission(input.actor, 'tasks:cancel', { kind: 'task', id: input.taskId });
    const task = await this.controlPlane.cancelTask(input.taskId, {
      reason: input.reason,
      actor: { id: input.actor.id, type: input.actor.type },
    });
    return (await this.listTasks()).find((item) => item.id === task.id)!;
  }

  async killSession(input: KillWorkspaceSessionInput): Promise<WorkspaceSession> {
    await this.requirePermission(input.actor, 'sessions:kill', {
      kind: 'session',
      id: input.sessionId,
    });
    await this.controlPlane.killSession(input.sessionId, input.reason);
    return (await this.listSessions()).find((item) => item.id === input.sessionId)!;
  }

  async escalateSession(input: EscalateWorkspaceSessionInput): Promise<WorkspaceEscalation> {
    await this.requirePermission(input.actor, 'sessions:escalate', {
      kind: 'session',
      id: input.sessionId,
    });
    const result = await this.audit.append({
      actor: { id: input.actor.id, type: input.actor.type },
      action: 'session.escalate',
      resource: { kind: 'session', id: input.sessionId },
      data: { reason: input.reason, severity: input.severity },
    });
    return {
      id: `escalation:${result.id}`,
      severity: input.severity,
      title: input.reason,
      state: 'open',
      source: input.sessionId,
      createdAt: result.ts,
    };
  }

  private async requirePermission(
    actor: WorkspaceOperationActor,
    permission: WorkspaceOperatorPermission,
    resource: { kind: string; id: string },
  ): Promise<void> {
    if (actor.permissions.includes(permission)) return;
    await this.audit.append({
      actor: { id: actor.id, type: actor.type },
      action: 'intervention.deny',
      resource,
      data: { permission },
    });
    throw new WorkspacePermissionError(permission);
  }
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

function withOptionalFields<T extends object>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, field]) => field !== undefined),
  ) as T;
}

function optionalField<K extends string, V>(
  key: K,
  value: V | undefined,
): V extends undefined ? Record<never, never> : Partial<Record<K, V>> {
  return (value === undefined ? {} : { [key]: value }) as V extends undefined
    ? Record<never, never>
    : Partial<Record<K, V>>;
}

function agentStatus(
  _card: AgentCard,
  tasks: ControlPlaneTask[],
  sessions: Session[],
  now: Date,
): AgentStatus {
  if (sessions.some((session) => session.state === 'killed')) return 'disabled';
  if (tasks.some((task) => mapTaskStatus(task, now) === 'blocked')) return 'degraded';
  if (tasks.some((task) => mapTaskStatus(task, now) === 'running')) return 'running';
  if (sessions.some((session) => session.state === 'running')) return 'active';
  return 'idle';
}

function firstPolicyScope(card: AgentCard, tasks: ControlPlaneTask[]): string | undefined {
  const fromTask = tasks.find((task) => task.capabilityCheck.policyId)?.capabilityCheck.policyId;
  return fromTask ?? card.capabilities.find((capability) => capability.scope)?.scope;
}

function accountIdsFromCard(card: AgentCard): string[] {
  const metadataAccounts = card.metadata?.['connectedAccountIds'];
  return typeof metadataAccounts === 'string' ? metadataAccounts.split(',').filter(Boolean) : [];
}

function findCurrentTask(tasks: ControlPlaneTask[], now: Date): ControlPlaneTask | undefined {
  return [...tasks]
    .filter((task) => ['queued', 'running', 'waiting_on_approval', 'blocked'].includes(mapTaskStatus(task, now)))
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];
}

function mapTaskStatus(task: ControlPlaneTask, now: Date): TaskStatus {
  if (!task.capabilityCheck.ok) return 'waiting_on_approval';
  if (task.state === 'queued') return 'queued';
  if (task.state === 'claimed') {
    if (task.leaseExpiresAt !== null && Date.parse(task.leaseExpiresAt) <= now.getTime()) {
      return 'blocked';
    }
    return 'running';
  }
  if (task.state === 'completed') return 'completed';
  if (task.state === 'failed') return 'failed';
  if (task.state === 'cancelled') return 'cancelled';
  return exhaustiveTaskState(task.state);
}

function exhaustiveTaskState(state: never): never {
  throw new Error(`Unhandled task state: ${state}`);
}

function taskPriority(task: ControlPlaneTask, status: TaskStatus): WorkspaceTask['priority'] {
  if (status === 'blocked' || status === 'failed') return 'high';
  if (!task.capabilityCheck.ok) return 'urgent';
  return 'medium';
}

function taskTimeline(
  task: ControlPlaneTask,
  entries: AuditEntry[],
  now: Date,
): WorkspaceTaskTimelineEntry[] {
  const fromAudit = entries
    .filter((entry) => entry.resource.kind === 'task' && entry.resource.id === task.id)
    .map((entry) => ({
      state: timelineState(entry.action, task, now),
      at: entry.ts,
      actor: entry.actor.id,
      source: entry.action,
    }));
  if (fromAudit.length > 0) return fromAudit;
  return [
    {
      state: mapTaskStatus(task, now),
      at: task.updatedAt,
      actor: task.createdBy.id,
      source: 'repository',
    },
  ];
}

function timelineState(action: string, task: ControlPlaneTask, now: Date): TaskStatus {
  switch (action) {
    case 'task.enqueue':
    case 'task.retry':
      return task.capabilityCheck.ok ? 'queued' : 'waiting_on_approval';
    case 'task.claim':
    case 'task.heartbeat':
      return mapTaskStatus(task, now) === 'blocked' ? 'blocked' : 'running';
    case 'task.complete':
      return 'completed';
    case 'task.fail':
      return 'failed';
    case 'task.cancel':
      return 'cancelled';
    case 'task.recover':
      return 'queued';
    default:
      return mapTaskStatus(task, now);
  }
}

function artifactsFromTask(task: ControlPlaneTask): WorkspaceArtifact[] {
  if (!task.result) return [];
  return [
    {
      id: `artifact:${task.id}:result`,
      label: `${task.tool} result`,
      kind: 'task_result',
      createdAt: task.updatedAt,
    },
  ];
}

function artifactsFromSession(session: Session, tasks: ControlPlaneTask[]): WorkspaceArtifact[] {
  const taskArtifacts = tasks.flatMap(artifactsFromTask);
  if (!session.result) return taskArtifacts;
  return [
    ...taskArtifacts,
    {
      id: `artifact:${session.id}:result`,
      label: 'Session result',
      kind: 'session_result',
      createdAt: session.updatedAt,
    },
  ];
}

function commentsFromTask(task: ControlPlaneTask): WorkspaceComment[] {
  return task.terminalReason
    ? [
        {
          id: `comment:${task.id}:terminal`,
          actor: task.claimedBy ?? task.createdBy.id,
          body: task.terminalReason,
          createdAt: task.updatedAt,
        },
      ]
    : [];
}

function mapSessionState(
  session: Session,
  tasks: ControlPlaneTask[],
  now: Date,
): WorkspaceSessionState {
  if (tasks.some((task) => mapTaskStatus(task, now) === 'blocked')) return 'suspect';
  switch (session.state) {
    case 'pending':
      return 'idle';
    case 'running':
      return tasks.some((task) => mapTaskStatus(task, now) === 'waiting_on_approval')
        ? 'waiting'
        : 'running';
    case 'suspended':
      return 'waiting';
    case 'completed':
      return 'completed';
    case 'killed':
      return 'killed';
    case 'crashed':
      return 'crashed';
  }
}

function latestToolCall(
  calls: ReturnType<ControlPlane['listToolInvocations']>,
  sessionId: string,
): ReturnType<ControlPlane['listToolInvocations']>[number] | undefined {
  return calls
    .filter((call) => call.sessionId === sessionId)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
}

function approvalsForTasks(tasks: ControlPlaneTask[]): WorkspaceApproval[] {
  return tasks
    .filter((task) => !task.capabilityCheck.ok)
    .map((task) => ({
      id: `approval:${task.id}`,
      action: task.tool,
      state: 'requested',
      risk: task.capabilityCheck.reason ?? 'policy approval required',
      resourceLabel: task.tool,
      taskId: task.id,
      requestedAt: task.updatedAt,
    }));
}

function mapAuditEntry(entry: AuditEntry): WorkspaceAuditEntry {
  return {
    id: entry.id,
    sequence: entry.seq,
    actor: entry.actor.id,
    action: entry.action,
    resource: entry.resource.id,
    outcome: auditOutcome(entry),
    createdAt: entry.ts,
  };
}

function auditOutcome(entry: AuditEntry): AuditOutcome {
  if (entry.action.endsWith('.deny') || entry.action === 'intervention.deny') return 'denied';
  if (entry.action.endsWith('.fail')) return 'failed';
  return 'ok';
}

function checkpointsFromAudit(entries: WorkspaceAuditEntry[]): WorkspaceCheckpoint[] {
  return entries
    .filter((entry) => entry.action === 'session.create' || entry.action === 'task.complete')
    .map((entry) => ({
      id: `checkpoint:${entry.id}`,
      label: entry.action,
      createdAt: entry.createdAt,
    }));
}

function agentActions(status: AgentStatus): WorkspaceInterventionAction[] {
  const actions: WorkspaceInterventionAction[] = [
    {
      kind: 'agent.edit',
      label: 'Edit',
      permission: 'agents:edit',
      enabled: true,
    },
    {
      kind: 'agent.pause',
      label: 'Pause',
      permission: 'agents:pause',
      enabled: false,
      reason: 'Agent pause waits for production auth and lifecycle controls from FAG-23.',
    },
    {
      kind: 'agent.archive',
      label: 'Archive',
      permission: 'agents:archive',
      enabled: status !== 'running',
      ...optionalField('reason', status === 'running' ? 'Running agents cannot be archived.' : undefined),
    },
  ];
  return actions.map((action) => withOptionalFields(action));
}

function taskActions(task: ControlPlaneTask, status: TaskStatus): WorkspaceInterventionAction[] {
  const terminal = status === 'completed' || status === 'failed' || status === 'cancelled';
  const actions: WorkspaceInterventionAction[] = [
    {
      kind: 'task.cancel',
      label: 'Cancel',
      permission: 'tasks:cancel',
      enabled: !terminal,
      ...optionalField('reason', terminal ? 'Terminal tasks cannot be cancelled.' : undefined),
    },
    {
      kind: 'task.retry',
      label: 'Retry',
      permission: 'tasks:retry',
      enabled: status === 'failed' && task.attempt < task.maxAttempts,
      ...optionalField(
        'reason',
        status === 'failed' ? undefined : 'Retry is only available for failed tasks.',
      ),
    },
  ];
  return actions.map((action) => withOptionalFields(action));
}

function sessionActions(
  session: Session,
  tasks: ControlPlaneTask[],
  now: Date,
): WorkspaceInterventionAction[] {
  const state = mapSessionState(session, tasks, now);
  const terminal = state === 'completed' || state === 'dead' || state === 'crashed' || state === 'killed';
  const actions: WorkspaceInterventionAction[] = [
    {
      kind: 'session.pause',
      label: 'Pause',
      permission: 'sessions:pause',
      enabled: false,
      reason: 'Session pause is not supported by the current control-plane session lifecycle.',
    },
    {
      kind: 'session.resume',
      label: 'Resume',
      permission: 'sessions:resume',
      enabled: false,
      reason: 'Session resume is not supported by the current control-plane session lifecycle.',
    },
    {
      kind: 'session.kill',
      label: 'Kill',
      permission: 'sessions:kill',
      enabled: !terminal,
      ...optionalField('reason', terminal ? 'Terminal sessions cannot be killed.' : undefined),
    },
    {
      kind: 'session.escalate',
      label: 'Escalate',
      permission: 'sessions:escalate',
      enabled: true,
    },
  ];
  return actions.map((action) => withOptionalFields(action));
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
