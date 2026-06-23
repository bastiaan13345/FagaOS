/**
 * @fagaos/control-plane
 *
 * Control-plane API stubs the FagaOS orchestrator uses to manage
 * agents, tools, and sessions.
 *
 * API surface:
 *
 *   POST   /sessions                       — create a session bound to an AgentCard
 *   GET    /sessions/:id                   — inspect a session
 *   DELETE /sessions/:id                   — tear down a session
 *   POST   /sessions/:id/tools/:tool       — invoke a tool (sandbox gateway; stubbed)
 *   POST   /sessions/:id/kill              — hard-stop a session
 *   GET    /sessions/:id/log               — read audit log entries for the session
 *
 * The transport layer (HTTP) is a thin shell in `./http.ts`; the
 * core logic lives in this file so the same code path can be
 * driven in-process by the orchestrator without an HTTP hop.
 *
 * Every public method produces at least one entry in the audit log.
 * The audit log itself is the FAG-8 canonical primitive, surfaced
 * through the FAG-9 compatibility layer in `@fagaos/audit-log`.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AgentCard } from '@fagaos/agent-manifest';
import { AgentCardSchema, cardIdentityHash } from '@fagaos/agent-manifest';
import type {
  AuditAppendInput,
  AuditAppendResult,
  AuditEntry,
  AuditLog,
} from '@fagaos/audit-log';
import {
  InMemoryControlPlaneRepository,
  type CapabilityCheckOutcome,
  type ControlPlaneRepository,
  type ControlPlaneTask,
} from './repository.js';
import {
  SessionStateSchema,
  type ApprovalRequest,
  type Actor,
  type LocalNotification,
  type NotificationPreference,
  type NotificationSeverity,
  type NotificationTopic,
  type Session,
  type SessionId,
  type ToolInvocationRecord,
} from './types.js';

/* ----------------------------- Session model ----------------------------- */

export { SessionStateSchema };
export type {
  ApprovalDecision,
  ApprovalEvidence,
  ApprovalRequest,
  ApprovalResource,
  ApprovalState,
  LocalNotification,
  NotificationChannel,
  NotificationPreference,
  NotificationSeverity,
  NotificationTopic,
  SessionState,
  Session,
  SessionId,
  ToolInvocationRecord,
} from './types.js';
export {
  InMemoryControlPlaneRepository,
  JsonFileControlPlaneRepository,
  loadControlPlaneRepositoryState,
  type CapabilityCheckOutcome,
  type ControlPlaneRepository,
  type ControlPlaneRepositoryState,
  type ControlPlaneTask,
  type ControlPlaneTaskState,
} from './repository.js';

/* ─────────────────────── Auth / Observability ──────────────────────────── */

export {
  authenticate,
  authorize,
  callerToActor,
  hasRole,
  type AuthConfig,
  type CallerIdentity,
  type CallerRole,
  type AuthResult,
} from './auth.js';

export {
  createLogger,
  createMetrics,
  createHealthChecker,
  newCorrelationId,
  type Logger,
  type LogLevel,
  type LogRecord,
  type Metrics,
  type MetricsSnapshot,
  type HealthChecker,
  type HealthStatus,
} from './observability.js';

/* ----------------------------- Tool gateway ------------------------------ */

/**
 * The tool gateway is the seam where FAG-4 (desktop/browser) and
 * FAG-5 (integrations) plug in. Phase 0 ships a stub gateway that
 * records the call and returns a deterministic stub result.
 *
 * The real gateway, in Phase 1, will:
 *  1. Resolve the tool id to a tool server (per the AgentCard's
 *     `toolServers` and `mcpEndpoints`).
 *  2. Mint a short-lived capability token via the policy engine.
 *  3. Run the call in the per-tool sandbox (Landlock + seccomp-bpf).
 *  4. Stream the result back through this interface.
 */
export interface ToolInvocation {
  tool: string;
  arguments: Record<string, unknown>;
}

export interface ToolResult {
  ok: boolean;
  /** Tool-supplied result, opaque to the control plane. */
  result: Record<string, unknown> | null;
  /** Free-form error message when ok is false. */
  error: string | null;
  /** Wall-clock duration in milliseconds. */
  durationMs: number;
  /**
   * Server-side correlation id for tracing. The control plane does
   * not interpret this; tool servers emit it.
   */
  correlationId: string;
}

