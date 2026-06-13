# Running the Contract Suite Against a New Connector

Every connector shipped in FagaOS must pass the **`ConnectorContractSuite`**
— a parameterised set of eight checks the QA team maintains. This doc
shows how to wire a new connector up so the suite runs in unit tests
locally, in CI on every PR, and (in FAG-5+) against a staging tenant.

## The eight contract checks

| Check             | What it asserts                                                                    |
| ----------------- | ---------------------------------------------------------------------------------- |
| `auth-round-trip` | Credentials obtained from the auth flow are accepted by `invoke()`; same token rejected after forced expiry. |
| `pagination`      | `list()` respects `limit` and returns a `nextCursor` when more pages exist.        |
| `idempotency`     | Replaying the same `idempotencyKey` does not double-execute and returns the same body. |
| `webhook-hmac`    | A valid HMAC signature is accepted; a tampered body or wrong key is rejected.      |
| `http-401`        | An expired or invalid token yields a 401-shaped error and the harness does not silently retry. |
| `http-429`        | A rate-limit response yields a 429-shaped error and surfaces `retryAfterMs`.      |
| `http-410`        | A permanently-gone resource yields a 410-shaped error and is not retried.          |
| `health-check`    | `health()` returns `ok` with a positive latency.                                   |

The full list lives in `src/contracts/types.ts` (`CONTRACT_CHECK_NAMES`).
All eight ship in `@fagaos/qa-harness`. Adding a ninth requires a new
`ContractCheckName` literal and a matching entry in `CHECK_FNS`.

## 1. Implement `ConnectorHarness`

The contract suite is a plain consumer of the `ConnectorHarness` interface
(see `src/contracts/types.ts`). For each connector you ship, write a
`ConnectorHarness` implementation that talks to the real SDK (or to a
sandboxed fakeserver during unit tests).

```ts
import type { ConnectorHarness, ContractTestContext } from '@fagaos/qa-harness';

export class MyConnectorHarness implements ConnectorHarness {
  async obtainCredentials() {
    return { token: await this.mintTestToken(), refreshToken: 'rt-…', expiresAt: Date.now() + 3600_000 };
  }
  async invoke(req) { /* … real SDK call … */ }
  async list(req)  { /* … real SDK list call … */ }
  buildSignedWebhook(payload) { /* … */ }
  verifyWebhookSignature(rawBody, signature) { /* … */ }
  async health() { /* … */ }
  injectNextStatus(status, meta) { /* … for the 401/429/410 checks … */ }
}
```

The methods you implement are the same shape `FakeConnectorHarness`
already provides, so the suite can be exercised offline. The
`@fagaos/qa-harness` package ships `FakeConnectorHarness` as a reference
implementation — copy it and replace each method's body.

### What the harness must support

- **Auth round-trip**: the suite calls `obtainCredentials()` then
  `invoke()` once. The token must be accepted. The suite does **not**
  force-expire the token — that's a manual `injectNextStatus(401)` test
  in `http-401`.
- **Pagination**: `list({ limit })` must return `{ items, nextCursor? }`.
  `nextCursor` is optional; when present it must be a non-empty string.
- **Idempotency**: two `invoke()` calls with the same
  `idempotencyKey` and same `args` must return equal `data` (compared
  with `JSON.stringify`).
- **Webhook HMAC**: `buildSignedWebhook(payload)` returns `{ rawBody,
  signature }`. The suite then asserts the harness accepts the
  signature, rejects a tampered body, and rejects a wrong-key
  signature.
- **Injected statuses**: `injectNextStatus(401|410|429, { retryAfterMs? })`
  makes the *next* `invoke()` return an error with the requested shape.
  Reset the flag after the next call.

## 2. Run the suite in unit tests

```ts
import { describe, it, expect } from 'vitest';
import { ConnectorContractSuite } from '@fagaos/qa-harness';
import { MyConnectorHarness } from './harness';

describe('MyConnector contract', () => {
  it('passes the full suite', async () => {
    const suite = new ConnectorContractSuite();
    const result = await suite.run({
      connectorId: 'my-connector',
      harness: new MyConnectorHarness({ token: process.env.MY_TOKEN! }),
    });
    expect(result.failed).toBe(0);
    if (result.failed > 0) {
      // surface failures for the test log
      for (const c of result.checks.filter((c) => !c.ok)) {
        console.error(`FAIL ${c.name}: ${c.error?.message}`);
      }
    }
  });
});
```

The suite is **never expected to throw** — it returns a
`ContractSuiteResult` with `passed`/`failed` counts. The pattern above
gives a clean vitest failure (non-zero `result.failed`) while still
leaving a per-check log line in CI output.

### Running a single check

```ts
// Override the default impl for `webhook-hmac` only.
const result = await suite.run(
  { connectorId: 'my-connector', harness },
  {
    'webhook-hmac': async (ctx) => {
      // custom assertion: also check the signature header is `sha256=…`
    },
  },
);
```

Use this to add a **stricter** assertion on top of the default check.
The override fully replaces the default; copy the default's body from
`src/contracts/suite.ts` if you want to keep it.

## 3. Aborting mid-suite

The `ContractTestContext` exposes an `abort(reason)` helper. Calling
it from inside a check fails the current check, marks subsequent
checks as `SuiteAborted`, and short-circuits the run:

```ts
const result = await suite.run({ connectorId: 'x', harness }, {
  'auth-round-trip': async (ctx) => {
    const c = await ctx.harness.obtainCredentials();
    if (!c.token.startsWith('expected-prefix-')) {
      ctx.abort('tenant misconfigured: token does not start with expected-prefix-');
    }
  },
});
```

Use `abort` to short-circuit when an environmental prerequisite fails
(e.g. the staging tenant is missing) — every downstream check will
record a `SuiteAborted` failure, which is the right signal for "this
run is not a release gate."

## 4. Run it against a staging tenant

`MyConnectorHarness` is a plain class — for staging, instantiate it
with real credentials and a real base URL:

```ts
const harness = new MyConnectorHarness({
  baseUrl: 'https://api.staging.example.com',
  token: process.env.STAGING_TOKEN!,
});
const result = await suite.run({ connectorId: 'my-connector', harness });
```

Wire this into a release-gating job (FAG-5 work). The suite's output is
the same `ContractSuiteResult` shape regardless of whether the harness
talks to a real provider or to an in-memory fake.

## 5. CI integration

`npm run verify` in the monorepo root runs:

```
lint && typecheck && test:coverage
```

The contract suite is covered by `packages/qa-harness/tests/contracts.test.ts`
and runs as part of the `vitest run --coverage` step. Per-file coverage
gates for `qa-harness` are 80% lines / 75% branches. When you add a new
connector, add a test file under `packages/<your-package>/tests/` that
follows the pattern in §2.

## 6. Acceptance criteria for "ready for review"

A connector is "ready for review" when:

1. `ConnectorHarness` implementation exists and is exported from the
   connector's package.
2. `tests/contract.test.ts` runs the full suite and `expect(result.failed).toBe(0)`.
3. Coverage for the new file is ≥80% lines.
4. `npm run verify` is green on the PR branch.
