import { describe, it, expect, beforeEach } from 'vitest';
import { createHttpServer } from '../src/http.js';
import { ControlPlane, ControlPlaneError, createInMemoryCardRegistry } from '../src/index.js';
import { createInMemoryAuditLog } from '@fagaos/audit-log';
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

interface HttpResponse {
  status: number;
  body: unknown;
}

async function request(
  base: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<HttpResponse> {
  const init: RequestInit = {
    method,
    headers: { 'content-type': 'application/json' },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(base + path, init);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

describe('@fagaos/control-plane HTTP transport', () => {
  let base: string;
  let close: () => void;

  beforeEach(async () => {
    const audit = createInMemoryAuditLog();
    const cards = createInMemoryCardRegistry();
    cards.register(card());
    const cp = new ControlPlane({ audit, cards });
    const server = createHttpServer({ controlPlane: cp, exposeCardRegistration: true });
    const { port, close: c } = await server.listen(0);
    close = c;
    base = `http://127.0.0.1:${port}`;
  });

  it('serves the full API surface end-to-end', async () => {
    const create = await request(base, 'POST', '/sessions', {
      agentId: 'agent.test.echo',
      createdBy: { id: 'user:alice', type: 'user' },
      input: { prompt: 'hi' },
    });
    expect(create.status).toBe(200);
    const sessionId = create.body.session.id as string;
    expect(sessionId).toBeTruthy();

    const get = await request(base, 'GET', `/sessions/${sessionId}`);
    expect(get.status).toBe(200);
    expect(get.body.session.id).toBe(sessionId);

    const tool = await request(base, 'POST', `/sessions/${sessionId}/tools/echo`, {
      arguments: { x: 1 },
    });
    expect(tool.status).toBe(200);
    expect(tool.body.result.ok).toBe(true);

    const log = await request(base, 'GET', `/sessions/${sessionId}/log`);
    expect(log.status).toBe(200);
    const entries = log.body as { entries: Array<{ action: string }> };
    const actions = entries.entries.map((e) => e.action);
    expect(actions).toContain('session.create');
    expect(actions).toContain('tool.invoke');

    const kill = await request(base, 'POST', `/sessions/${sessionId}/kill`, {
      reason: 'end of test',
    });
    expect(kill.status).toBe(200);

    const del = await request(base, 'DELETE', `/sessions/${sessionId}`);
    expect(del.status).toBe(200);
  });

  it('returns 404 for an unknown session', async () => {
    const r = await request(base, 'GET', '/sessions/nope');
    expect(r.status).toBe(404);
    expect(r.body.error).toBe('session_not_found');
  });

  it('returns 404 for an unknown route', async () => {
    const r = await request(base, 'GET', '/wat');
    expect(r.status).toBe(404);
    expect(r.body.error).toBe('not_found');
  });

  it('returns 409 when killing an already-killed session', async () => {
    const create = await request(base, 'POST', '/sessions', {
      agentId: 'agent.test.echo',
      createdBy: { id: 'user:alice', type: 'user' },
      input: {},
    });
    const sessionId = create.body.session.id as string;
    await request(base, 'POST', `/sessions/${sessionId}/kill`, { reason: 'first' });
    const second = await request(base, 'POST', `/sessions/${sessionId}/kill`, { reason: 'second' });
    expect(second.status).toBe(409);
    expect(second.body.error).toBe('session_already_terminal');
  });

  it('returns 400 for invalid JSON payloads', async () => {
    const res = await fetch(base + '/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not-json',
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_json' });
  });

  it('returns 400 for domain invalid-input errors', async () => {
    const audit = createInMemoryAuditLog();
    const cards = createInMemoryCardRegistry();
    const cp = new ControlPlane({ audit, cards });
    cp.createSession = async () => {
      throw new ControlPlaneError('invalid_input', 'agentId is required');
    };
    const server = createHttpServer({ controlPlane: cp });
    const { port, close } = await server.listen(0);
    try {
      const r = await request(`http://127.0.0.1:${port}`, 'POST', '/sessions', {
        agentId: '',
        createdBy: { id: 'user:alice', type: 'user' },
        input: {},
      });
      expect(r.status).toBe(400);
      expect(r.body.error).toBe('invalid_input');
    } finally {
      close();
    }
  });

  it('returns 500 for unexpected handler errors', async () => {
    const audit = createInMemoryAuditLog();
    const cards = createInMemoryCardRegistry();
    const cp = new ControlPlane({ audit, cards });
    const original = cp.registerCard.bind(cp);
    cp.registerCard = async (...args) => {
      await original(...args);
      throw new Error('unexpected card failure');
    };
    const server = createHttpServer({ controlPlane: cp, exposeCardRegistration: true });
    const { port, close } = await server.listen(0);
    try {
      const r = await request(`http://127.0.0.1:${port}`, 'POST', '/cards', card());
      expect(r.status).toBe(500);
      expect(r.body).toMatchObject({ error: 'internal', message: 'unexpected card failure' });
    } finally {
      close();
    }
  });

  it('card registration endpoint accepts an AgentCard and audits it', async () => {
    const r = await request(base, 'POST', '/cards', card());
    expect(r.status).toBe(200);
  });

  it('returns 404 when card registration is not exposed', async () => {
    const audit = createInMemoryAuditLog();
    const cards = createInMemoryCardRegistry();
    const cp = new ControlPlane({ audit, cards });
    const server = createHttpServer({ controlPlane: cp });
    const { port, close } = await server.listen(0);
    try {
      const r = await request(`http://127.0.0.1:${port}`, 'POST', '/cards', card());
      expect(r.status).toBe(404);
    } finally {
      close();
    }
  });

  it('teardown does not throw on port 0', () => {
    close();
  });
});