export type ToolGateway = (
  session: Session,
  invocation: ToolInvocation,
) => Promise<ToolResult>;

/** Default stub gateway — no side effects, deterministic response. */
export const stubToolGateway: ToolGateway = async (session, inv) => {
  const start = Date.now();
  // TODO(FAG-4): replace with desktop/browser tool server dispatcher.
  // TODO(FAG-5): replace with email/messaging/calendar tool server dispatcher.
  return {
    ok: true,
    result: {
      stub: true,
      sessionId: session.id,
      tool: inv.tool,
      echoArgs: inv.arguments,
      notice: 'stub execution — concrete tool server not wired (FAG-4 / FAG-5)',
    },
    error: null,
    durationMs: Date.now() - start,
    correlationId: randomUUID(),
  };
};

/* ------------------------------- Errors ---------------------------------- */

export class ControlPlaneError extends Error {
  constructor(
    public readonly code:
      | 'session_not_found'
      | 'session_not_running'
      | 'session_already_terminal'
      | 'agent_card_not_found'
      | 'agent_card_hash_mismatch'
      | 'invalid_input'
      | 'tool_not_found'
      | 'task_not_found'
      | 'task_not_claimed'
      | 'task_already_terminal'
      | 'approval_not_found'
      | 'approval_not_active'
      | 'internal',
    message: string,
  ) {
    super(message);
    this.name = 'ControlPlaneError';
  }
}

/* ----------------------------- Card registry ----------------------------- */

export interface AgentCardRegistry {
  /** Accepts the Zod input so callers may omit defaulted fields. */
  register(card: z.input<typeof AgentCardSchema>): void;
  get(id: string): AgentCard | undefined;
  list(): AgentCard[];
}

/** Minimal in-memory registry; replace with persistent store in Phase 1. */
export function createInMemoryCardRegistry(): AgentCardRegistry {
  const byId = new Map<string, AgentCard>();
  return {
    register(card) {
      // Normalize: apply AgentCard defaults so downstream code can rely
      // on `capabilities` / `mcpEndpoints` / `toolServers` being arrays.
      // This is the only place cards are validated for shape.
      const parsed = AgentCardSchema.parse(card);
      byId.set(parsed.id, parsed);
    },
    get(id) {
      return byId.get(id);
    },
    list() {
      return [...byId.values()];
    },
  };
}

/* ----------------------------- Control plane ----------------------------- */

export interface CreateSessionInput {
  agentId: string;
  createdBy: { id: string; type: 'user' | 'agent' | 'system' };
  input: Record<string, unknown>;
  /**
   * Optional override — if the caller already holds a freshly-validated
   * card. Defaults to the registry's current card. Drift between this
   * and the registry produces `agent_card_hash_mismatch`.
   */
  agentCard?: AgentCard;
}

export interface InvokeToolInput {
  arguments: Record<string, unknown>;
}

export interface ListLogInput {
  /** Audit-log seq to start from (inclusive). */
  sinceSeq?: number;
  /** Max entries to return. */
  limit?: number;
}

export interface ControlPlaneOptions {
  audit: AuditLog;
  cards: AgentCardRegistry;
  toolGateway?: ToolGateway;
  repository?: ControlPlaneRepository;
  /** Hook for real session-runtime integration in Phase 1. */
  clock?: () => Date;
}

export interface EnqueueTaskInput {
  sessionId: string;
  tool: string;
  arguments: Record<string, unknown>;
  createdBy: Actor;
  auditCorrelationId?: string;
  capabilityCheck: CapabilityCheckOutcome;
  maxAttempts?: number;
  scheduledAt?: string;
}

export interface ClaimTaskInput {
  workerId: string;
  leaseMs: number;
}

export interface TaskLeaseInput {
  workerId: string;
  leaseMs: number;
}

export interface CompleteTaskInput {
  workerId: string;
  result: Record<string, unknown>;
}

export interface FailTaskInput {
  workerId: string;
  error: string;
  retryDelayMs?: number;
}

