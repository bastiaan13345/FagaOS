# ADR 001 — Tech stack: TypeScript / Node 20+

- **Status:** Accepted
- **Date:** 2026-06-13
- **Deciders:** FagaOS Platform & Security Lead
- **Related:** [FAG-6](https://multica.ai/issues/FAG-6) (core architecture), [FAG-7](https://multica.ai/issues/FAG-7) (QA strategy), [FAG-8](https://multica.ai/issues/FAG-8) (Phase 0 implementation)

## Context

FagaOS Phase 0 must land a monorepo skeleton, a CI pipeline, and the
audit log primitive. The choice between **TypeScript / Node 20+** and
**Python 3.12+** is forced at this point because:

1. The orchestrator bus, the desktop/browser plane, and the audit
   signing key all need to come from the same language runtime so the
   security boundary does not have to be defended across two
   ecosystems.
2. Several Phase 0 deliverables (audit log signing, capability token
   verification, sandbox boundary calls) require
   `crypto.timingSafeEqual`-style audited primitives in the standard
   library. We do not want to ship a hand-rolled crypto layer.
3. The QA strategy (FAG-7) requires per-file coverage thresholds and a
   release-blocking coverage gate. The Node ecosystem has a
   well-trodden path for that (vitest + v8 coverage) that produces
   reproducible numbers in CI.
4. Downstream teams (FAG-4 desktop, FAG-5 connectors) have not
   committed to a language yet, but their reference designs
   (agent-browser / Playwright, Electron) all assume Node. Choosing
   Node for the core keeps the integration surface uniform.

## Decision

**FagaOS Phase 0 ships in TypeScript on Node 20+.** Python is not used
in the core; it may be used in connector adapters for tools that
require it (e.g. ML model integrations), and those adapters will live
behind the `@fagaos/connectors` interface contract — they will not
extend the core.

## Consequences

### Positive

- Single language runtime across the orchestrator, the audit log, the
  sandbox, and the desktop/browser plane.
- `node:crypto` ships HMAC-SHA-256, SHA-256, and `timingSafeEqual`
  audited primitives — the audit log primitive lands without
  third-party crypto dependencies.
- Vitest + v8 coverage gives us per-file coverage thresholds that
  fail the run when a file's coverage drops, which is what the FAG-7
  QA strategy needs.
- TypeScript's `exactOptionalPropertyTypes` and
  `noUncheckedIndexedAccess` catch a class of bug (optional-field
  omission, off-by-one array access) that would otherwise leak into
  security-critical code like audit entry construction and
  capability token verification.
- The full Node + TypeScript toolchain is already pinned and tested
  on every major CI provider; no provider-specific build steps.

### Negative

- Python is the right choice for some downstream tools (ML training,
  data analysis). If we ever need to integrate one of those into
  FagaOS, we either ship a Python adapter process or call out to a
  Python sidecar. Both add an inter-process trust boundary.
- Node's type system, while excellent, is still structurally weaker
  than Python's PEP 695 type parameter syntax for some generic
  patterns. We work around this with explicit `interface` declarations
  and `noUncheckedIndexedAccess` (which we have enabled).
- The Node ecosystem has a noisy supply-chain footprint. We mitigate
  with the FAG-7 SCA gate in CI.

## Alternatives considered

### Python 3.12+

- **Pro:** First-class type parameter syntax (PEP 695), excellent
  scientific stack, Mypy / Pyright for type checking.
- **Pro:** `hashlib` and `hmac` ship the same primitives as `node:crypto`.
- **Con:** Would force the desktop/browser plane to either adopt
  Python (Electron does not support it natively) or split the
  runtime across two languages, which we explicitly do not want at
  Phase 0.
- **Con:** Python's standard library does not ship an equivalent of
  `vitest`'s coverage thresholds; `coverage.py` is close but the
  per-file threshold enforcement is awkward in CI.

### Rust + Tokio

- **Pro:** Memory safety, performance, single static binary.
- **Con:** The desktop/browser plane is not Rust. Adoption cost across
  the team is high. The audit log primitive does not need Rust-level
  performance; it needs audited crypto and a clear API.
- **Con:** Phase 0 has a tight schedule; introducing a second build
  system (cargo + npm) is not worth it.

### Go

- **Pro:** Single static binary, simple concurrency, fast builds.
- **Con:** No first-class desktop/browser runtime; the desktop plane
  is still Node.
- **Con:** Type system is fine but not strict enough to catch the
  class of bug we want for the audit log.

## Re-evaluation triggers

We will revisit this decision if any of the following happen:

1. A future connector requires a Python-only library and the
   sidecar boundary becomes a real attack surface.
2. The desktop plane (FAG-4) ends up shipping a Rust component for
   performance, and the boundary between Node and Rust needs
   hardening beyond what an FFI layer can provide.
3. The Node ecosystem produces a security regression we cannot work
   around (e.g. a CVE in `node:crypto` with no upstream fix).

## References

- [FAG-6 architecture](../architecture.md) — full system design
- [FAG-7 QA strategy](../qa-strategy.md) — coverage gates
- [FAG-8 Phase 0 issue](https://multica.ai/issues/FAG-8) — this drop
- [Node 20 release notes](https://nodejs.org/en/blog/release/v20.0.0)
