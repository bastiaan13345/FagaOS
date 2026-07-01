/**
 * Adapters that bridge the typed control-plane HTTP client to the
 * `@fagaos/workspace-shell` `WorkspaceShellAdapter` interface. The
 * web app renders the workspace shell snapshot produced by the core
 * package; this file is the only place that knows about both sides.
 */
import {
  WORKSPACE_NAV_ITEMS,
  type PermissionSet,
  type WorkspaceAgent,
  type WorkspaceApproval,
  type WorkspaceAuditEntry,
  type WorkspaceEscalation,
  type WorkspaceSession,
  type WorkspaceShellAdapter,
  type WorkspaceTask,
} from '@fagaos/workspace-shell';
import type { ControlPlaneClient } from '../api/client';
import type { AuditEntry, Session, Task } from '../api/types';

const ALL_ALLOW: PermissionSet = WORKSPACE_NAV_ITEMS.reduce<PermissionSet>((acc, item) => {
  acc[item.id] = 'allow';
  return acc;
}, {} as PermissionSet);

export interface ControlPlaneHttpShellAdapterOptions {
  client: ControlPlaneClient;
  /** Override the default "all allowed" permission set. */
  permissions?: PermissionSet;
}

export class ControlPlaneHttpShellAdapter implements WorkspaceShellAdapter {
  private readonly client: ControlPlaneClient;
  private readonly permissions: PermissionSet;

  constructor(opts: ControlPlaneHttpShellAdapterOptions) {
    this.client = opts.client;
    this.permissions = opts.permissions ?? ALL_ALLOW;
  }

  async listAgents(): Promise<WorkspaceAgent[]> {
    // The control-plane card registry is the canonical source of agent
    // metadata. The HTTP client exposes registration + session lookup,
    // not a list endpoint, so for Phase 3 the shell discovers agents
    // by replaying the audit log and looking for `card.register`
    // actions. This keeps the adapter side effect-free and works
    // against the existing OpenAPI surface.
    const entries = await this.replayAudit();
    const seen = new Map<string, WorkspaceAgent>();
    for (const entry of entries) {
      if (entry.action !== 'card.register' && entry.action !== 'agent.create') continue;
      const id = entry.resource.id;
      if (seen.has(id)) continue;
      seen.set(id, {
        id,
        name: id,
        role: 'agent',
        status: 'idle',
        recentFailureCount: 0,
        recentTaskIds: [],
        health: { state: 'idle', recentFailureCount: 0 },
        actions: [],
      });
    }
    return [...seen.values()];
  }

  async listTasks(): Promise<WorkspaceTask[]> {
    const tasks = await this.client.recoverTasks().catch(() => []);
    return tasks.map(taskView);
  }

  async listSessions(): Promise<WorkspaceSession[]> {
    // No public list-sessions endpoint yet; recoverTasks() is the
    // closest read-model until FAG-NN lands a list. We surface the
    // empty list gracefully for now.
    return [];
  }

  async listAccounts(): Promise<never[]> {
    return [];
  }

  async listApprovals(): Promise<WorkspaceApproval[]> {
    // Approvals live on the read-model side, not the control-plane
    // API surface; we return an empty list here so the shell renders
    // the empty state.
    return [];
  }

  async listEscalations(): Promise<WorkspaceEscalation[]> {
    return [];
  }

  async listAuditEntries(): Promise<WorkspaceAuditEntry[]> {
    const entries = await this.replayAudit();
    return entries.map(auditView);
  }

  async getPermissions(): Promise<PermissionSet> {
    return this.permissions;
  }

  private async replayAudit(): Promise<AuditEntry[]> {
    // The control-plane exposes per-session audit log only; for the
    // workspace shell we use the global replay by listing tasks (which
    // returns the most recent activity) and walking the per-session
    // log for each. Per-session errors are swallowed so a single
    // unreadable session does not blank the audit view.
    const tasks = await this.client.recoverTasks().catch(() => [] as Task[]);
    const seen = new Set<string>();
    const all: AuditEntry[] = [];
    for (const task of tasks) {
      try {
        const log = await this.client.getSessionAuditLog(task.sessionId, { limit: 100 });
        for (const entry of log) {
          if (seen.has(entry.id)) continue;
          seen.add(entry.id);
          all.push(entry);
        }
      } catch (err) {
        // Per-session failures are non-fatal; record and continue.
        void err;
      }
    }
    all.sort((a, b) => a.seq - b.seq);
    return all;
  }
}

function taskView(task: Task): WorkspaceTask {
  const status: WorkspaceTask['status'] = mapTaskStatus(task);
  return {
    id: task.id,
    title: task.tool,
    status,
    assigneeId: task.createdBy.id,
    priority: task.capabilityCheck.ok ? 'medium' : 'urgent',
    sessionId: task.sessionId,
    dependencies: [task.sessionId],
    timeline: [
      {
        state: status,
        at: task.updatedAt,
        actor: task.createdBy.id,
        source: 'control-plane',
      },
    ],
    artifacts: [],
    comments: [],
    retry: { attempt: task.attempt, maxAttempts: task.maxAttempts },
    actions: [],
  };
}

function mapTaskStatus(task: Task): WorkspaceTask['status'] {
  switch (task.state) {
    case 'queued':
      return task.capabilityCheck.ok ? 'queued' : 'waiting_on_approval';
    case 'claimed':
      return 'running';
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
  }
}

function auditView(entry: AuditEntry): WorkspaceAuditEntry {
  return {
    id: entry.id,
    sequence: entry.seq,
    actor: entry.actor.id,
    action: entry.action,
    resource: entry.resource.id,
    outcome: entry.action.endsWith('.deny') ? 'denied' : entry.action.endsWith('.fail') ? 'failed' : 'ok',
    createdAt: entry.ts,
  };
}

/** Exposed for tests; lets them inject a stub client without booting Next. */
export function __setTestClient(): void {
  // no-op placeholder kept for symmetry; tests construct adapters directly.
}

export type { Session };