export interface CancelTaskInput {
  reason: string;
  actor: Actor;
}

export interface ClaimTaskResult {
  task: ControlPlaneTask;
}

export interface RequestApprovalInput {
  sessionId: string;
  taskId?: string | null;
  toolCallId?: string | null;
  requestedBy: Actor;
  riskReason: string;
  proposedAction: string;
  sourceEvidence: Array<{ kind: string; id: string; summary: string }>;
  affectedResource: { kind: string; id: string };
  timeoutAt: string;
  policyRule: string;
  auditCorrelationId: string;
  escalationReason?: string | null;
}

export interface DecideApprovalInput {
  actor: Actor;
  decision: 'approve' | 'deny' | 'edit' | 'cancel';
  reason?: string;
  editedAction?: string;
}

export class ControlPlane {
  private readonly audit: AuditLog;
  private readonly cards: AgentCardRegistry;
  private readonly toolGateway: ToolGateway;
  private readonly repository: ControlPlaneRepository;
  private readonly clock: () => Date;

  constructor(opts: ControlPlaneOptions) {
    this.audit = opts.audit;
    this.cards = opts.cards;
    this.toolGateway = opts.toolGateway ?? stubToolGateway;
    this.repository = opts.repository ?? new InMemoryControlPlaneRepository();
    this.clock = opts.clock ?? (() => new Date());
  }

  /* --------------------------- Registration ---------------------------- */

  /**
   * Register or update an AgentCard. Validates and applies defaults.
   * Accepts the Zod input type so callers may omit defaulted fields.
   */
  async registerCard(card: z.input<typeof AgentCardSchema>): Promise<void> {
    const parsed = AgentCardSchema.parse(card);
    this.cards.register(parsed);
    await this.audit.append({
      actor: { id: 'system:control-plane', type: 'system' },
      action: 'card.register',
      resource: { kind: 'agent', id: parsed.id },
      data: {
        version: parsed.version,
        identityHash: cardIdentityHash(parsed),
      },
    });
  }

  /* --------------------------- Session ops ----------------------------- */

  async createSession(input: CreateSessionInput): Promise<Session> {
    const card = input.agentCard ?? this.cards.get(input.agentId);
    if (!card) {
      throw new ControlPlaneError(
        'agent_card_not_found',
        `no AgentCard registered for id "${input.agentId}"`,
      );
    }
    if (input.agentCard) {
      const registered = this.cards.get(input.agentId);
      if (registered && cardIdentityHash(registered) !== cardIdentityHash(input.agentCard)) {
        // Drift is only an error when the caller pinned a specific version.
        // For Phase 0 we treat it as advisory; the audit log records both hashes.
      }
    }

    const now = this.clock().toISOString();
    const session: Session = {
      id: randomUUID(),
      agentId: card.id,
      agentVersion: card.version,
      agentCardHash: cardIdentityHash(card),
      state: 'running',
      createdAt: now,
      updatedAt: now,
      createdBy: input.createdBy,
      input: input.input,
      result: null,
      terminalReason: null,
    };
    await this.repository.saveSession(session);

    await this.audit.append({
      actor: { id: input.createdBy.id, type: input.createdBy.type },
      action: 'session.create',
      resource: { kind: 'session', id: session.id },
      data: {
        agentId: card.id,
        agentVersion: card.version,
        agentCardHash: session.agentCardHash,
      },
    });

    return session;
  }

  getSession(id: SessionId): Session {
    const s = this.repository.getSession(id);
    if (!s) {
      throw new ControlPlaneError('session_not_found', `session "${id}" not found`);
    }
    return s;
  }

  async deleteSession(id: SessionId): Promise<void> {
    const session = this.getSession(id);
    if (session.state === 'running' || session.state === 'pending') {
      // Tear-down is graceful: it marks the session completed (not killed).
      session.state = 'completed';
      session.terminalReason = 'deleted by caller';
      session.updatedAt = this.clock().toISOString();
    }
    await this.repository.saveSession(session);
    await this.repository.deleteSession(id);
    await this.audit.append({
      actor: { id: 'system:control-plane', type: 'system' },
      action: 'session.delete',
      resource: { kind: 'session', id },
      data: { finalState: session.state },
    });
  }

