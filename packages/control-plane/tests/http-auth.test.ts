/**
 * Integration tests for the HTTP auth/observability layer.
 *
 * Tests:
 *  - unauthenticated requests return 401
 *  - wrong-scheme requests return 401
 *  - valid token with insufficient role returns 403
 *  - valid token with sufficient role returns 200
 *  - health/readiness endpoints bypass auth
 *  - metrics endpoint requires admin role
 *  - policy denial visibility through structured log emission
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHttpServer } from '../src/http.js';
import { ControlPlane, createInMemoryCardRegistry } from '../src/index.js';
import { createInMemoryAuditLog } from '@fagaos/audit-log';
import type { AuthConfig, CallerIdentity } from '../src/auth.js';
import type { z } from 'zod';
import { AgentCardSchema } from '@fagaos/agent-manifest';

type AgentCardInput = z.input<typeof AgentCardSchema>;

function card(): AgentCardInput {
  return {
    id: 'agent.test.echo',
    name: 'Echo Agent',
    version: '0.1.0',
    owner: { id: 'team:platform' },
    auth: { kind: 'none' },
  };
}

const ADMIN: CallerIdentity  = { id: 'user:admin',  type: 'user',   role: 'admin'  };
const READER: CallerIdentity = { id: 'user:reader', type: 'user',   role: 'reader' };
const AGENT: CallerIdentity  = { id: 'agent:w',     type: 'agent',  role: 'invoker' };

function makeAuth(): AuthConfig {
  return {
    tokens: new Map([
      ['tok-admin',  ADMIN],
      ['tok-reader', READER],
      ['tok-agent',  AGENT],
    ]),
  };
}

async function req(
  base: string,
  method: string,
  path: string,
  opts: { token?: string; body?: unknown } = {},
): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.token) headers['authorization'] = `Bearer ${opts.token}`;
  const init: RequestInit = { method, headers };
  if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
  const res = await fetch(base + path, init);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

describe('control-plane HTTP auth', () => {
  let base: string;
  let close: () => void;

  beforeEach(async () => {
    const audit = createInMemoryAuditLog();
    const cards = createInMemoryCardRegistry();
    cards.register(card());
    const cp = new ControlPlane({ audit, cards });
    const server = createHttpServer({
      controlPlane: cp,
      auth: makeAuth(),
      exposeCardRegistration: true,
    });
    const { port, close: c } = await server.listen(0);
    close = c;
    base = `http://127.0.0.1:${port}`;
  });

  afterEach(() => close());

  // ── Unauthenticated access ────────────────────────────────────────────

  it('returns 401 when Authorization header is missing', async () => {
    const r = await req(base, 'POST', '/sessions', {
      body: { agentId: 'agent.test.echo', input: {} },
    });
    expect(r.status).toBe(401);
    expect((r.body as Record<string,string>).error).toBe('missing_token');
  });

  it('returns 401 for wrong auth scheme', async () => {
    const r = await fetch(base + '/sessions', {
      method: 'POST',
      headers: { authorization: 'Basic dXNlcjpwYXNz', 'content-type': 'application/json' },
      body: JSON.stringify({ agentId: 'agent.test.echo', input: {} }),
    });
    expect(r.status).toBe(401);
    const body = await r.json() as Record<string,string>;
    expect(body.error).toBe('invalid_scheme');
  });

  it('returns 401 for an invalid token', async () => {
    const r = await req(base, 'POST', '/sessions', {
      token: 'bad-token',
      body: { agentId: 'agent.test.echo', input: {} },
    });
    expect(r.status).toBe(401);
    expect((r.body as Record<string,string>).error).toBe('invalid_token');
  });

  // ── Authorization ────────────────────────────────────────────────────

  it('returns 403 when reader tries to create a session (invoker required)', async () => {
    const r = await req(base, 'POST', '/sessions', {
      token: 'tok-reader',
      body: { agentId: 'agent.test.echo', input: {} },
    });
    expect(r.status).toBe(403);
    expect((r.body as Record<string,string>).error).toBe('forbidden');
  });

  it('returns 403 when invoker tries to kill a session (admin required)', async () => {
    // Create session with admin first
    const create = await req(base, 'POST', '/sessions', {
      token: 'tok-admin',
      body: { agentId: 'agent.test.echo', input: {} },
    });
    expect(create.status).toBe(200);
    const id = (create.body as { session: { id: string } }).session.id;

    const kill = await req(base, 'POST', `/sessions/${id}/kill`, {
      token: 'tok-agent',
    });
    expect(kill.status).toBe(403);
  });

  it('allows a reader to GET a session', async () => {
    const create = await req(base, 'POST', '/sessions', {
      token: 'tok-admin',
      body: { agentId: 'agent.test.echo', input: {} },
    });
    const id = (create.body as { session: { id: string } }).session.id;

    const get = await req(base, 'GET', `/sessions/${id}`, { token: 'tok-reader' });
    expect(get.status).toBe(200);
  });

  it('allows an admin to fully manage a session', async () => {
    const create = await req(base, 'POST', '/sessions', {
      token: 'tok-admin',
      body: { agentId: 'agent.test.echo', input: {} },
    });
    expect(create.status).toBe(200);
    const id = (create.body as { session: { id: string } }).session.id;

    const kill = await req(base, 'POST', `/sessions/${id}/kill`, { token: 'tok-admin' });
    expect(kill.status).toBe(200);
  });

  // ── Health / readiness (no auth required) ────────────────────────────

  it('returns health without auth', async () => {
    const r = await req(base, 'GET', '/healthz');
    expect(r.status).toBe(200);
    expect((r.body as { status: string }).status).toBe('ok');
  });

  it('returns readiness without auth', async () => {
    const r = await req(base, 'GET', '/readyz');
    expect(r.status).toBe(200);
    expect((r.body as { status: string }).status).toBe('ok');
  });

  // ── Metrics ──────────────────────────────────────────────────────────

  it('returns 401 for metrics without auth', async () => {
    const r = await req(base, 'GET', '/metrics');
    expect(r.status).toBe(401);
  });

  it('returns 403 for metrics with reader token', async () => {
    const r = await req(base, 'GET', '/metrics', { token: 'tok-reader' });
    expect(r.status).toBe(403);
  });

  it('returns metrics snapshot for admin', async () => {
    // Make a successful request first to populate counters
    await req(base, 'GET', '/healthz');
    const r = await req(base, 'GET', '/metrics', { token: 'tok-admin' });
    expect(r.status).toBe(200);
    const snap = r.body as { counters: Record<string, number> };
    expect(typeof snap.counters).toBe('object');
  });

  // ── Authenticated caller becomes createdBy ────────────────────────────

  it('uses caller identity as createdBy when not supplied', async () => {
    const r = await req(base, 'POST', '/sessions', {
      token: 'tok-admin',
      body: { agentId: 'agent.test.echo', input: {} },
    });
    expect(r.status).toBe(200);
    const session = (r.body as { session: { createdBy: { id: string } } }).session;
    expect(session.createdBy.id).toBe('user:admin');
  });
});

describe('control-plane HTTP auth — dev mode (no auth config)', () => {
  let base: string;
  let close: () => void;

  beforeEach(async () => {
    const audit = createInMemoryAuditLog();
    const cards = createInMemoryCardRegistry();
    cards.register(card());
    const cp = new ControlPlane({ audit, cards });
    // no auth config → dev mode, all requests pass as system:dev/admin
    const server = createHttpServer({ controlPlane: cp });
    const { port, close: c } = await server.listen(0);
    close = c;
    base = `http://127.0.0.1:${port}`;
  });

  afterEach(() => close());

  it('allows unauthenticated requests in dev mode', async () => {
    const r = await req(base, 'POST', '/sessions', {
      body: { agentId: 'agent.test.echo', input: {} },
    });
    expect(r.status).toBe(200);
  });
});

describe('control-plane HTTP observability — structured log emission', () => {
  it('logs a warning for auth failures with correlationId', async () => {
    const logLines: string[] = [];
    // eslint-disable-next-line no-console
    const orig = console.log;
    // eslint-disable-next-line no-console
    console.log = (s: string) => { logLines.push(s); orig(s); };

    try {
      const audit = createInMemoryAuditLog();
      const cards = createInMemoryCardRegistry();
      cards.register(card());
      const cp = new ControlPlane({ audit, cards });
      const server = createHttpServer({ controlPlane: cp, auth: makeAuth() });
      const { port, close } = await server.listen(0);
      try {
        await fetch(`http://127.0.0.1:${port}/sessions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ agentId: 'agent.test.echo', input: {} }),
        });
      } finally {
        close();
      }
    } finally {
      // eslint-disable-next-line no-console
      console.log = orig;
    }

    const records = logLines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const authWarn = records.find((r: Record<string,unknown>) => r.level === 'warn' && r.code === 'missing_token');
    expect(authWarn).toBeTruthy();
    expect(authWarn.correlationId).toBeTruthy();
    expect(authWarn.service).toBe('control-plane');
  });

  it('emits metrics counters for auth failures', async () => {
    const { createMetrics: cm } = await import('../src/observability.js');
    const metrics = cm();

    const audit = createInMemoryAuditLog();
    const cards = createInMemoryCardRegistry();
    cards.register(card());
    const cp = new ControlPlane({ audit, cards });
    const server = createHttpServer({ controlPlane: cp, auth: makeAuth(), metrics });
    const { port, close } = await server.listen(0);
    try {
      await fetch(`http://127.0.0.1:${port}/sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agentId: 'agent.test.echo', input: {} }),
      });
    } finally {
      close();
    }
    expect(metrics.snapshot().counters['http.auth_fail']).toBe(1);
  });
});
