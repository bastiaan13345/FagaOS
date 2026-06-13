# FagaOS

> A capability-based operating system for AI agents. Sandboxing, audit, and inter-agent comms — built to the security model in `docs/architecture.md`.

This repository is the implementation of **FagaOS Phase 0** (issue
[FAG-8](https://multica.ai/issues/FAG-8)). It lands the monorepo skeleton,
the CI pipeline, and the first security primitive: an append-only,
hash-chained, signed-checkpoint audit log.

## Project goals

FagaOS is an agent operating system, not a single agent. Its goals, in
priority order:

1. **Containment first.** No agent — including the orchestrator — can
   exceed the scope of its capability token. Prompt injection is treated
   as a data, not a command, and high-risk actions require user
   confirmation.
2. **Append-only auditability.** Every authorisation decision, every
   sandbox boundary crossing, every connector call lands in the audit
   log. The log is tamper-evident: any modification breaks the SHA-256
   hash chain and is detected on the next `verify()`.
3. **Sandbox layering.** LLM-generated code runs in WASM. Per-agent
   processes run under seccomp-bpf. Untrusted MCP servers run inside
   gVisor. The desktop/browser plane runs under a separate OS user.
   Four layers, each stopping a class of attack the others don't.
4. **Durable state.** Working memory → SQLite session memory →
   Postgres episodic + vector memory → append-only event log. No
   exotic stores.
5. **Inter-agent comms that are inspectable.** Subject-based addressing
   on a message bus, at-least-once delivery with idempotency keys.

The full rationale, threat model, and roadmap are in
[`docs/architecture.md`](docs/architecture.md) (FAG-6 deliverable) and
[`docs/risk-assessment.md`](docs/risk-assessment.md). The TypeScript /
Node stack choice is recorded as [ADR 001](docs/adr/001-tech-stack.md)
so future contributors can see the trade-offs without having to dig
through PRs.

## Stack choice

**TypeScript / Node 20+.** Documented here per the FAG-8 acceptance
criteria so future contributors understand why:

- The orchestrator and the desktop/browser plane share a runtime
  (Electron / agent-browser / Playwright are all Node). Picking Node for
  the core avoids splitting the security boundary across two language
  runtimes.
- Node's `node:crypto` ships audited primitives (SHA-256, HMAC,
  `timingSafeEqual`) that the audit log needs in v0.
- TypeScript's `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`
  catch a class of bugs that would otherwise leak into security-critical
  code (audit entry construction, capability token verification).
- Vitest gives us v8 coverage and per-file thresholds out of the box,
  which is what the QA strategy needs to enforce ≥90% on critical paths.

Python was the alternative. It is the right choice for some downstream
connectors (e.g. ML tooling) but it would split the agent runtime from
the desktop plane in a way we do not want at Phase 0.

If you have a strong reason to revisit this, open an issue and tag
FAG-6 — the architecture doc explains the constraint.

## Repository layout

This is a Node workspaces monorepo. Each package owns one bounded
context from `docs/architecture.md`.

```
fagaos/
├── packages/
│   ├── core/              @fagaos/core      orchestrator, scheduler, audit log
│   ├── policy/            @fagaos/policy    Policy Engine (Cedar) — interface only in v0
│   ├── runtime/           @fagaos/runtime   sandboxed execution plane (WASM, seccomp, gVisor)
│   ├── connectors/        @fagaos/connectors  Gmail / WhatsApp / Calendar contracts
│   └── desktop-bridge/    @fagaos/desktop-bridge  sandboxed desktop/browser control
├── docs/                  architecture, risk register, QA strategy
├── .github/workflows/     CI (lint, typecheck, tests, coverage gate)
├── package.json           workspaces manifest + scripts
├── tsconfig.json          shared strict TS config
├── vitest.config.ts       test runner + coverage thresholds
└── README.md              you are here
```

The five packages are interface-first in Phase 0. The only one with
real implementation in this drop is `@fagaos/core`, specifically the
audit log primitive. The rest ship their TypeScript contracts so
downstream teams (FAG-4 desktop, FAG-5 connectors, FAG-7 adversarial
tests) can start integrating against stable shapes.

## Local setup

You need Node 20.10 or newer.

```bash
git clone <repo-url> fagaos
cd fagaos
npm install
```

### Run the tests

```bash
npm test                # one-shot
npm run test:watch      # watch mode
npm run test:coverage   # with coverage report
```

### Run the full verify suite (what CI runs)

```bash
npm run verify
```

This runs lint, typecheck, and the test suite with the coverage gate
enforced. The gate is:

- ≥ 90% line coverage on `packages/core/src/audit/**` (the critical
  path — see the QA strategy)
- ≥ 80% line, function, statement coverage overall
- ≥ 75% branch coverage overall

If you add code that drops coverage, the test run fails. This is
intentional: the QA strategy treats the audit log as a critical path
and refuses to merge code that lowers its coverage.

### Lint and typecheck individually

```bash
npm run lint
npm run typecheck
```

### Build

```bash
npm run build
```

Each package compiles to its own `dist/`. There is no bundler step in
v0.

## The audit log primitive

A quick tour of the API. For full details, see
`packages/core/src/audit/types.ts` and the test suite in
`packages/core/tests/audit.test.ts`.

```ts
import {
  InMemoryAuditLog,
  FileBackedAuditLog,
  HmacCheckpointSigner,
} from '@fagaos/core';

const signer = HmacCheckpointSigner.fromPassphrase('v0', process.env.FAGAOS_AUDIT_KEY!);
const log = new InMemoryAuditLog({ signer, checkpointEvery: 100 });

await log.append({
  actor: { id: 'agent-orchestrator', label: 'Orchestrator' },
  action: { name: 'policy.decide', outcome: 'allow' },
  resource: { type: 'connector.gmail', id: 'user@example.com' },
  payload: { capabilityId: 'cap_abc123' },
});

const result = await log.verify();   // throws on tamper
const tail  = await log.query({ since: 1, limit: 50 });
```

`FileBackedAuditLog` is the production path: it persists entries as
JSONL with periodic checkpoint sidecars and reloads them on next open.
A partial trailing line is ignored on load (crash-safe at line
boundaries).

### Hash chain

Every entry's `entryHash` is `SHA-256` over the canonical JSON of
`(seq, timestamp, actor, action, resource, payload?, prevHash)`.
Canonicalisation sorts object keys recursively, so two semantically
identical entries always hash the same. The first entry's `prevHash`
is 64 zero hex characters (the `GENESIS_PREV_HASH` constant). Each
subsequent entry's `prevHash` is the previous entry's `entryHash`.

### Checkpoints

A checkpoint is an HMAC-SHA-256 signature over
`(seq, entryHash, timestamp)` produced by a `CheckpointSigner` that
only the audit component holds the key for. Checkpoints are emitted
every N entries (default 100) and are written to a sidecar file. On
verify, the latest checkpoint's signature must check out — that proves
the chain up to that point was produced by an entity holding the
signing key.

A future version will swap HMAC for asymmetric signing (Ed25519)
without changing the `AuditCheckpoint` shape.

### What "tamper-evident" actually means

If an attacker (or a bug) modifies a stored entry — changes an actor,
drops a payload, rewrites `prevHash` — `verify()` recomputes the chain
from the genesis hash and throws:

- `AuditTamperError` if an entry's recomputed hash does not match its
  declared `entryHash`
- `AuditChainBrokenError` if an entry's `prevHash` does not match the
  previous entry's `entryHash`
- `AuditCheckpointSignatureError` if a checkpoint's signature is
  invalid (the wrong key, or the key was rotated without updating the
  checkpoint)

The in-memory store has no way to be tampered with by API contract
(there is no `update` or `delete` on the public surface). The
file-backed store can be tampered with on disk — and that is exactly
the threat model the chain is designed to detect. The test suite
covers the four scenarios: actor modification, action modification,
payload modification, and a dropped entry.

## Out of scope for Phase 0

Per the FAG-8 issue body and the architecture doc:

- **Connector implementations** (FAG-5). The `@fagaos/connectors`
  package ships the contract, not any concrete Gmail / WhatsApp /
  Calendar code.
- **Desktop/browser runtime** (FAG-4). The `@fagaos/desktop-bridge`
  package ships the contract. The full Layer 4 isolation design lives
  in the FAG-4 deliverable.
- **Policy engine binding.** The `@fagaos/policy` package ships the
  contract. Phase 1 will bind to Cedar.
- **Orchestrator, scheduler, capability broker.** These land in
  Phase 1–2 per the architecture doc's §12 roadmap.

## Contributing

1. **Branch from `main`.** Pick a short, hyphenated slug:
   `git checkout -b feature/audit-log-export`
2. **TDD on the security paths.** The audit log, capability verifier,
   and sandbox boundaries get tests first. Everything else, normal
   red-green-refactor.
3. **Coverage must not drop.** The vitest thresholds are
   release-blocking. If you need to raise the floor, do it in a
   separate PR with a justification.
4. **No secrets in the repo.** Audit signing keys, connector
   credentials, and similar material come from environment variables
   or a key file outside the working tree. See
   `.gitignore` and the FAG-6 architecture doc §9.
5. **Audit everything that crosses a trust boundary.** Every new
   capability mint, every new connector, every new policy decision
   should produce an audit log entry. When in doubt, log it.
6. **Conventional commits.** `feat:`, `fix:`, `refactor:`,
   `test:`, `docs:`, `chore:`. The audit log is sacred — if your
   change touches it, prefix with `security(audit):`.
7. **Open a PR.** CI runs the verify suite. Reviewers check the
   threat model in `docs/risk-assessment.md` against your diff.

## Useful references

- [`docs/architecture.md`](docs/architecture.md) — full system
  design, security model, sandbox layering, inter-agent comms
- [`docs/risk-assessment.md`](docs/risk-assessment.md) — top-15
  risk register with mitigations
- [`docs/qa-strategy.md`](docs/qa-strategy.md) — quality gates and
  test pyramid that drive the coverage thresholds
- FAG-6 (core platform architecture) — completed
- FAG-7 (QA strategy) — completed
- FAG-8 (this phase) — in review

## License

UNLICENSED at v0. The licence will change before any external release.