  async invokeTool(
    sessionId: SessionId,
    input: InvokeToolInput,
    toolName: string,
  ): Promise<ToolResult> {
    const session = this.getSession(sessionId);
    if (session.state !== 'running') {
      throw new ControlPlaneError(
        'session_not_running',
        `session "${sessionId}" is in state "${session.state}"`,
      );
    }
    if (!toolName || typeof toolName !== 'string') {
      throw new ControlPlaneError('invalid_input', 'tool name required');
    }

    // The stub gateway in Phase 0 does no work beyond recording the call.
    // FAG-4 and FAG-5 will replace this with real dispatchers.
    const invocation: ToolInvocation = { tool: toolName, arguments: input.arguments };
    const result = await this.toolGateway(session, invocation);

    session.updatedAt = this.clock().toISOString();
    await this.repository.saveSession(session);

    await this.audit.append({
      actor: { id: `agent:${session.agentId}`, type: 'agent' },
      action: 'tool.invoke',
      resource: { kind: 'tool', id: toolName },
      data: {
        sessionId: session.id,
        ok: result.ok,
        durationMs: result.durationMs,
        correlationId: result.correlationId,
        error: result.error,
      },
    });
    await this.repository.saveToolInvocation({
      id: randomUUID(),
      sessionId: session.id,
      tool: toolName,
      arguments: invocation.arguments,
      ok: result.ok,
      result: result.result,
      error: result.error,
      durationMs: result.durationMs,
      correlationId: result.correlationId,
      createdAt: session.updatedAt,
      auditCorrelationId: result.correlationId,
    });

    return result;
  }

  async killSession(sessionId: SessionId, reason: string): Promise<void> {
    const session = this.getSession(sessionId);
    if (
      session.state === 'completed' ||
      session.state === 'killed' ||
      session.state === 'crashed'
    ) {
      throw new ControlPlaneError(
        'session_already_terminal',
        `session "${sessionId}" already terminal (${session.state})`,
      );
    }
    const prevState = session.state;
    session.state = 'killed';
    session.terminalReason = reason;
    session.updatedAt = this.clock().toISOString();
    await this.repository.saveSession(session);

    await this.audit.append({
      actor: { id: 'system:control-plane', type: 'system' },
      action: 'session.kill',
      resource: { kind: 'session', id: sessionId },
      data: { fromState: prevState, reason },
    });
  }

  async getSessionLog(
    sessionId: SessionId,
    opts: ListLogInput = {},
  ): Promise<AuditEntry[]> {
    // The session must exist; this prevents a log-probe of arbitrary
    // session ids. Phase 1 will move to a richer ACL.
    this.getSession(sessionId);
    const limit = opts.limit ?? 100;
    const all = await this.audit.read({ sinceSeq: opts.sinceSeq ?? 0, limit: 1000 });
    return all
      .filter((e) => e.resource.id === sessionId || e.data?.['sessionId'] === sessionId)
      .slice(0, limit);
  }

  /* -------------------------- Internal access -------------------------- */

  /** Used by tests and the orchestrator to enumerate sessions. */
  listSessions(): Session[] {
    return this.repository.listSessions();
  }

  /* ------------------------- Scheduler lifecycle ------------------------ */

  async enqueueTask(input: EnqueueTaskInput): Promise<ControlPlaneTask> {
    this.getSession(input.sessionId);
    if (!input.tool) {
      throw new ControlPlaneError('invalid_input', 'task tool is required');
    }
    const now = this.clock().toISOString();
    const task: ControlPlaneTask = {
      id: randomUUID(),
      sessionId: input.sessionId,
      tool: input.tool,
      arguments: input.arguments,
      state: 'queued',
      createdAt: now,
      updatedAt: now,
      scheduledAt: input.scheduledAt ?? now,
      claimedAt: null,
      claimedBy: null,
      leaseExpiresAt: null,
      attempt: 0,
      maxAttempts: input.maxAttempts ?? 3,
      result: null,
      terminalReason: null,
      createdBy: input.createdBy,
      auditCorrelationId: input.auditCorrelationId ?? randomUUID(),
      capabilityCheck: input.capabilityCheck,
    };
    await this.repository.saveTask(task);
    await this.auditTask('task.enqueue', task, input.createdBy, {
      tool: task.tool,
      capabilityCheck: task.capabilityCheck,
    });
    return task;
  }

