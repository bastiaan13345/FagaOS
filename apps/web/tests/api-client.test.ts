import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ControlPlaneApiError,
  _resetControlPlaneClientForTests,
  createControlPlaneClient,
  getControlPlaneClient,
  getDefaultBaseUrl,
} from '../src/lib/api/client';
import { OkSchema, SessionSchema } from '../src/lib/api/types';

const baseUrl = 'http://control-plane.test';

afterEach(() => {
  _resetControlPlaneClientForTests();
  delete process.env['FAGAOS_CONTROL_PLANE_URL'];
});

describe('control-plane HTTP client', () => {
  it('reads the default base URL from the FAGAOS_CONTROL_PLANE_URL env var', () => {
    process.env['FAGAOS_CONTROL_PLANE_URL'] = 'http://example.test:9000/';
    expect(getDefaultBaseUrl()).toBe('http://example.test:9000');
  });

  it('falls back to http://127.0.0.1:8080 when no env var is set', () => {
    expect(getDefaultBaseUrl()).toBe('http://127.0.0.1:8080');
  });

  it('parses a healthy response', async () => {
    const fetchImpl: typeof fetch = async (input) => {
      expect(String(input)).toBe(`${baseUrl}/healthz`);
      return new Response(JSON.stringify({ ok: true, contract: 'v0.1', service: 'control-plane' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const client = createControlPlaneClient({ baseUrl, fetchImpl });
    const health = await client.health();
    expect(health).toEqual({ ok: true, contract: 'v0.1', service: 'control-plane' });
  });

  it('parses a session create response', async () => {
    const fetchImpl: typeof fetch = async (_input, init) => {
      expect(init?.method).toBe('POST');
      const session = SessionSchema.parse({
        id: 'sess-1',
        agentId: 'agent.echo',
        agentVersion: '0.1.0',
        agentCardHash: '0'.repeat(64),
        state: 'running',
        createdAt: '2026-06-15T12:00:00.000Z',
        updatedAt: '2026-06-15T12:00:00.000Z',
        createdBy: { id: 'user:alice', type: 'user' },
      });
      return new Response(JSON.stringify({ session }), { status: 200 });
    };
    const client = createControlPlaneClient({ baseUrl, fetchImpl });
    const session = await client.createSession({
      agentId: 'agent.echo',
      createdBy: { id: 'user:alice', type: 'user' },
    });
    expect(session.id).toBe('sess-1');
  });

  it('throws ControlPlaneApiError on a 4xx response', async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(JSON.stringify({ error: 'not_found', message: 'session missing' }), { status: 404 });
    const client = createControlPlaneClient({ baseUrl, fetchImpl });
    await expect(client.getSession('missing')).rejects.toBeInstanceOf(ControlPlaneApiError);
    await expect(client.getSession('missing')).rejects.toMatchObject({
      code: 'not_found',
      status: 404,
    });
  });

  it('throws a schema_mismatch error when the body does not validate', async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(JSON.stringify({ status: 'wrong-shape' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    const client = createControlPlaneClient({ baseUrl, fetchImpl });
    await expect(client.health()).rejects.toMatchObject({ code: 'schema_mismatch' });
  });

  it('parses ok responses for void endpoints', async () => {
    const fetchImpl: typeof fetch = async (input) => {
      expect(String(input)).toBe(`${baseUrl}/sessions/abc`);
      return new Response(JSON.stringify(OkSchema.parse({ ok: true })), { status: 200 });
    };
    const client = createControlPlaneClient({ baseUrl, fetchImpl });
    await expect(client.deleteSession('abc')).resolves.toBeUndefined();
  });

  it('returns null when the task claim endpoint reports no runnable task', async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(JSON.stringify({ claim: null }), { status: 200 });
    const client = createControlPlaneClient({ baseUrl, fetchImpl });
    const task = await client.claimTask({ workerId: 'w-1', leaseMs: 1000 });
    expect(task).toBeNull();
  });
});

describe('getControlPlaneClient', () => {
  beforeEach(() => {
    process.env['FAGAOS_CONTROL_PLANE_URL'] = baseUrl;
  });

  it('memoises the client singleton', () => {
    const a = getControlPlaneClient();
    const b = getControlPlaneClient();
    expect(a).toBe(b);
  });
});
