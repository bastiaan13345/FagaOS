import { describe, it, expect } from 'vitest';
import {
  createLogger,
  createMetrics,
  createHealthChecker,
  newCorrelationId,
} from '../src/observability.js';

describe('createMetrics', () => {
  it('increments counters', () => {
    const m = createMetrics();
    m.inc('http.ok');
    m.inc('http.ok');
    m.inc('http.error');
    expect(m.snapshot().counters['http.ok']).toBe(2);
    expect(m.snapshot().counters['http.error']).toBe(1);
  });

  it('supports gauge updates', () => {
    const m = createMetrics();
    m.gauge('sessions.active', 5);
    m.gauge('sessions.active', 3);
    expect(m.snapshot().gauges['sessions.active']).toBe(3);
  });

  it('snapshot returns a plain object (not a Map)', () => {
    const m = createMetrics();
    m.inc('x');
    const snap = m.snapshot();
    expect(snap.counters).toBeTypeOf('object');
    expect(snap.counters['x']).toBe(1);
  });
});

describe('createLogger', () => {
  it('child logger inherits base fields', () => {
    const logs: string[] = [];
    // eslint-disable-next-line no-console
    const orig = console.log;
    // eslint-disable-next-line no-console
    console.log = (s: string) => logs.push(s);
    try {
      const logger = createLogger('test-service', { env: 'ci' });
      const child = logger.child({ correlationId: 'abc' });
      child.info('hello');
      const record = JSON.parse(logs[0]!);
      expect(record.service).toBe('test-service');
      expect(record.env).toBe('ci');
      expect(record.correlationId).toBe('abc');
      expect(record.msg).toBe('hello');
    } finally {
      // eslint-disable-next-line no-console
      console.log = orig;
    }
  });
});

describe('createHealthChecker', () => {
  it('returns ok when all checks pass', async () => {
    const hc = createHealthChecker(Date.now() - 1000);
    hc.register('db', async () => true);
    const r = await hc.check();
    expect(r.status).toBe('ok');
    expect(r.checks['db']).toBe('ok');
    expect(r.uptimeMs).toBeGreaterThanOrEqual(1000);
  });

  it('returns degraded when a check fails', async () => {
    const hc = createHealthChecker();
    hc.register('db', async () => false);
    const r = await hc.check();
    expect(r.status).toBe('degraded');
    expect(r.checks['db']).toBe('fail');
  });

  it('marks a check as fail when it throws', async () => {
    const hc = createHealthChecker();
    hc.register('service', async () => { throw new Error('boom'); });
    const r = await hc.check();
    expect(r.checks['service']).toBe('fail');
  });

  it('returns ok with no checks registered', async () => {
    const hc = createHealthChecker();
    const r = await hc.check();
    expect(r.status).toBe('ok');
  });
});

describe('newCorrelationId', () => {
  it('produces unique UUIDs', () => {
    const a = newCorrelationId();
    const b = newCorrelationId();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f-]{36}$/);
  });
});