  async claimTask(input: ClaimTaskInput): Promise<ClaimTaskResult | null> {
    const now = this.clock();
    const nowIso = now.toISOString();
    const task = this.repository
      .listTasks()
      .filter((candidate) => candidate.state === 'queued')
      .filter((candidate) => candidate.capabilityCheck.ok)
      .filter((candidate) => Date.parse(candidate.scheduledAt) <= now.getTime())
      .sort((a, b) => Date.parse(a.scheduledAt) - Date.parse(b.scheduledAt))[0];
    if (!task) return null;

    task.state = 'claimed';
    task.claimedAt = nowIso;
    task.claimedBy = input.workerId;
    task.leaseExpiresAt = new Date(now.getTime() + input.leaseMs).toISOString();
    task.updatedAt = nowIso;
    task.attempt += 1;
    await this.repository.saveTask(task);
    await this.auditTask('task.claim', task, { id: input.workerId, type: 'agent' }, {
      leaseExpiresAt: task.leaseExpiresAt,
      attempt: task.attempt,
    });
    return { task };
  }

  async heartbeatTask(taskId: string, input: TaskLeaseInput): Promise<ControlPlaneTask> {
    const task = this.requireTask(taskId);
    this.requireClaimedBy(task, input.workerId);
    const now = this.clock();
    task.leaseExpiresAt = new Date(now.getTime() + input.leaseMs).toISOString();
    task.updatedAt = now.toISOString();
    await this.repository.saveTask(task);
    await this.auditTask('task.heartbeat', task, { id: input.workerId, type: 'agent' }, {
      leaseExpiresAt: task.leaseExpiresAt,
    });
    return task;
  }

  async completeTask(taskId: string, input: CompleteTaskInput): Promise<ControlPlaneTask> {
    const task = this.requireTask(taskId);
    this.requireClaimedBy(task, input.workerId);
    const now = this.clock().toISOString();
    task.state = 'completed';
    task.result = input.result;
    task.terminalReason = null;
    task.updatedAt = now;
    task.leaseExpiresAt = null;
    await this.repository.saveTask(task);
    await this.auditTask('task.complete', task, { id: input.workerId, type: 'agent' }, {
      result: input.result,
    });
    return task;
  }

  async failTask(taskId: string, input: FailTaskInput): Promise<ControlPlaneTask> {
    const task = this.requireTask(taskId);
    this.requireClaimedBy(task, input.workerId);
    const now = this.clock();
    const nowIso = now.toISOString();
    if (task.attempt >= task.maxAttempts) {
      task.state = 'failed';
      task.terminalReason = input.error;
      task.leaseExpiresAt = null;
      task.updatedAt = nowIso;
      await this.repository.saveTask(task);
      await this.auditTask('task.fail', task, { id: input.workerId, type: 'agent' }, {
        error: input.error,
        retry: false,
      });
      await this.escalateTaskFailure(task, input.error);
      return task;
    }

    task.state = 'queued';
    task.claimedAt = null;
    task.claimedBy = null;
    task.leaseExpiresAt = null;
    task.scheduledAt = new Date(now.getTime() + (input.retryDelayMs ?? 0)).toISOString();
    task.updatedAt = nowIso;
    task.terminalReason = null;
    await this.repository.saveTask(task);
    await this.auditTask('task.retry', task, { id: input.workerId, type: 'agent' }, {
      error: input.error,
      scheduledAt: task.scheduledAt,
    });
    return task;
  }

  async cancelTask(taskId: string, input: CancelTaskInput): Promise<ControlPlaneTask> {
    const task = this.requireTask(taskId);
    this.assertNotTerminal(task);
    const now = this.clock().toISOString();
    task.state = 'cancelled';
    task.terminalReason = input.reason;
    task.updatedAt = now;
    task.leaseExpiresAt = null;
    await this.repository.saveTask(task);
    await this.auditTask('task.cancel', task, input.actor, { reason: input.reason });
    return task;
  }

