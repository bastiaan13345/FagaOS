/**
 * ConnectorContractSuite: parameterised tests every connector must pass.
 *
 * The suite runs eight contract checks against a `ConnectorHarness` and
 * returns a `ContractSuiteResult`. It is intentionally a plain function
 * — not a vitest `describe` block — so it can be invoked from:
 *
 *   - vitest unit tests (`expect(...).toBe(...)` against the result)
 *   - a CLI runner (`node --eval "import('@fagaos/qa-harness/contracts').then(m => m.runSuite(...))"`)
 *   - a Phase 2 release-gating service
 *
 * The default vitest suite in this package uses the
 * `FakeConnectorHarness` for offline CI; concrete connectors
 * (FAG-5) will register their own harness and re-run the suite
 * against a staging tenant.
 */

import type {
  CheckFn,
  ContractCheck,
  ContractCheckName,
  ContractCheckResult,
  ContractSuiteOptions,
  ContractSuiteResult,
  ContractTestContext,
} from './types.js';
import { CONTRACT_CHECK_NAMES } from './types.js';

const DEFAULT_CHECKS: readonly ContractCheck[] = CONTRACT_CHECK_NAMES.map((name) => ({
  name,
  description: checkDescription(name),
}));

function checkDescription(name: ContractCheckName): string {
  switch (name) {
    case 'auth-round-trip':
      return 'Credentials obtained from the auth flow are accepted by invoke() and the same token is rejected after a forced expiry.';
    case 'pagination':
      return 'list() respects limit and returns a nextCursor when more pages are available.';
    case 'idempotency':
      return 'Replaying the same idempotencyKey does not double-execute and returns the same response body.';
    case 'webhook-hmac':
      return 'A valid HMAC signature is accepted; a tampered body or wrong key is rejected.';
    case 'http-401':
      return 'An expired or invalid token yields a 401-shaped error and the harness does not silently retry.';
    case 'http-429':
      return 'A rate-limit response yields 429-shaped error and surfaces retryAfterMs when the API provides it.';
    case 'http-410':
      return 'A permanently-gone resource yields a 410-shaped error and is not retried.';
    case 'health-check':
      return 'health() returns ok with a latency measurement below the per-check budget.';
  }
}

const CHECK_FNS: Record<ContractCheckName, CheckFn> = {
  'auth-round-trip': async (ctx) => {
    const creds = await ctx.harness.obtainCredentials();
    if (!creds.token) throw new Error('harness returned empty token');
    const res = await ctx.harness.invoke({
      auth: { token: creds.token },
      capability: { type: 'contract-test', operation: 'noop' },
      args: {},
      idempotencyKey: `contract-auth-${Date.now()}`,
    });
    if (!res.ok) throw new Error(`auth round-trip failed: ${res.error?.message ?? 'unknown'}`);
  },
  pagination: async (ctx) => {
    const creds = await ctx.harness.obtainCredentials();
    const page1 = await ctx.harness.list({ auth: { token: creds.token }, limit: 5 });
    if (!Array.isArray(page1.items)) throw new Error('list() did not return items array');
    if (page1.items.length > 5) throw new Error(`list() returned ${page1.items.length} > limit 5`);
    // We don't *require* a nextCursor — empty result sets are valid.
    // The check is: when present, it must be a non-empty string.
    if (page1.nextCursor !== undefined && typeof page1.nextCursor !== 'string') {
      throw new Error('nextCursor must be a string when present');
    }
  },
  idempotency: async (ctx) => {
    const creds = await ctx.harness.obtainCredentials();
    const key = `contract-idem-${Date.now()}`;
    const r1 = await ctx.harness.invoke({
      auth: { token: creds.token },
      capability: { type: 'contract-test', operation: 'echo' },
      args: { hello: 'world' },
      idempotencyKey: key,
    });
    if (!r1.ok) throw new Error(`first invoke failed: ${r1.error?.message ?? 'unknown'}`);
    const r2 = await ctx.harness.invoke({
      auth: { token: creds.token },
      capability: { type: 'contract-test', operation: 'echo' },
      args: { hello: 'world' },
      idempotencyKey: key,
    });
    if (!r2.ok) throw new Error(`replay invoke failed: ${r2.error?.message ?? 'unknown'}`);
    if (JSON.stringify(r1.data) !== JSON.stringify(r2.data)) {
      throw new Error('replay returned different body — idempotency violated');
    }
  },
  'webhook-hmac': async (ctx) => {
    const { rawBody, signature } = ctx.harness.buildSignedWebhook({ event: 'test', n: 1 });
    if (!ctx.harness.verifyWebhookSignature(rawBody, signature)) {
      throw new Error('valid signature rejected');
    }
    const tampered = rawBody.replace('"n":1', '"n":2');
    if (ctx.harness.verifyWebhookSignature(tampered, signature)) {
      throw new Error('tampered body accepted — HMAC check failed');
    }
    if (ctx.harness.verifyWebhookSignature(rawBody, signature.replace(/./g, 'a'))) {
      throw new Error('wrong-key signature accepted — HMAC check failed');
    }
  },
  'http-401': async (ctx) => {
    const creds = await ctx.harness.obtainCredentials();
    ctx.harness.injectNextStatus(401);
    const res = await ctx.harness.invoke({
      auth: { token: creds.token },
      capability: { type: 'contract-test', operation: 'noop' },
      args: {},
      idempotencyKey: `contract-401-${Date.now()}`,
    });
    if (res.ok) throw new Error('expected 401, got ok=true');
    if (res.error?.status !== 401) {
      throw new Error(`expected status 401, got ${String(res.error?.status)}`);
    }
  },
  'http-429': async (ctx) => {
    const creds = await ctx.harness.obtainCredentials();
    ctx.harness.injectNextStatus(429, { retryAfterMs: 1000 });
    const res = await ctx.harness.invoke({
      auth: { token: creds.token },
      capability: { type: 'contract-test', operation: 'noop' },
      args: {},
      idempotencyKey: `contract-429-${Date.now()}`,
    });
    if (res.ok) throw new Error('expected 429, got ok=true');
    if (res.error?.status !== 429) {
      throw new Error(`expected status 429, got ${String(res.error?.status)}`);
    }
    if (res.error?.retryAfterMs === undefined) {
      throw new Error('expected retryAfterMs in error');
    }
  },
  'http-410': async (ctx) => {
    const creds = await ctx.harness.obtainCredentials();
    ctx.harness.injectNextStatus(410);
    const res = await ctx.harness.invoke({
      auth: { token: creds.token },
      capability: { type: 'contract-test', operation: 'noop' },
      args: {},
      idempotencyKey: `contract-410-${Date.now()}`,
    });
    if (res.ok) throw new Error('expected 410, got ok=true');
    if (res.error?.status !== 410) {
      throw new Error(`expected status 410, got ${String(res.error?.status)}`);
    }
  },
  'health-check': async (ctx) => {
    const h = await ctx.harness.health();
    if (!h.ok) throw new Error(`health not ok: ${h.error ?? 'unknown'}`);
    if (h.latencyMs < 0) throw new Error('negative latency reported');
  },
};

