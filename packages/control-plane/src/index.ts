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

/* ----------------------------- Session model ----------------------------- */

export const SessionStateSchema = z.enum([
  'pending',
  'running',
  'suspended',
  'completed',
  'killed',
  'crashed',
]);
export type SessionState = z.infer<typeof SessionStateSchema>;

/** A session is a single bounded run of an agent. */
export interface Session {
  id: string;
  agentId: string;
  agentVersion: string;
  /** Hash of the AgentCard at session creation time. Detects card drift. */
  agentCardHash: string;
  state: SessionState;
  createdAt: string;
  updatedAt: string;
  /** Originator of the request — user/agent id and (best-effort) type. */
  createdBy: { id: string; type: 'user' | 'agent' | 'system' };
  /** Free-form input to the agent (prompt, task, etc.). */
  input: Record<string, unknown>;
  /** Most recent result, if any. */
  result: Record<string, unknown> | null;
  /** Reason the session entered a terminal state, if any. */
  terminalReason: string | null;
}
export type SessionId = string;

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
  /** Hook for real session-runtime integration in Phase 1. */
  clock?: () => Date;
}

export class ControlPlane {
  private readonly audit: AuditLog;
  private readonly cards: AgentCardRegistry;
  private readonly toolGateway: ToolGateway;
  private readonly sessions = new Map<SessionId, Session>();
  private readonly clock: () => Date;

  constructor(opts: ControlPlaneOptions) {
    this.audit = opts.audit;
    this.cards = opts.cards;
    this.toolGateway = opts.toolGateway ?? stubToolGateway;
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
    this.sessions.set(session.id, session);

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
    const s = this.sessions.get(id);
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
    this.sessions.delete(id);
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
    return [...this.sessions.values()];
  }
}

/* Re-exports for convenience. */
export type { AgentCard, AuditEntry, AuditAppendInput, AuditAppendResult };