  async recoverStuckTasks(): Promise<ControlPlaneTask[]> {
    const now = this.clock();
    const recovered: ControlPlaneTask[] = [];
    for (const task of this.repository.listTasks()) {
      if (
        task.state !== 'claimed' ||
        task.leaseExpiresAt === null ||
        Date.parse(task.leaseExpiresAt) > now.getTime()
      ) {
        continue;
      }
      task.state = 'queued';
      task.claimedAt = null;
      task.claimedBy = null;
      task.leaseExpiresAt = null;
      task.updatedAt = now.toISOString();
      task.scheduledAt = now.toISOString();
      await this.repository.saveTask(task);
      await this.auditTask('task.recover', task, { id: 'system:control-plane', type: 'system' }, {
        reason: 'lease expired',
      });
      recovered.push(task);
    }
    return recovered;
  }

  getTask(taskId: string): ControlPlaneTask {
    return this.requireTask(taskId);
  }

  listTasks(): ControlPlaneTask[] {
    return this.repository.listTasks();
  }

  listToolInvocations(): ToolInvocationRecord[] {
    return this.repository.listToolInvocations();
  }

  /* ---------------- Approvals / notifications / escalation -------------- */

  async requestApproval(input: RequestApprovalInput): Promise<ApprovalRequest> {
    this.getSession(input.sessionId);
    if (input.taskId) this.requireTask(input.taskId);
    const now = this.clock().toISOString();
    const approvalId = randomUUID();
    for (const existing of this.repository.listApprovals()) {
      if (
        existing.state === 'requested' &&
        existing.sessionId === input.sessionId &&
        existing.taskId === (input.taskId ?? null) &&
        existing.policyRule === input.policyRule
      ) {
        existing.state = 'superseded';
        existing.updatedAt = now;
        existing.supersededBy = approvalId;
        await this.repository.saveApproval(existing);
        await this.auditApproval('approval.supersede', existing, { id: 'system:control-plane', type: 'system' }, {
          supersededBy: approvalId,
          severity: 'info',
        });
      }
    }

    const approval: ApprovalRequest = {
      id: approvalId,
      sessionId: input.sessionId,
      taskId: input.taskId ?? null,
      toolCallId: input.toolCallId ?? input.taskId ?? null,
      state: 'requested',
      requestedBy: input.requestedBy,
      riskReason: input.riskReason,
      proposedAction: input.proposedAction,
      editedAction: null,
      sourceEvidence: input.sourceEvidence,
      affectedResource: input.affectedResource,
      timeoutAt: input.timeoutAt,
      policyRule: input.policyRule,
      auditCorrelationId: input.auditCorrelationId,
      createdAt: now,
      updatedAt: now,
      decision: null,
      supersededBy: null,
      escalationReason: input.escalationReason ?? null,
    };
    await this.repository.saveApproval(approval);
    await this.auditApproval('approval.request', approval, input.requestedBy, {
      severity: input.escalationReason ? 'error' : 'info',
    });
    if (!input.escalationReason) {
      await this.sendLocalNotification({
        topic: 'approvals',
        severity: 'info',
        title: 'Approval requested',
        body: approval.riskReason,
        dedupeKey: `approval:${approval.sessionId}:${approval.taskId ?? approval.affectedResource.id}:${approval.policyRule}`,
        resource: approval.affectedResource,
        approvalId: approval.id,
        auditCorrelationId: approval.auditCorrelationId,
      });
    }
    return approval;
  }

  getApproval(approvalId: string): ApprovalRequest {
    const approval = this.repository.getApproval(approvalId);
    if (!approval) {
      throw new ControlPlaneError('approval_not_found', `approval "${approvalId}" not found`);
    }
    return approval;
  }

  listApprovals(): ApprovalRequest[] {
    return this.repository.listApprovals();
  }

