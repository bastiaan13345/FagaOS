# FagaOS — Quality Gates and Test Strategy

> Source of truth for QA. Drives the coverage thresholds in
> `vitest.config.ts` and the release-blocking gates in CI.

## Pyramid allocation

| Layer | % of suite | Notes |
|-------|-----------|-------|
| Unit | 49% | permission broker, connector adapters, state store, PII redaction, audit log — TDD on security paths |
| Component | 30% | mock providers, fake IMAP, fake CalDAV |
| Real-service integration | 15% | staging tenants, ≤1% flake budget |
| E2E | 5% | real desktop/browser, real Gmail test account |
| Adversarial | 1% | sandbox-escape + prompt-injection corpus |

## Release-blocking gates

- **Coverage**: ≥90% on critical paths (audit log, capability
  verifier, sandbox boundary), ≥80% overall
- **All connector contract tests green**
- **E2E smoke green**
- **0 open P0 in adversarial corpus**
- **≤1% CI flake over 7 days**
- **p95 task latency ≤2 s local / 5 s connector**
- **PII leak scan clean**
- **SAST/SCA/license clean**
- **WCAG 2.1 AA clean** (UI surfaces)
- **MTTD/MTTR within budgets**

The release manager **cannot ship without a green dashboard** — no
manual overrides.

## Phase 0 gates (FAG-8)

The Phase 0 cut enforces a subset of the above:

- Coverage gate as configured in `vitest.config.ts`:
  - 90% on the audit log primitive (`packages/core/src/audit/**`)
  - 80% line/function/statement, 75% branch overall
  - per-file thresholds so a single under-tested file blocks merge
- Lint clean (`npm run lint`)
- Typecheck clean (`npm run typecheck`)

Other gates (adversarial corpus, real-service, a11y) land in
later phases as their respective packages come online.

## Debug playbook

1. **0–5 min** — ack, open incident channel, kill the affected
   feature flag.
2. **5–20 min** — pull trace ID, structured logs, recorded session,
   connector health.
3. **20–60 min** — reproduce locally or via replay harness; if
   prod-only, use a 100× schedule-perturbation replay; for sandbox
   escapes, run 1000 trials/hour against a hypervisor snapshot.
4. **Fix** — PR with a failing-test-first regression in the same
   diff.
5. **Rollout** — 1% canary 1 h → 10% canary 1 h → 100%, auto-rollback
   on SLO breach.
6. **Rollback** — <60 s to a known-good version; migrations are
   forward+backward compatible for one minor.

## Defect SLAs

- **P0** (security / data loss): 5-min triage, 24 h fix, 48 h
  regression test.
- **P1** (core broken): 15-min triage, 72 h fix.
- **P2 / P3**: standard sprint cadence.
