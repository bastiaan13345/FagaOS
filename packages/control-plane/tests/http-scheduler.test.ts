import { beforeEach, describe, expect, it } from 'vitest';
import { createHttpServer } from '../src/http.js';
import { ControlPlane, createInMemoryCardRegistry } from '../src/index.js';
import { createInMemoryAuditLog } from '@fagaos/audit-log';
import type { z } from 'zod';
import { AgentCardSchema } from '@fagaos/agent-manifest';

type AgentCardInput = z.input<typeof AgentCardSchema>;

function card(): AgentCardInput {
  return {
    id: 'agent.test.http-scheduler',
    name: 'HTTP Scheduler Agent',
    version: '0.1.0',
    owner: { id: 'team:platform' },
    auth: { kind: 'none' },
    capabilities: [{ name: 'echo' }],
  };
}

async function request(base: string, method: string, path: string, body?: unknown) {
  const init: RequestInit = {
    method,
    headers: { 'content-type': 'application/json' },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(base + path, init);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

function streamReq(method: string, url: string, chunks: string[]) {
  const listeners = new Map<string, Array<(arg?: unknown) => void>>();
  return {
    method,
    url,
    destroyed: false,
    on(event: string, fn: (arg?: unknown) => void) {
      listeners.set(event, [...(listeners.get(event) ?? []), fn]);
      return this;
    },
    destroy() {
      this.destroyed = true;
    },
    emitBody() {
      for (const chunk of chunks) {
        for (const fn of listeners.get('data') ?? []) fn(Buffer.from(chunk));
      }
      for (const fn of listeners.get('end') ?? []) fn();
    },
  };
}

function captureRes() {
  let body = '';
  return {
    statusCode: 0,
    setHeader() {},
    end(value: string) {
      body = value;
    },
    body: () => JSON.parse(body),
  };
}

describe('@fagaos/control-plane HTTP scheduler routes', () => {
  let base: string;
  let close: () => void;

  beforeEach(async () => {
    const audit = createInMemoryAuditLog();
    const cards = createInMemoryCardRegistry();
    cards.register(card());
    const cp = new ControlPlane({ audit, cards });
    const server = createHttpServer({ controlPlane: cp });
    const listened = await server.listen(0);
    base = `http://127.0.0.1:${listened.port}`;
    close = listened.close;
  });

  it('serves enqueue, claim, heartbeat, complete, and recover routes', async () => {
    const created = await request(base, 'POST', '/sessions', {
      agentId: 'agent.test.http-scheduler',
      createdBy: { id: 'user:alice', type: 'user' },
      input: {},
    });
    const sessionId = created.body.session.id as string;

    const enqueued = await request(base, 'POST', '/tasks', {
      sessionId,
      tool: 'echo',
      arguments: { x: 1 },
      createdBy: { id: 'user:alice', type: 'user' },
      auditCorrelationId: 'corr-http',
      capabilityCheck: { ok: true },
    });
    expect(enqueued.status).toBe(200);
    const taskId = enqueued.body.task.id as string;

    const claimed = await request(base, 'POST', '/tasks/claim', {
      workerId: 'worker-1',
      leaseMs: 1_000,
    });
    expect(claimed.status).toBe(200);
    expect(claimed.body.claim.task.id).toBe(taskId);

    const heartbeat = await request(base, 'POST', `/tasks/${taskId}/heartbeat`, {
      workerId: 'worker-1',
      leaseMs: 2_000,
    });
    expect(heartbeat.status).toBe(200);
    expect(heartbeat.body.task.leaseExpiresAt).toEqual(expect.any(String));

    const completed = await request(base, 'POST', `/tasks/${taskId}/complete`, {
      workerId: 'worker-1',
      result: { ok: true },
    });
    expect(completed.status).toBe(200);
    expect(completed.body.task.state).toBe('completed');

    const recovered = await request(base, 'POST', '/tasks/recover', {});
    expect(recovered.status).toBe(200);
    expect(recovered.body.tasks).toEqual([]);

    close();
  });

  it('serves retry and default cancellation paths', async () => {
    const created = await request(base, 'POST', '/sessions', {
      agentId: 'agent.test.http-scheduler',
      createdBy: { id: 'user:alice', type: 'user' },
      input: {},
    });
    const sessionId = created.body.session.id as string;

    const retryTask = await request(base, 'POST', '/tasks', {
      sessionId,
      tool: 'echo',
      arguments: {},
      createdBy: { id: 'user:alice', type: 'user' },
      capabilityCheck: { ok: true },
      maxAttempts: 2,
    });
    const retryTaskId = retryTask.body.task.id as string;
    await request(base, 'POST', '/tasks/claim', { workerId: 'worker-1', leaseMs: 1_000 });
    const failed = await request(base, 'POST', `/tasks/${retryTaskId}/fail`, {
      workerId: 'worker-1',
      error: 'temporary',
      retryDelayMs: 10,
    });
    expect(failed.status).toBe(200);
    expect(failed.body.task.state).toBe('queued');

    const cancelTask = await request(base, 'POST', '/tasks', {
      sessionId,
      tool: 'echo',
      arguments: {},
      createdBy: { id: 'user:alice', type: 'user' },
      capabilityCheck: { ok: true },
    });
    const cancelTaskId = cancelTask.body.task.id as string;
    const cancelled = await request(base, 'POST', `/tasks/${cancelTaskId}/cancel`, {});
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.task).toMatchObject({
      state: 'cancelled',
      terminalReason: 'cancelled by caller',
    });

    close();
  });

  it('returns 400 when a request body exceeds the size limit', async () => {
    close();
    const audit = createInMemoryAuditLog();
    const cards = createInMemoryCardRegistry();
    cards.register(card());
    const cp = new ControlPlane({ audit, cards });
    const server = createHttpServer({ controlPlane: cp });
    const req = streamReq('POST', '/tasks/recover', ['x'.repeat((1 << 20) + 1)]);
    const res = captureRes();

    const handled = server.handle(req as never, res as never);
    req.emitBody();
    await handled;

    expect(req.destroyed).toBe(true);
    expect(res.statusCode).toBe(400);
    expect(res.body()).toMatchObject({ error: 'invalid_json' });
  });
});
