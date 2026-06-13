/**
 * Types for the parameterised connector contract suite.
 *
 * The suite is a *vitest-compatible* test runner. It runs eight named
 * checks against a `Connector` and reports per-check results, so a CI
 * gate can fail the build on the first regression. The checks are:
 *
 *   1. auth-round-trip      — credentials obtained via the auth helper
 *                             are accepted by `invoke()`.
 *   2. pagination           — `invoke({ op: 'list' })` returns a
 *                             `nextCursor` and respects `limit`.
 *   3. idempotency          — replaying the same `idempotencyKey` does
 *                             not double-execute and returns the same
 *                             response body.
 *   4. webhook-hmac         — `verifyWebhookSignature(rawBody, sig)`
 *                             accepts a valid signature and rejects a
 *                             tampered one.
 *   5. http-401             — expired/invalid auth yields 401-shaped
 *                             error and does NOT silently retry.
 *   6. http-429             — rate-limit yields 429-shaped error and
 *                             surfaces `retryAfter` if the API provides it.
 *   7. http-410             — permanently-gone resource yields 410.
 *   8. health-check         — `health()` returns ok with a latency
 *                             measurement.
 *
 * Concrete connectors must provide a `ConnectorHarness` that maps
 * these checks onto their transport. FAG-5 will land concrete
 * connectors and call into this suite.
 */

import type { Connector } from '@fagaos/connectors';

export interface ContractSuiteOptions {
  /** Human-readable connector id, used in result labels. */
  connectorId: string;
  /**
   * Concrete harness that maps each contract check onto a real call.
   * Suites ship with `FakeConnectorHarness` for offline CI.
   */
  harness: ConnectorHarness;
  /**
   * Cap on per-check wall time, in ms. Default: 2_000.
   * Used only as a soft budget — the harness may exceed it for slow
   * providers; results are still reported.
   */
  perCheckTimeoutMs?: number;
}

/**
 * A pluggable adapter from contract checks to a real connector transport.
 *
 * Each method corresponds to one of the eight contract checks. The
 * default test suite provides a `FakeConnectorHarness` that returns
 * canned responses; production connectors register their own.
 */
export interface ConnectorHarness {
  /**
   * Issue credentials using the connector's auth flow. The returned
   * token is fed back to `invoke()` in the auth-round-trip check.
   */
  obtainCredentials(): Promise<{ token: string; expiresAt: number }>;
  /**
   * Call `invoke()` on the connector with the given auth and args.
   * The harness may throw — the suite maps errors to
   * `ContractCheckResult` rows.
   */
  invoke<T = unknown>(args: {
    auth: { token: string };
    capability: { type: string; operation: string };
    args: Record<string, unknown>;
    idempotencyKey: string;
  }): Promise<{ ok: boolean; data?: T; error?: { code: string; message: string; retryAfterMs?: number; status?: number }; idempotencyKey: string }>;
  /**
   * Verify a webhook signature. The harness is responsible for
   * knowing the secret and the algorithm.
   */
  verifyWebhookSignature(rawBody: string, signature: string): boolean;
  /**
   * Build a valid webhook payload + signature for use in the
   * webhook-hmac check. The signature MUST verify under
   * `verifyWebhookSignature`.
   */
  buildSignedWebhook(payload: Record<string, unknown>): { rawBody: string; signature: string };
  /**
   * Force a 401 on the next call. Used by the http-401 check.
   */
  injectNextStatus(status: 401 | 410 | 429, opts?: { retryAfterMs?: number }): void;
  /** Run a health check; return latency in ms. */
  health(): Promise<{ ok: boolean; latencyMs: number; error?: string }>;
  /**
   * List endpoint, used by the pagination check. Should respect
   * `args.limit` and return `nextCursor` if there are more pages.
   */
  list<T = unknown>(args: { auth: { token: string }; limit: number; cursor?: string }): Promise<{ items: T[]; nextCursor?: string }>;
}

export interface ContractCheck {
  /** Stable name; the suite asserts `name` is unique. */
  name: ContractCheckName;
  /** Short human description for reports. */
  description: string;
}

export type ContractCheckName =
  | 'auth-round-trip'
  | 'pagination'
  | 'idempotency'
  | 'webhook-hmac'
  | 'http-401'
  | 'http-429'
  | 'http-410'
  | 'health-check';

export interface ContractCheckResult {
  name: ContractCheckName;
  ok: boolean;
  durationMs: number;
  /** Free-form details for the report. */
  detail?: string;
  /** Populated only when `ok` is false. */
  error?: { name: string; message: string };
}

export interface ContractSuiteResult {
  connectorId: string;
  passed: number;
  failed: number;
  total: number;
  checks: ContractCheckResult[];
  durationMs: number;
}

export interface ContractTestContext {
  /** Read-only handle to the harness. */
  harness: ConnectorHarness;
  /** Connector id (mirrors options). */
  connectorId: string;
  /** Stop the suite early; subsequent checks are reported as `ok: false, error: 'aborted'`. */
  abort(reason: string): never;
}

export type CheckFn = (ctx: ContractTestContext) => Promise<void> | void;

export const CONTRACT_CHECK_NAMES: readonly ContractCheckName[] = [
  'auth-round-trip',
  'pagination',
  'idempotency',
  'webhook-hmac',
  'http-401',
  'http-429',
  'http-410',
  'health-check',
] as const;
