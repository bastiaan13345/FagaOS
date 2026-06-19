/**
 * @fagaos/control-plane/http
 *
 * HTTP transport for the control-plane API.
 *
 * Endpoint surface:
 *   POST   /sessions
 *   GET    /sessions/:id
 *   DELETE /sessions/:id
 *   POST   /sessions/:id/tools/:tool
 *   POST   /sessions/:id/kill
 *   GET    /sessions/:id/log?sinceSeq=&limit=
 *   POST   /tasks, GET/POST /tasks/:id/...
 *   GET    /healthz          — liveness probe (no auth required if allowUnauthenticatedHealthChecks)
 *   GET    /readyz           — readiness probe (same)
 *   GET    /metrics          — in-process counters (admin role)
 *
 * Every request is authenticated (Bearer token) and authorized by role.
 * Request lifecycle is instrumented: structured log + metrics counter per
 * outcome, correlated with session/task audit chain via correlationId.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { ControlPlane, ControlPlaneError, type NotificationPreference } from './index.js';
import type { AgentCard } from '@fagaos/agent-manifest';
import {
  authenticate,
  authorize,
  callerToActor,
  type AuthConfig,
  type CallerIdentity,
  type CallerRole,
} from './auth.js';
import {
  createLogger,
  createMetrics,
  createHealthChecker,
  newCorrelationId,
  type Logger,
  type Metrics,
  type HealthChecker,
} from './observability.js';

export interface HttpServerOptions {
  controlPlane: ControlPlane;
  /**
   * Optional extra card-registration endpoint. Phase 0 ships a
   * minimal POST /cards so the orchestrator can register agents
   * in-band; production cards are loaded from a registry service.
   */
  exposeCardRegistration?: boolean;
  /** Auth configuration. When omitted the server runs unauthenticated (dev/test only). */
  auth?: AuthConfig;
  /** Injected logger; defaults to a structured stdout logger. */
  logger?: Logger;
  /** Injected metrics; defaults to a new in-process metrics instance. */
  metrics?: Metrics;
  /** Injected health checker; defaults to a new checker with no registered checks. */
  health?: HealthChecker;
}

interface Route {
  method: string;
  pattern: RegExp;
  paramNames: string[];
  /** Minimum role required to call this route. undefined = no auth required. */
  requiredRole?: CallerRole;
  handler: (
    params: Record<string, string>,
    body: unknown,
    req: IncomingMessage,
    caller: CallerIdentity | null,
  ) => Promise<unknown>;
}

