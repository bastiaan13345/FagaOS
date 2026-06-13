# Changelog

All notable changes to FagaOS are recorded here. The format is based
on [Keep a Changelog](https://keepachangelog.com/), and this project
adheres to [Semantic Versioning](https://semver.org/) once a public
release is cut.

## [Unreleased]

### Added (FAG-8 — Phase 0)

- Monorepo skeleton (`@fagaos/core`, `@fagaos/policy`,
  `@fagaos/runtime`, `@fagaos/connectors`, `@fagaos/desktop-bridge`)
  with Node 20+ workspaces, strict TypeScript, and ESLint.
- CI workflow (`.github/workflows/ci.yml`): lint, typecheck, unit
  tests with coverage gate.
- Audit log primitive (`@fagaos/core/audit`):
  - `InMemoryAuditLog` and `FileBackedAuditLog` stores.
  - SHA-256 hash-chained entries; canonical-JSON hashing for
    determinism across platforms.
  - HMAC-SHA-256 signed checkpoints at configurable intervals.
  - `verify()` detects three tamper modes with typed errors.
  - Full test suite covering happy path, four tamper scenarios
    (actor, payload, dropped entry, modified action), file
    round-trip, and checkpoint key rotation.
- Architecture, risk register, and QA strategy documents under
  `docs/`.
- README with project goals, stack rationale, layout, local setup,
  and contribution guide.

### Out of scope (deferred)

- Connector implementations (FAG-5 follow-ups).
- Desktop/browser runtime (FAG-4).
- Policy engine binding to Cedar (Phase 1).
- Orchestrator, scheduler, and capability broker (Phase 1–2).