  async decideApproval(approvalId: string, input: DecideApprovalInput): Promise<ApprovalRequest> {
    const approval = this.getApproval(approvalId);
    if (!['requested', 'viewed'].includes(approval.state)) {
      throw new ControlPlaneError(
        'approval_not_active',
        `approval "${approvalId}" is in state "${approval.state}"`,
      );
    }
    const now = this.clock().toISOString();
    approval.updatedAt = now;
    approval.decision = {
      actor: input.actor,
      decidedAt: now,
      reason: input.reason ?? null,
    };
    if (input.decision === 'approve') approval.state = 'approved';
    if (input.decision === 'deny') approval.state = 'denied';
    if (input.decision === 'cancel') approval.state = 'cancelled';
    if (input.decision === 'edit') {
      if (!input.editedAction) {
        throw new ControlPlaneError('invalid_input', 'editedAction is required for edit decisions');
      }
      approval.state = 'edited';
      approval.editedAction = input.editedAction;
    }
    await this.repository.saveApproval(approval);
    await this.auditApproval(`approval.${input.decision}`, approval, input.actor, {
      reason: input.reason ?? null,
      editedAction: approval.editedAction,
      severity: input.decision === 'approve' ? 'info' : 'warning',
    });
    return approval;
  }

  async expireApprovals(): Promise<ApprovalRequest[]> {
    const now = this.clock();
    const expired: ApprovalRequest[] = [];
    for (const approval of this.repository.listApprovals()) {
      if (
        (approval.state !== 'requested' && approval.state !== 'viewed') ||
        Date.parse(approval.timeoutAt) > now.getTime()
      ) {
        continue;
      }
      approval.state = 'expired';
      approval.updatedAt = now.toISOString();
      await this.repository.saveApproval(approval);
      await this.auditApproval('approval.expire', approval, { id: 'system:control-plane', type: 'system' }, {
        severity: 'warning',
      });
      expired.push(approval);
    }
    return expired;
  }

  listNotificationPreferences(): NotificationPreference[] {
    return this.repository.listNotificationPreferences();
  }

  async setNotificationPreference(preference: NotificationPreference): Promise<NotificationPreference> {
    await this.repository.saveNotificationPreference(preference);
    return preference;
  }

  listNotifications(): LocalNotification[] {
    return this.repository.listNotifications();
  }

  async escalatePolicyDenial(taskId: string): Promise<ApprovalRequest> {
    const task = this.requireTask(taskId);
    const existing = this.findEscalation('policy_denial', task.id);
    if (existing) return existing;
    const reason = task.capabilityCheck.reason ?? 'Policy denied the requested tool capability';
    const approval = await this.requestApproval({
      sessionId: task.sessionId,
      taskId: task.id,
      toolCallId: task.id,
      requestedBy: { id: 'system:policy', type: 'system' },
      riskReason: `Policy denied tool "${task.tool}": ${reason}`,
      proposedAction: `Review denied tool request for ${task.tool}`,
      sourceEvidence: [{
        kind: 'policy',
        id: task.capabilityCheck.policyId ?? 'unknown',
        summary: reason,
      }],
      affectedResource: { kind: 'task', id: task.id },
      timeoutAt: new Date(this.clock().getTime() + 15 * 60_000).toISOString(),
      policyRule: task.capabilityCheck.policyId ?? 'policy.unknown',
      auditCorrelationId: task.auditCorrelationId,
      escalationReason: 'policy_denial',
    });
    await this.auditEscalation('policy_denial', task, approval, 'error');
    await this.sendLocalNotification({
      topic: 'policy_denials',
      severity: 'error',
      title: 'Policy denial requires review',
      body: approval.riskReason,
      dedupeKey: `escalation:policy_denial:${task.id}`,
      resource: { kind: 'task', id: task.id },
      approvalId: approval.id,
      auditCorrelationId: task.auditCorrelationId,
    });
    return approval;
  }

  private requireTask(taskId: string): ControlPlaneTask {
    const task = this.repository.getTask(taskId);
    if (!task) {
      throw new ControlPlaneError('task_not_found', `task "${taskId}" not found`);
    }
    return task;
  }

  private requireClaimedBy(task: ControlPlaneTask, workerId: string): void {
    if (task.state !== 'claimed' || task.claimedBy !== workerId) {
      throw new ControlPlaneError(
        'task_not_claimed',
        `task "${task.id}" is not claimed by "${workerId}"`,
      );
    }
  }