function buildRoutes(opts: HttpServerOptions): Route[] {
  const cp = opts.controlPlane;
  const health = opts.health ?? createHealthChecker();
  const metrics = opts.metrics ?? createMetrics();
  const r: Route[] = [];

  // ── Session routes ───────────────────────────────────────────────────

  r.push({
    method: 'POST',
    pattern: /^\/sessions$/,
    paramNames: [],
    requiredRole: 'invoker',
    handler: async (_p, body, _req, caller) => {
      const b = body as {
        agentId: string;
        createdBy?: { id: string; type: 'user' | 'agent' | 'system' };
        input: Record<string, unknown>;
        agentCard?: AgentCard;
      };
      // Use authenticated caller identity as createdBy when not overridden
      const createdBy = b.createdBy ?? (caller ? callerToActor(caller) : { id: 'system', type: 'system' as const });
      const session = await cp.createSession({
        agentId: b.agentId,
        createdBy,
        input: b.input ?? {},
        ...(b.agentCard !== undefined ? { agentCard: b.agentCard } : {}),
      });
      return { session };
    },
  });

  r.push({
    method: 'GET',
    pattern: /^\/sessions\/([^/]+)$/,
    paramNames: ['id'],
    requiredRole: 'reader',
    handler: async (p) => ({ session: cp.getSession(p['id']!) }) as unknown,
  });

  r.push({
    method: 'DELETE',
    pattern: /^\/sessions\/([^/]+)$/,
    paramNames: ['id'],
    requiredRole: 'admin',
    handler: async (p) => {
      await cp.deleteSession(p['id']!);
      return { ok: true };
    },
  });

  r.push({
    method: 'POST',
    pattern: /^\/sessions\/([^/]+)\/tools\/([^/]+)$/,
    paramNames: ['id', 'tool'],
    requiredRole: 'invoker',
    handler: async (p, body) => {
      const b = (body ?? {}) as { arguments?: Record<string, unknown> };
      const result = await cp.invokeTool(
        p['id']!,
        { arguments: b.arguments ?? {} },
        p['tool']!,
      );
      return { result };
    },
  });

  r.push({
    method: 'POST',
    pattern: /^\/sessions\/([^/]+)\/kill$/,
    paramNames: ['id'],
    requiredRole: 'admin',
    handler: async (p, body) => {
      const b = (body ?? {}) as { reason?: string };
      await cp.killSession(p['id']!, b.reason ?? 'killed by caller');
      return { ok: true };
    },
  });

  // ── Task routes ──────────────────────────────────────────────────────

  r.push({
    method: 'POST',
    pattern: /^\/tasks$/,
    paramNames: [],
    requiredRole: 'invoker',
    handler: async (_p, body, _req, caller) => {
      const b = body as {
        sessionId: string;
        tool: string;
        arguments?: Record<string, unknown>;
        createdBy?: { id: string; type: 'user' | 'agent' | 'system' };
        auditCorrelationId?: string;
        capabilityCheck: { ok: boolean; policyId?: string; reason?: string };
        maxAttempts?: number;
        scheduledAt?: string;
      };
      const createdBy = b.createdBy ?? (caller ? callerToActor(caller) : { id: 'system', type: 'system' as const });
      const task = await cp.enqueueTask({
        sessionId: b.sessionId,
        tool: b.tool,
        arguments: b.arguments ?? {},
        createdBy,
        capabilityCheck: b.capabilityCheck,
        ...(b.auditCorrelationId !== undefined ? { auditCorrelationId: b.auditCorrelationId } : {}),
        ...(b.maxAttempts !== undefined ? { maxAttempts: b.maxAttempts } : {}),
        ...(b.scheduledAt !== undefined ? { scheduledAt: b.scheduledAt } : {}),
      });
      return { task };
    },
  });

  r.push({
    method: 'POST',
    pattern: /^\/tasks\/claim$/,
    paramNames: [],
    requiredRole: 'invoker',
    handler: async (_p, body) => {
      const b = body as { workerId: string; leaseMs: number };
      const claim = await cp.claimTask({ workerId: b.workerId, leaseMs: b.leaseMs });
      return { claim };
    },
  });

  r.push({
    method: 'GET',
    pattern: /^\/tasks\/([^/]+)$/,
    paramNames: ['id'],
    requiredRole: 'reader',
    handler: async (p) => ({ task: cp.getTask(p['id']!) }) as unknown,
  });

  r.push({
    method: 'POST',
    pattern: /^\/tasks\/([^/]+)\/heartbeat$/,
    paramNames: ['id'],
    requiredRole: 'invoker',
    handler: async (p, body) => {
      const b = body as { workerId: string; leaseMs: number };
      const task = await cp.heartbeatTask(p['id']!, { workerId: b.workerId, leaseMs: b.leaseMs });
      return { task };
    },
  });

  r.push({
    method: 'POST',
    pattern: /^\/tasks\/([^/]+)\/complete$/,
    paramNames: ['id'],
    requiredRole: 'invoker',
    handler: async (p, body) => {
      const b = body as { workerId: string; result?: Record<string, unknown> };
      const task = await cp.completeTask(p['id']!, {
        workerId: b.workerId,
        result: b.result ?? {},
      });
      return { task };
    },
  });

  r.push({
    method: 'POST',
    pattern: /^\/tasks\/([^/]+)\/fail$/,
    paramNames: ['id'],
    requiredRole: 'invoker',
    handler: async (p, body) => {
      const b = body as { workerId: string; error: string; retryDelayMs?: number };
      const task = await cp.failTask(p['id']!, {
        workerId: b.workerId,
        error: b.error,
        ...(b.retryDelayMs !== undefined ? { retryDelayMs: b.retryDelayMs } : {}),
      });
      return { task };
    },
  });

  r.push({
    method: 'POST',
    pattern: /^\/tasks\/([^/]+)\/cancel$/,
    paramNames: ['id'],
    requiredRole: 'admin',
    handler: async (p, body) => {
      const b = body as {
        reason?: string;
        actor?: { id: string; type: 'user' | 'agent' | 'system' };
      };
      const task = await cp.cancelTask(p['id']!, {
        reason: b.reason ?? 'cancelled by caller',
        actor: b.actor ?? { id: 'system:control-plane', type: 'system' },
      });
      return { task };
    },
  });

  r.push({
    method: 'POST',
    pattern: /^\/tasks\/recover$/,
    paramNames: [],
    requiredRole: 'system',
    handler: async () => {
      const tasks = await cp.recoverStuckTasks();
      return { tasks };
    },
  });

  // ── Approvals / notifications ───────────────────────────────────────

  r.push({
    method: 'POST',
    pattern: /^\/approvals$/,
    paramNames: [],
    requiredRole: 'invoker',
    handler: async (_p, body) => {
      const b = body as {
        sessionId: string;
        taskId?: string | null;
        toolCallId?: string | null;
        requestedBy: { id: string; type: 'user' | 'agent' | 'system' };
        riskReason: string;
        proposedAction: string;
        sourceEvidence?: Array<{ kind: string; id: string; summary: string }>;
        affectedResource: { kind: string; id: string };
        timeoutAt: string;
        policyRule: string;
        auditCorrelationId: string;
      };
      const approval = await cp.requestApproval({
        sessionId: b.sessionId,
        ...(b.taskId !== undefined ? { taskId: b.taskId } : {}),
        ...(b.toolCallId !== undefined ? { toolCallId: b.toolCallId } : {}),
        requestedBy: b.requestedBy,
        riskReason: b.riskReason,
        proposedAction: b.proposedAction,
        sourceEvidence: b.sourceEvidence ?? [],
        affectedResource: b.affectedResource,
        timeoutAt: b.timeoutAt,
        policyRule: b.policyRule,
        auditCorrelationId: b.auditCorrelationId,
      });
      return { approval };
    },
  });

  r.push({
    method: 'GET',
    pattern: /^\/approvals$/,
    paramNames: [],
    requiredRole: 'reader',
    handler: async () => ({ approvals: cp.listApprovals() }),
  });

  r.push({
    method: 'GET',
    pattern: /^\/approvals\/([^/]+)$/,
    paramNames: ['id'],
    requiredRole: 'reader',
    handler: async (p) => ({ approval: cp.getApproval(p['id']!) }),
  });

  r.push({
    method: 'POST',
    pattern: /^\/approvals\/([^/]+)\/decision$/,
    paramNames: ['id'],
    requiredRole: 'admin',
    handler: async (p, body) => {
      const b = body as {
        actor: { id: string; type: 'user' | 'agent' | 'system' };
        decision: 'approve' | 'deny' | 'edit' | 'cancel';
        reason?: string;
        editedAction?: string;
      };
      const approval = await cp.decideApproval(p['id']!, {
        actor: b.actor,
        decision: b.decision,
        ...(b.reason !== undefined ? { reason: b.reason } : {}),
        ...(b.editedAction !== undefined ? { editedAction: b.editedAction } : {}),
      });
      return { approval };
    },
  });

  r.push({
    method: 'POST',
    pattern: /^\/approvals\/expire$/,
    paramNames: [],
    requiredRole: 'system',
    handler: async () => ({ approvals: await cp.expireApprovals() }),
  });

  r.push({
    method: 'POST',
    pattern: /^\/tasks\/([^/]+)\/escalate-policy-denial$/,
    paramNames: ['id'],
    requiredRole: 'system',
    handler: async (p) => ({ approval: await cp.escalatePolicyDenial(p['id']!) }),
  });

  r.push({
    method: 'GET',
    pattern: /^\/notifications$/,
    paramNames: [],
    requiredRole: 'reader',
    handler: async () => ({ notifications: cp.listNotifications() }),
  });

  r.push({
    method: 'GET',
    pattern: /^\/notification-preferences$/,
    paramNames: [],
    requiredRole: 'reader',
    handler: async () => ({ preferences: cp.listNotificationPreferences() }),
  });

  r.push({
    method: 'POST',
    pattern: /^\/notification-preferences$/,
    paramNames: [],
    requiredRole: 'admin',
    handler: async (_p, body) => ({
      preference: await cp.setNotificationPreference(body as NotificationPreference),
    }),
  });

  // ── Audit log ────────────────────────────────────────────────────────

  r.push({
    method: 'GET',
    pattern: /^\/sessions\/([^/]+)\/log$/,
    paramNames: ['id'],
    requiredRole: 'reader',
    handler: async (p, _body, req) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const sinceSeqRaw = url.searchParams.get('sinceSeq');
      const limitRaw = url.searchParams.get('limit');
      const logOpts: { sinceSeq?: number; limit?: number } = {};
      if (sinceSeqRaw !== null) logOpts.sinceSeq = Number(sinceSeqRaw);
      if (limitRaw !== null) logOpts.limit = Number(limitRaw);
      const entries = await cp.getSessionLog(p['id']!, logOpts);
      return { entries };
    },
  });

  // ── Health / readiness ───────────────────────────────────────────────

  r.push({
    method: 'GET',
    pattern: /^\/healthz$/,
    paramNames: [],
    // no requiredRole — liveness is always public
    handler: async () => health.check(),
  });

  r.push({
    method: 'GET',
    pattern: /^\/readyz$/,
    paramNames: [],
    // no requiredRole — readiness is always public
    handler: async () => health.check(),
  });

  // ── Metrics ──────────────────────────────────────────────────────────

  r.push({
    method: 'GET',
    pattern: /^\/metrics$/,
    paramNames: [],
    requiredRole: 'admin',
    handler: async () => metrics.snapshot(),
  });

  // ── Card registration (optional) ─────────────────────────────────────

  if (opts.exposeCardRegistration) {
    r.push({
      method: 'POST',
      pattern: /^\/cards$/,
      paramNames: [],
      requiredRole: 'admin',
      handler: async (_p, body) => {
        await cp.registerCard(body as AgentCard);
        return { ok: true };
      },
    });
  }

  return r;
}

