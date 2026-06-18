/**
 * @fagaos/control-plane/observability
 *
 * Structured logging, in-process metrics counters, and tracing context
 * for the control-plane HTTP API.
 *
 * Design goals:
 *  - Zero external dependencies (no OpenTelemetry SDK, no Prometheus client).
 *    Counters/gauges are plain Maps; a future pass can wire an exporter.
 *  - Structured JSON logs to stdout so a log aggregator (Cloud Logging,
 *    Datadog, etc.) can index fields without a parsing step.
 *  - Every log record carries a correlationId that matches the session/task
 *    audit entry chain, so you can join logs ↔ audit rows.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogRecord {
  ts: string;          // ISO-8601
  level: LogLevel;
  service: string;
  msg: string;
  correlationId?: string;
  sessionId?: string;
  taskId?: string;
  callerId?: string;
  durationMs?: number;
  statusCode?: number;
  [key: string]: unknown;
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

export interface MetricsSnapshot {
  counters: Record<string, number>;
  gauges: Record<string, number>;
}

export interface Metrics {
  inc(name: string, by?: number): void;
  gauge(name: string, value: number): void;
  snapshot(): MetricsSnapshot;
}

/* ─────────────────────────────── Logger ─────────────────────────────── */

export function createLogger(service: string, baseFields: Record<string, unknown> = {}): Logger {
  function emit(level: LogLevel, msg: string, fields: Record<string, unknown> = {}) {
    const record: LogRecord = {
      ts: new Date().toISOString(),
      level,
      service,
      msg,
      ...baseFields,
      ...fields,
    };
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(record));
  }

  return {
    debug: (msg, f) => emit('debug', msg, f),
    info:  (msg, f) => emit('info',  msg, f),
    warn:  (msg, f) => emit('warn',  msg, f),
    error: (msg, f) => emit('error', msg, f),
    child: (fields) => createLogger(service, { ...baseFields, ...fields }),
  };
}

/* ─────────────────────────────── Metrics ────────────────────────────── */

export function createMetrics(): Metrics {
  const counters = new Map<string, number>();
  const gauges   = new Map<string, number>();

  return {
    inc(name, by = 1) {
      counters.set(name, (counters.get(name) ?? 0) + by);
    },
    gauge(name, value) {
      gauges.set(name, value);
    },
    snapshot(): MetricsSnapshot {
      return {
        counters: Object.fromEntries(counters),
        gauges:   Object.fromEntries(gauges),
      };
    },
  };
}

/* ───────────────────────────── Tracing ──────────────────────────────── */

/**
 * Returns a new correlation ID scoped to a request or session.
 * Uses the existing Node crypto randomUUID — same source as the
 * audit log and session IDs so they sort/compare uniformly.
 */
import { randomUUID } from 'node:crypto';

export function newCorrelationId(): string {
  return randomUUID();
}

/* ─────────────────────────── Health/Readiness ───────────────────────── */

export interface HealthStatus {
  status: 'ok' | 'degraded' | 'down';
  checks: Record<string, 'ok' | 'fail'>;
  uptimeMs: number;
}

export interface HealthChecker {
  /** Register a named check — should resolve quickly (< 100 ms). */
  register(name: string, fn: () => Promise<boolean>): void;
  /** Run all checks and return aggregate status. */
  check(): Promise<HealthStatus>;
}

export function createHealthChecker(startedAt: number = Date.now()): HealthChecker {
  const checks = new Map<string, () => Promise<boolean>>();

  return {
    register(name, fn) {
      checks.set(name, fn);
    },
    async check() {
      const results: Record<string, 'ok' | 'fail'> = {};
      for (const [name, fn] of checks) {
        try {
          results[name] = (await fn()) ? 'ok' : 'fail';
        } catch {
          results[name] = 'fail';
        }
      }
      const anyFail = Object.values(results).some(v => v === 'fail');
      return {
        status: anyFail ? 'degraded' : 'ok',
        checks: results,
        uptimeMs: Date.now() - startedAt,
      };
    },
  };
}