  private assertNotTerminal(task: ControlPlaneTask): void {
    if (task.state === 'completed' || task.state === 'failed' || task.state === 'cancelled') {
      throw new ControlPlaneError(
        'task_already_terminal',
        `task "${task.id}" already terminal (${task.state})`,
      );
    }
  }

  private async escalateTaskFailure(task: ControlPlaneTask, error: string): Promise<void> {
    const existing = this.findEscalation('repeated_tool_failure', task.id);
    if (existing) return;
    const approval = await this.requestApproval({
      sessionId: task.sessionId,
      taskId: task.id,
      toolCallId: task.id,
      requestedBy: { id: 'system:control-plane', type: 'system' },
      riskReason: `Tool "${task.tool}" failed after ${task.attempt} attempts: ${error}`,
      proposedAction: `Review failed task for ${task.tool}`,
      sourceEvidence: [{
        kind: 'task_failure',
        id: task.id,
        summary: error,
      }],
      affectedResource: { kind: 'task', id: task.id },
      timeoutAt: new Date(this.clock().getTime() + 15 * 60_000).toISOString(),
      policyRule: task.capabilityCheck.policyId ?? 'runtime.failure',
      auditCorrelationId: task.auditCorrelationId,
      escalationReason: 'repeated_tool_failure',
    });
    await this.auditEscalation('repeated_tool_failure', task, approval, 'error');
    await this.sendLocalNotification({
      topic: 'failures',
      severity: 'error',
      title: 'Task failure requires review',
      body: approval.riskReason,
      dedupeKey: `escalation:repeated_tool_failure:${task.id}`,
      resource: { kind: 'task', id: task.id },
      approvalId: approval.id,
      auditCorrelationId: task.auditCorrelationId,
    });
  }

  private findEscalation(reason: string, taskId: string): ApprovalRequest | null {
    return this.repository.listApprovals().find((approval) => (
      approval.escalationReason === reason &&
      approval.taskId === taskId &&
      ['requested', 'viewed'].includes(approval.state)
    )) ?? null;
  }

  private async auditApproval(
    action: AuditAppendInput['action'],
    approval: ApprovalRequest,
    actor: Actor,
    data: Record<string, unknown>,
  ): Promise<void> {
    await this.audit.append({
      actor,
      action,
      resource: { kind: 'approval', id: approval.id },
      data: {
        ...data,
        approvalId: approval.id,
        sessionId: approval.sessionId,
        taskId: approval.taskId,
        toolCallId: approval.toolCallId,
        auditCorrelationId: approval.auditCorrelationId,
        state: approval.state,
        policyRule: approval.policyRule,
        affectedResource: approval.affectedResource,
      },
    });
  }

  private async auditEscalation(
    reason: string,
    task: ControlPlaneTask,
    approval: ApprovalRequest,
    severity: NotificationSeverity,
  ): Promise<void> {
    await this.audit.append({
      actor: { id: 'system:control-plane', type: 'system' },
      action: 'escalation.request',
      resource: { kind: 'task', id: task.id },
      data: {
        reason,
        sessionId: task.sessionId,
        taskId: task.id,
        approvalId: approval.id,
        auditCorrelationId: task.auditCorrelationId,
        severity,
      },
    });
  }

  private async sendLocalNotification(input: {
    topic: NotificationTopic;
    severity: NotificationSeverity;
    title: string;
    body: string;
    dedupeKey: string;
    resource: { kind: string; id: string };
    approvalId: string | null;
    auditCorrelationId: string;
  }): Promise<void> {
    const now = this.clock().toISOString();
    const notification: LocalNotification = {
      id: randomUUID(),
      channel: 'local_dev',
      createdAt: now,
      ...input,
    };
    await this.repository.saveNotification(notification);
  }

  private async auditTask(
    action: AuditAppendInput['action'],
    task: ControlPlaneTask,
    actor: Actor,
    data: Record<string, unknown>,
  ): Promise<void> {
    await this.audit.append({
      actor,
      action,
      resource: { kind: 'task', id: task.id },
      data: {
        ...data,
        sessionId: task.sessionId,
        auditCorrelationId: task.auditCorrelationId,
        state: task.state,
      },
    });
  }
}

/* Re-exports for convenience. */
export type { AgentCard, AuditEntry, AuditAppendInput, AuditAppendResult };