async function readBody(req: IncomingMessage, max = 1 << 20): Promise<unknown> {
  // Node 22 has a native body stream helper, but we stay explicit.
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (c: Buffer) => {
      total += c.length;
      if (total > max) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

function matchRoute(
  routes: Route[],
  method: string,
  pathname: string,
): { route: Route; params: Record<string, string> } | null {
  for (const route of routes) {
    if (route.method !== method) continue;
    const m = route.pattern.exec(pathname);
    if (!m) continue;
    const params: Record<string, string> = {};
    route.paramNames.forEach((n, i) => {
      const v = m[i + 1];
      if (v !== undefined) params[n] = decodeURIComponent(v);
    });
    return { route, params };
  }
  return null;
}

export interface FagaosHttpServer {
  listen(port: number, host?: string): Promise<{ port: number; close: () => void }>;
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>;
}

export function createHttpServer(opts: HttpServerOptions): FagaosHttpServer {
  const routes = buildRoutes(opts);
  const log = opts.logger ?? createLogger('control-plane');
  const metrics = opts.metrics ?? createMetrics();

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const start = Date.now();
    const method = (req.method ?? 'GET').toUpperCase();
    const url = new URL(req.url ?? '/', 'http://localhost');
    const correlationId = newCorrelationId();
    const reqLog = log.child({ correlationId, method, path: url.pathname });

    const matched = matchRoute(routes, method, url.pathname);
    if (!matched) {
      metrics.inc('http.not_found');
      reqLog.warn('route not found', { statusCode: 404 });
      json(res, 404, { error: 'not_found', message: `no route for ${method} ${url.pathname}` });
      return;
    }

    // ── Authentication ────────────────────────────────────────────────
    let caller: CallerIdentity | null = null;
    const routeRequiresAuth = matched.route.requiredRole !== undefined;

    if (routeRequiresAuth) {
      if (!opts.auth) {
        // No auth config — dev/test mode, synthesise a system caller with admin rights
        caller = { id: 'system:dev', type: 'system', role: 'admin' };
      } else {
        const authResult = authenticate(req.headers['authorization'], opts.auth);
        if (!authResult.ok) {
          metrics.inc('http.auth_fail');
          reqLog.warn('authentication failed', { code: authResult.code, statusCode: authResult.status });
          json(res, authResult.status, { error: authResult.code, message: authResult.message });
          return;
        }
        const authzResult = authorize(authResult.caller, matched.route.requiredRole!);
        if (!authzResult.ok) {
          metrics.inc('http.authz_fail');
          reqLog.warn('authorization denied', {
            callerId: authResult.caller.id,
            required: matched.route.requiredRole,
            actual: authResult.caller.role,
            statusCode: 403,
          });
          json(res, authzResult.status, { error: authzResult.code, message: authzResult.message });
          return;
        }
        caller = authResult.caller;
      }
    }

    // ── Body parsing ──────────────────────────────────────────────────
    let body: unknown = {};
    if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
      try {
        body = await readBody(req);
      } catch (e) {
        metrics.inc('http.bad_request');
        json(res, 400, { error: 'invalid_json', message: (e as Error).message });
        return;
      }
    }

    // ── Dispatch ──────────────────────────────────────────────────────
    try {
      const result = await matched.route.handler(matched.params, body, req, caller);
      const durationMs = Date.now() - start;
      metrics.inc('http.ok');
      reqLog.info('request ok', {
        statusCode: 200,
        durationMs,
        callerId: caller?.id,
      });
      json(res, 200, result);
    } catch (e) {
      const durationMs = Date.now() - start;
      if (e instanceof ControlPlaneError) {
        const status =
          e.code === 'session_not_found' || e.code === 'task_not_found' ? 404
          : e.code === 'invalid_input' ? 400
          : 409;
        metrics.inc(`http.error.${e.code}`);
        reqLog.warn('control plane error', { statusCode: status, code: e.code, durationMs });
        json(res, status, { error: e.code, message: e.message });
      } else {
        metrics.inc('http.error.internal');
        reqLog.error('internal error', { statusCode: 500, error: (e as Error).message, durationMs });
        json(res, 500, { error: 'internal', message: (e as Error).message });
      }
    }
  }

  return {
    handle,
    listen(port, host = '127.0.0.1') {
      return new Promise((resolve) => {
        const server = createServer((req, res) => {
          void handle(req, res);
        });
        server.listen(port, host, () => {
          const addr = server.address();
          const actualPort = typeof addr === 'object' && addr ? addr.port : port;
          resolve({ port: actualPort, close: () => server.close() });
        });
      });
    },
  };
}
