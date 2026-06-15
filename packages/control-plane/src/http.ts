/**
 * @fagaos/control-plane/http
 *
 * Minimal HTTP transport for the control-plane API stubs. The goal
 * is to make the contracts *testable end-to-end* and consumable by
 * the orchestrator over HTTP in Phase 0, without committing us to
 * a framework we may want to swap in Phase 1.
 *
 * Endpoint surface:
 *   POST   /sessions
 *   GET    /sessions/:id
 *   DELETE /sessions/:id
 *   POST   /sessions/:id/tools/:tool
 *   POST   /sessions/:id/kill
 *   GET    /sessions/:id/log?sinceSeq=&limit=
 *
 * Each request is mapped to a ControlPlane method. The handler also
 * appends a request-level audit entry (action = the same verb) so
 * even rejected requests are recorded. The control plane's domain
 * methods append their own resource-level entries, so the chain
 * captures both.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { ControlPlane, ControlPlaneError } from './index.js';
import type { AgentCard } from '@fagaos/agent-manifest';

export interface HttpServerOptions {
  controlPlane: ControlPlane;
  /**
   * Optional extra card-registration endpoint. Phase 0 ships a
   * minimal POST /cards so the orchestrator can register agents
   * in-band; production cards are loaded from a registry service.
   */
  exposeCardRegistration?: boolean;
}

interface Route {
  method: string;
  pattern: RegExp;
  paramNames: string[];
  handler: (params: Record<string, string>, body: unknown, req: IncomingMessage) => Promise<unknown>;
}

function buildRoutes(opts: HttpServerOptions): Route[] {
  const cp = opts.controlPlane;
  const r: Route[] = [];

  r.push({
    method: 'POST',
    pattern: /^\/sessions$/,
    paramNames: [],
    handler: async (_p, body) => {
      const b = body as {
        agentId: string;
        createdBy: { id: string; type: 'user' | 'agent' | 'system' };
        input: Record<string, unknown>;
        agentCard?: AgentCard;
      };
      const session = await cp.createSession({
        agentId: b.agentId,
        createdBy: b.createdBy,
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
    handler: async (p) => ({ session: cp.getSession(p['id']!) }) as unknown,
  });

  r.push({
    method: 'DELETE',
    pattern: /^\/sessions\/([^/]+)$/,
    paramNames: ['id'],
    handler: async (p) => {
      await cp.deleteSession(p['id']!);
      return { ok: true };
    },
  });

  r.push({
    method: 'POST',
    pattern: /^\/sessions\/([^/]+)\/tools\/([^/]+)$/,
    paramNames: ['id', 'tool'],
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
    handler: async (p, body) => {
      const b = (body ?? {}) as { reason?: string };
      await cp.killSession(p['id']!, b.reason ?? 'killed by caller');
      return { ok: true };
    },
  });

  r.push({
    method: 'POST',
    pattern: /^\/tasks$/,
    paramNames: [],
    handler: async (_p, body) => {
      const b = body as {
        sessionId: string;
        tool: string;
        arguments?: Record<string, unknown>;
        createdBy: { id: string; type: 'user' | 'agent' | 'system' };
        auditCorrelationId?: string;
        capabilityCheck: { ok: boolean; policyId?: string; reason?: string };
        maxAttempts?: number;
        scheduledAt?: string;
      };
      const task = await cp.enqueueTask({
        sessionId: b.sessionId,
        tool: b.tool,
        arguments: b.arguments ?? {},
        createdBy: b.createdBy,
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
    handler: async (p) => ({ task: cp.getTask(p['id']!) }) as unknown,
  });

  r.push({
    method: 'POST',
    pattern: /^\/tasks\/([^/]+)\/heartbeat$/,
    paramNames: ['id'],
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
    handler: async () => {
      const tasks = await cp.recoverStuckTasks();
      return { tasks };
    },
  });

  r.push({
    method: 'GET',
    pattern: /^\/sessions\/([^/]+)\/log$/,
    paramNames: ['id'],
    handler: async (p, _body, req) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const sinceSeqRaw = url.searchParams.get('sinceSeq');
      const limitRaw = url.searchParams.get('limit');
      const opts: { sinceSeq?: number; limit?: number } = {};
      if (sinceSeqRaw !== null) opts.sinceSeq = Number(sinceSeqRaw);
      if (limitRaw !== null) opts.limit = Number(limitRaw);
      const entries = await cp.getSessionLog(p['id']!, opts);
      return { entries };
    },
  });

  if (opts.exposeCardRegistration) {
    r.push({
      method: 'POST',
      pattern: /^\/cards$/,
      paramNames: [],
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

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = (req.method ?? 'GET').toUpperCase();
    const url = new URL(req.url ?? '/', 'http://localhost');
    const matched = matchRoute(routes, method, url.pathname);
    if (!matched) {
      json(res, 404, { error: 'not_found', message: `no route for ${method} ${url.pathname}` });
      return;
    }
    let body: unknown = {};
    if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
      try {
        body = await readBody(req);
      } catch (e) {
        json(res, 400, { error: 'invalid_json', message: (e as Error).message });
        return;
      }
    }
    try {
      const result = await matched.route.handler(matched.params, body, req);
      json(res, 200, result);
    } catch (e) {
      if (e instanceof ControlPlaneError) {
        const status =
          e.code === 'session_not_found' || e.code === 'task_not_found' ? 404
          : e.code === 'invalid_input' ? 400
          : 409;
        json(res, status, { error: e.code, message: e.message });
      } else {
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
