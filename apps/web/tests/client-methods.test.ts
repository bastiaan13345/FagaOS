import { describe, expect, it } from 'vitest';
import {
  AuditEntrySchema,
  TaskSchema,
  ToolResultSchema,
} from '../src/lib/api/types';
import { createControlPlaneClient } from '../src/lib/api/client';

const baseUrl = 'http://control-plane.test';

function fixedJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function makeTask(overrides: Partial<ReturnType<typeof TaskSchema.parse>> = {}) {
  return TaskSchema.parse({
    id: 'task-1',
    sessionId: 'session-1',
    tool: 'browser.navigate',
    arguments: {},
    state: 'queued',
    createdAt: '2026-06-15T12:00:00.000Z',
    updatedAt: '2026-06-15T12:00:00.000Z',
    scheduledAt: '2026-06-15T12:00:00.000Z',
    attempt: 0,
    maxAttempts: 3,
    createdBy: { id: 'user:alice', type: 'user' },
    auditCorrelationId: 'corr-1',
    capabilityCheck: { ok: true },
    ...overrides,
  });
}

function makeAuditEntry(overrides: Record<string, unknown> = {}) {
  return AuditEntrySchema.parse({
    id: 'audit-1',
    seq: 1,
    ts: '2026-06-15T12:00:00.000Z',
    actor: { id: 'user:alice', type: 'user' },
    action: 'task.enqueue',
    resource: { kind: 'task', id: 'task-1' },
    data: {},
    prevHash: '0'.repeat(64),
    hash: '0'.repeat(64),
    signedCheckpoint: { algorithm: 'ed25519-stub-v1', payload: 'p', signature: 's' },
    ...overrides,
  });
}

