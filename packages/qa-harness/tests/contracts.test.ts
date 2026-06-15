/**
 * Tests for ConnectorContractSuite and FakeConnectorHarness.
 */

import { describe, expect, it } from 'vitest';
import { ConnectorContractSuite, FakeConnectorHarness, defineCheck, CONTRACT_CHECK_NAMES } from '../src/contracts/index.js';

const suite = new ConnectorContractSuite();

describe('ConnectorContractSuite', () => {
  it('lists the eight default checks in stable order', () => {
    const list = suite.list();
    expect(list.map((c) => c.name)).toEqual(CONTRACT_CHECK_NAMES);
    expect(list.length).toBe(8);
  });

  it('passes all eight checks against the FakeConnectorHarness', async () => {
    const harness = new FakeConnectorHarness();
    const result = await suite.run({ connectorId: 'fake-1', harness });
    expect(result.total).toBe(8);
    expect(result.passed).toBe(8);
    expect(result.failed).toBe(0);
    expect(result.checks.every((c) => c.ok)).toBe(true);
  });

  it('reports a failure when the harness returns 401 unexpectedly', async () => {
    const harness = new FakeConnectorHarness();
    // Force every call to 401 — auth-round-trip will fail.
    const origInvoke = harness.invoke.bind(harness);
    let calls = 0;
    harness.invoke = (async (a) => {
      calls++;
      if (calls === 1) return { ok: false, idempotencyKey: a.idempotencyKey, error: { code: 'HTTP_401', message: 'expired', status: 401 } };
      return origInvoke(a);
    }) as typeof harness.invoke;
    const result = await suite.run({ connectorId: 'fake-401', harness });
    expect(result.failed).toBeGreaterThan(0);
    const failedCheck = result.checks.find((c) => c.name === 'auth-round-trip');
    expect(failedCheck?.ok).toBe(false);
    expect(failedCheck?.error?.message).toMatch(/401|auth/i);
  });

  it('runs an extension check via defineCheck', async () => {
    const harness = new FakeConnectorHarness();
    const extra = defineCheck('health-check', 'latency must be < 100ms', async (ctx) => {
      const h = await ctx.harness.health();
      if (h.latencyMs >= 100) throw new Error('latency too high');
    });
    const result = await suite.run({ connectorId: 'fake-extra', harness }, { [extra.name]: extra.fn });
    expect(result.passed).toBe(8);
  });

  it('health-check fails when the harness reports unhealthy', async () => {
    const harness = new FakeConnectorHarness();
    harness.health = async () => ({ ok: false, latencyMs: 1, error: 'downstream unavailable' });
    const result = await suite.run({ connectorId: 'fake-unhealthy', harness });
    const c = result.checks.find((x) => x.name === 'health-check');
    expect(c?.ok).toBe(false);
    expect(c?.error?.message).toMatch(/downstream unavailable/);
  });

  it('health-check fails when the harness reports negative latency', async () => {
    const harness = new FakeConnectorHarness();
    harness.health = async () => ({ ok: true, latencyMs: -1 });
    const result = await suite.run({ connectorId: 'fake-negative-latency', harness });
    const c = result.checks.find((x) => x.name === 'health-check');
    expect(c?.ok).toBe(false);
    expect(c?.error?.message).toMatch(/negative latency/);
  });

  it('rejects unknown check names in defineCheck', () => {
    expect(() => defineCheck('not-a-real-check' as unknown as 'health-check', 'x', () => {})).toThrow();
  });

  it('aborts cleanly when ctx.abort is invoked', async () => {
    const harness = new FakeConnectorHarness();
    let aborted = false;
    const result = await suite.run(
      { connectorId: 'fake-abort', harness },
      {
        'auth-round-trip': (ctx) => { aborted = true; ctx.abort('testing'); },
      },
    );
    expect(aborted).toBe(true);
    expect(result.failed).toBeGreaterThan(0);
    const abortedCheck = result.checks.find((c) => c.name === 'auth-round-trip');
    expect(abortedCheck?.ok).toBe(false);
  });

  it('reports a failure for an extension check that throws', async () => {
    const harness = new FakeConnectorHarness();
    const extra = defineCheck('health-check', 'extension fails', async () => {
      throw new Error('extension-check-boom');
    });
    const result = await suite.run({ connectorId: 'fake-extra-fail', harness }, { [extra.name]: extra.fn });
    const failedCheck = result.checks.find((c) => c.name === 'health-check');
    expect(failedCheck?.ok).toBe(false);
    expect(failedCheck?.error?.message).toMatch(/extension-check-boom/);
  });

  it('http-410 check fails when the harness returns a non-410 error', async () => {
    const harness = new FakeConnectorHarness();
    // Override invoke so the http-410 check's expected 410 status
    // is replaced by a 500, exercising the "got X" error path.
    const origInvoke = harness.invoke.bind(harness);
    harness.invoke = (async (a) => {
      if (typeof a.idempotencyKey === 'string' && a.idempotencyKey.startsWith('contract-410-')) {
        return { ok: false, idempotencyKey: a.idempotencyKey, error: { code: 'HTTP_500', message: 'oops', status: 500 } };
      }
      return origInvoke(a);
    }) as typeof harness.invoke;
    const result = await suite.run({ connectorId: 'fake-410-mismatch', harness });
    const c = result.checks.find((x) => x.name === 'http-410');
    expect(c?.ok).toBe(false);
    expect(c?.error?.message).toMatch(/expected status 410, got 500/);
  });

  it('aborts subsequent checks after ctx.abort fires mid-run', async () => {
    const harness = new FakeConnectorHarness();
    const result = await suite.run(
      { connectorId: 'fake-abort-mid', harness },
      {
        // Abort from the SECOND check so the first passes and the
        // rest of the suite is marked failed via the aborted branch.
        'pagination': (ctx) => { ctx.abort('mid-run-abort'); },
      },
    );
    expect(result.failed).toBeGreaterThan(1);
    const afterAbort = result.checks.find((c) => c.name === 'idempotency');
    expect(afterAbort?.ok).toBe(false);
    expect(afterAbort?.error?.name).toBe('SuiteAborted');
  });

  it('http-429 check fails when the harness returns a non-429 error', async () => {
    const harness = new FakeConnectorHarness();
    const origInvoke = harness.invoke.bind(harness);
    harness.invoke = (async (a) => {
      if (typeof a.idempotencyKey === 'string' && a.idempotencyKey.startsWith('contract-429-')) {
        return { ok: false, idempotencyKey: a.idempotencyKey, error: { code: 'HTTP_500', message: 'oops', status: 500 } };
      }
      return origInvoke(a);
    }) as typeof harness.invoke;
    const result = await suite.run({ connectorId: 'fake-429-mismatch', harness });
    const c = result.checks.find((x) => x.name === 'http-429');
    expect(c?.ok).toBe(false);
    expect(c?.error?.message).toMatch(/expected status 429, got 500/);
  });

  it('http-429 check fails when retryAfterMs is missing', async () => {
    const harness = new FakeConnectorHarness();
    const origInvoke = harness.invoke.bind(harness);
    harness.invoke = (async (a) => {
      if (typeof a.idempotencyKey === 'string' && a.idempotencyKey.startsWith('contract-429-')) {
        return { ok: false, idempotencyKey: a.idempotencyKey, error: { code: 'HTTP_429', message: 'slow down', status: 429 } };
      }
      return origInvoke(a);
    }) as typeof harness.invoke;
    const result = await suite.run({ connectorId: 'fake-429-no-retry', harness });
    const c = result.checks.find((x) => x.name === 'http-429');
    expect(c?.ok).toBe(false);
    expect(c?.error?.message).toMatch(/retryAfterMs/);
  });

  it('http-401 check fails when the harness returns a non-401 error', async () => {
    const harness = new FakeConnectorHarness();
    const origInvoke = harness.invoke.bind(harness);
    harness.invoke = (async (a) => {
      if (typeof a.idempotencyKey === 'string' && a.idempotencyKey.startsWith('contract-401-')) {
        return { ok: false, idempotencyKey: a.idempotencyKey, error: { code: 'HTTP_500', message: 'oops', status: 500 } };
      }
      return origInvoke(a);
    }) as typeof harness.invoke;
    const result = await suite.run({ connectorId: 'fake-401-mismatch', harness });
    const c = result.checks.find((x) => x.name === 'http-401');
    expect(c?.ok).toBe(false);
    expect(c?.error?.message).toMatch(/expected status 401|expected 401/);
  });

  it('webhook-hmac check fails when tampered body is accepted', async () => {
    const harness = new FakeConnectorHarness();
    // Force verifyWebhookSignature to always return true, simulating
    // a broken HMAC implementation. The check should then fail
    // with the "tampered body accepted" message.
    harness.verifyWebhookSignature = () => true;
    const result = await suite.run({ connectorId: 'fake-tamper-ok', harness });
    const c = result.checks.find((x) => x.name === 'webhook-hmac');
    expect(c?.ok).toBe(false);
    expect(c?.error?.message).toMatch(/tampered|wrong-key|HMAC/);
  });

  it('webhook-hmac check fails when valid signature is rejected', async () => {
    const harness = new FakeConnectorHarness();
    // Force verifyWebhookSignature to always return false, simulating
    // a broken HMAC that rejects everything.
    harness.verifyWebhookSignature = () => false;
    const result = await suite.run({ connectorId: 'fake-reject-valid', harness });
    const c = result.checks.find((x) => x.name === 'webhook-hmac');
    expect(c?.ok).toBe(false);
    expect(c?.error?.message).toMatch(/valid signature rejected|HMAC/);
  });

  it('webhook-hmac check fails when wrong-key signature is accepted but tampered is rejected', async () => {
    const harness = new FakeConnectorHarness();
    let call = 0;
    const origVerify = harness.verifyWebhookSignature.bind(harness);
    harness.verifyWebhookSignature = (rawBody, signature) => {
      call += 1;
      // 1st call: original (must return true or we hit "valid rejected")
      if (call === 1) return true;
      // 2nd call: tampered body (must return false to avoid the first throw)
      if (call === 2) return false;
      // 3rd call: wrong-key signature (return true to trip the wrong-key branch)
      if (call === 3) return true;
      return origVerify(rawBody, signature);
    };
    const result = await suite.run({ connectorId: 'fake-wrongkey-ok', harness });
    const c = result.checks.find((x) => x.name === 'webhook-hmac');
    expect(c?.ok).toBe(false);
    expect(c?.error?.message).toMatch(/wrong-key|HMAC/);
  });

  it('idempotency check fails when replay returns different data', async () => {
    const harness = new FakeConnectorHarness();
    const calls: number[] = [];
    const origInvoke = harness.invoke.bind(harness);
    harness.invoke = (async (a) => {
      const r = await origInvoke(a);
      if (typeof a.idempotencyKey === 'string' && a.idempotencyKey.startsWith('contract-idem-')) {
        calls.push(r.data as number);
        // Mutate the second response to differ from the first.
        if (calls.length === 2) {
          return { ...r, data: { different: true } as unknown as typeof r.data };
        }
      }
      return r;
    }) as typeof harness.invoke;
    const result = await suite.run({ connectorId: 'fake-idem-mismatch', harness });
    const c = result.checks.find((x) => x.name === 'idempotency');
    expect(c?.ok).toBe(false);
    expect(c?.error?.message).toMatch(/replay returned different body|idempotency violated/);
  });
});