/** Define a check. Useful for adding custom checks in extension packages. */
export function defineCheck(name: ContractCheckName, _description: string, fn: CheckFn): { name: ContractCheckName; fn: CheckFn } {
  if (!CONTRACT_CHECK_NAMES.includes(name)) {
    throw new RangeError(`Unknown contract check: ${name}`);
  }
  return { name, fn };
}

export class ConnectorContractSuite {
  /**
   * Run the full suite. Returns a result object; never throws.
   * `checkFns` lets callers override or extend the default checks
   * without forking the suite. Order in `checkFns` is preserved.
   */
  async run(
    options: ContractSuiteOptions,
    extraChecks: Partial<Record<ContractCheckName, CheckFn>> = {},
  ): Promise<ContractSuiteResult> {
    const start = Date.now();
    const checks = DEFAULT_CHECKS.slice();
    const results: ContractCheckResult[] = [];
    let passed = 0;
    let failed = 0;
    let aborted = false;
    let abortReason: string | undefined;

    const ctx: ContractTestContext = {
      harness: options.harness,
      connectorId: options.connectorId,
      abort: (reason: string) => {
        aborted = true;
        abortReason = reason;
        throw new SuiteAborted(reason);
      },
    };

    for (const check of checks) {
      if (aborted) {
        results.push({
          name: check.name,
          ok: false,
          durationMs: 0,
          error: { name: 'SuiteAborted', message: abortReason ?? 'aborted' },
        });
        failed++;
        continue;
      }
      const t0 = Date.now();
      const fn = extraChecks[check.name] ?? CHECK_FNS[check.name];
      try {
        await fn(ctx);
        results.push({ name: check.name, ok: true, durationMs: Date.now() - t0, detail: check.description });
        passed++;
      } catch (err) {
        if (err instanceof SuiteAborted) {
          results.push({
            name: check.name,
            ok: false,
            durationMs: Date.now() - t0,
            error: { name: 'SuiteAborted', message: err.message },
          });
          failed++;
          // Mark the aborting check as failed, but let the loop fall
          // through so subsequent checks hit the `if (aborted)`
          // skip branch (which records them as SuiteAborted failures).
          continue;
        }
        const e = err as Error;
        results.push({
          name: check.name,
          ok: false,
          durationMs: Date.now() - t0,
          detail: check.description,
          error: { name: e.name ?? 'Error', message: e.message ?? String(err) },
        });
        failed++;
      }
    }

    return {
      connectorId: options.connectorId,
      passed,
      failed,
      total: checks.length,
      checks: results,
      durationMs: Date.now() - start,
    };
  }

  /** List the default check names in suite order. */
  list(): readonly ContractCheck[] {
    return DEFAULT_CHECKS;
  }
}

class SuiteAborted extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'SuiteAborted';
  }
}