describe('control-plane HTTP client — full method coverage', () => {
  it('invokes a tool and parses the result', async () => {
    const tool = ToolResultSchema.parse({
      ok: true,
      result: { value: 42 },
      durationMs: 12,
      correlationId: 'corr-1',
    });
    const fetchImpl: typeof fetch = async (input, init) => {
      expect(String(input)).toBe(`${baseUrl}/sessions/session-1/tools/browser.navigate`);
      expect(init?.method).toBe('POST');
      return fixedJsonResponse({ result: tool });
    };
    const client = createControlPlaneClient({ baseUrl, fetchImpl });
    const result = await client.invokeTool('session-1', 'browser.navigate', { arguments: { url: 'x' } });
    expect(result.ok).toBe(true);
    expect(result.correlationId).toBe('corr-1');
  });

  it('kills a session and parses an ok response', async () => {
    const fetchImpl: typeof fetch = async (input, init) => {
      expect(String(input)).toBe(`${baseUrl}/sessions/session-1/kill`);
      expect(init?.method).toBe('POST');
      return fixedJsonResponse({ ok: true });
    };
    const client = createControlPlaneClient({ baseUrl, fetchImpl });
    await client.killSession('session-1', { reason: 'done' });
  });

  it('kills a session without an explicit reason', async () => {
    const fetchImpl: typeof fetch = async () => fixedJsonResponse({ ok: true });
    const client = createControlPlaneClient({ baseUrl, fetchImpl });
    await client.killSession('session-1');
  });

  it('reads the per-session audit log with sinceSeq and limit', async () => {
    const entry = makeAuditEntry();
    const fetchImpl: typeof fetch = async (input) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe('/sessions/session-1/log');
      expect(url.searchParams.get('sinceSeq')).toBe('0');
      expect(url.searchParams.get('limit')).toBe('25');
      return fixedJsonResponse({ entries: [entry] });
    };
    const client = createControlPlaneClient({ baseUrl, fetchImpl });
    const entries = await client.getSessionAuditLog('session-1', { sinceSeq: 0, limit: 25 });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.id).toBe('audit-1');
  });

  it('registers an agent card', async () => {
    const fetchImpl: typeof fetch = async (input) => {
      expect(String(input)).toBe(`${baseUrl}/cards`);
      return fixedJsonResponse({ ok: true });
    };
    const client = createControlPlaneClient({ baseUrl, fetchImpl });
    await client.registerCard({
      id: 'agent.echo',
      name: 'Echo',
      version: '0.1.0',
      owner: { id: 'team:platform' },
      auth: { kind: 'none' },
      capabilities: [],
    });
  });

  it('enqueues a task and parses the response', async () => {
    const task = makeTask();
    const fetchImpl: typeof fetch = async (input, init) => {
      expect(String(input)).toBe(`${baseUrl}/tasks`);
      expect(init?.method).toBe('POST');
      return fixedJsonResponse({ task });
    };
    const client = createControlPlaneClient({ baseUrl, fetchImpl });
    const result = await client.enqueueTask({
      sessionId: 'session-1',
      tool: 'browser.navigate',
      createdBy: { id: 'user:alice', type: 'user' },
      capabilityCheck: { ok: true },
    });
    expect(result.id).toBe('task-1');
  });

  it('recovers tasks', async () => {
    const fetchImpl: typeof fetch = async (input) => {
      expect(String(input)).toBe(`${baseUrl}/tasks/recover`);
      return fixedJsonResponse({ tasks: [makeTask()] });
    };
    const client = createControlPlaneClient({ baseUrl, fetchImpl });
    const tasks = await client.recoverTasks();
    expect(tasks).toHaveLength(1);
  });

  it('fetches a single task by id', async () => {
    const task = makeTask();
    const fetchImpl: typeof fetch = async (input) => {
      expect(String(input)).toBe(`${baseUrl}/tasks/task-1`);
      return fixedJsonResponse({ task });
    };
    const client = createControlPlaneClient({ baseUrl, fetchImpl });
    const result = await client.getTask('task-1');
    expect(result.id).toBe('task-1');
  });

  it('sends a heartbeat for a claimed task', async () => {
    const task = makeTask({ state: 'claimed' });
    const fetchImpl: typeof fetch = async (input, init) => {
      expect(String(input)).toBe(`${baseUrl}/tasks/task-1/heartbeat`);
      expect(init?.method).toBe('POST');
      return fixedJsonResponse({ task });
    };
    const client = createControlPlaneClient({ baseUrl, fetchImpl });
    const result = await client.heartbeatTask('task-1', { workerId: 'w-1', leaseMs: 5000 });
    expect(result.state).toBe('claimed');
  });

  it('marks a task complete', async () => {
    const task = makeTask({ state: 'completed' });
    const fetchImpl: typeof fetch = async () => fixedJsonResponse({ task });
    const client = createControlPlaneClient({ baseUrl, fetchImpl });
    const result = await client.completeTask('task-1', { workerId: 'w-1', result: { ok: true } });
    expect(result.state).toBe('completed');
  });

  it('fails a task', async () => {
    const task = makeTask({ state: 'failed' });
    const fetchImpl: typeof fetch = async () => fixedJsonResponse({ task });
    const client = createControlPlaneClient({ baseUrl, fetchImpl });
    const result = await client.failTask('task-1', { workerId: 'w-1', error: 'boom' });
    expect(result.state).toBe('failed');
  });

  it('cancels a task with an explicit reason', async () => {
    const task = makeTask({ state: 'cancelled' });
    const fetchImpl: typeof fetch = async () => fixedJsonResponse({ task });
    const client = createControlPlaneClient({ baseUrl, fetchImpl });
    const result = await client.cancelTask('task-1', { reason: 'operator request' });
    expect(result.state).toBe('cancelled');
  });

  it('cancels a task without arguments', async () => {
    const task = makeTask({ state: 'cancelled' });
    const fetchImpl: typeof fetch = async () => fixedJsonResponse({ task });
    const client = createControlPlaneClient({ baseUrl, fetchImpl });
    const result = await client.cancelTask('task-1');
    expect(result.state).toBe('cancelled');
  });

  it('wraps a network failure in a ControlPlaneApiError', async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new TypeError('socket closed');
    };
    const client = createControlPlaneClient({ baseUrl, fetchImpl });
    await expect(client.health()).rejects.toMatchObject({ code: 'network_error' });
  });

  it('reports invalid_json when the success body is not parseable', async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response('not json', { status: 200, headers: { 'content-type': 'application/json' } });
    const client = createControlPlaneClient({ baseUrl, fetchImpl });
    await expect(client.health()).rejects.toMatchObject({ code: 'invalid_json' });
  });

  it('falls back to a generic error when the body is not a structured Error response', async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response('plain text', {
        status: 500,
        headers: { 'content-type': 'text/plain' },
      });
    const client = createControlPlaneClient({ baseUrl, fetchImpl });
    await expect(client.health()).rejects.toMatchObject({ code: 'server_error' });
  });

  it('treats /  prefixed paths in the configured baseUrl gracefully', async () => {
    const fetchImpl: typeof fetch = async (input) => {
      expect(String(input)).toBe('http://control-plane.test/healthz');
      return fixedJsonResponse({ ok: true });
    };
    const client = createControlPlaneClient({ baseUrl: 'http://control-plane.test/', fetchImpl });
    const health = await client.health();
    expect(health.ok).toBe(true);
  });

  it('aborts long-running requests with a network_error', async () => {
    const fetchImpl: typeof fetch = (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
    const client = createControlPlaneClient({ baseUrl, fetchImpl, timeoutMs: 5 });
    await expect(client.health()).rejects.toMatchObject({ code: 'network_error' });
  });
});