describe('FakeConnectorHarness', () => {
  it('exposes a deterministic HMAC signing contract', () => {
    const h = new FakeConnectorHarness({ webhookSecret: 'a'.repeat(64) });
    const { rawBody, signature } = h.buildSignedWebhook({ event: 'x' });
    expect(h.verifyWebhookSignature(rawBody, signature)).toBe(true);
    expect(h.verifyWebhookSignature(rawBody, signature.replace(/^.{7}/, 'sha000='))).toBe(false);
  });

  it('replays idempotency keys with the same body', async () => {
    const h = new FakeConnectorHarness();
    const creds = await h.obtainCredentials();
    const r1 = await h.invoke({
      auth: { token: creds.token },
      capability: { type: 'echo', operation: 'echo' },
      args: { hi: 1 },
      idempotencyKey: 'k-1',
    });
    const r2 = await h.invoke({
      auth: { token: creds.token },
      capability: { type: 'echo', operation: 'echo' },
      args: { hi: 999 },
      idempotencyKey: 'k-1',
    });
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(JSON.stringify(r1.data)).toBe(JSON.stringify(r2.data));
  });

  it('injects 429 with retryAfterMs', async () => {
    const h = new FakeConnectorHarness();
    h.injectNextStatus(429, { retryAfterMs: 1234 });
    const r = await h.invoke({
      auth: { token: 'x' },
      capability: { type: 'noop', operation: 'noop' },
      args: {},
      idempotencyKey: 'k-2',
    });
    expect(r.ok).toBe(false);
    expect(r.error?.status).toBe(429);
    expect(r.error?.retryAfterMs).toBe(1234);
  });

  it('paginates with limit and nextCursor', async () => {
    const h = new FakeConnectorHarness({ pageSize: 5 });
    const creds = await h.obtainCredentials();
    const p1 = await h.list({ auth: { token: creds.token }, limit: 5 });
    expect(p1.items.length).toBe(5);
    expect(p1.nextCursor).toBe('5');
    const p2 = await h.list({ auth: { token: creds.token }, limit: 5, cursor: '5' });
    expect(p2.items.length).toBe(5);
    expect(p2.nextCursor).toBe('10');
    const p3 = await h.list({ auth: { token: creds.token }, limit: 5, cursor: '10' });
    expect(p3.items.length).toBe(2);
    expect(p3.nextCursor).toBeUndefined();
  });
});
