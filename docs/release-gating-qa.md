# Release-Gating QA

FAG-27 turns the FAG-12 harness into a release gate that can run before every
provider and desktop runtime is production-ready. The gate fails on concrete
release regressions and records missing provider/runtime inputs as explicit
prerequisites.

## CI Entry Point

Run the full gate from the repository root:

```bash
npm run verify
```

`verify` runs lint, typecheck, coverage, and `npm run release:gate`. The release
gate writes `coverage/release-gate-report.json` with:

- adversarial corpus totals and pass rate
- provider contract failures and missing staging prerequisites
- long-session runtime failures and missing runtime prerequisites
- OWASP Agentic-style threat coverage
- dependency audit triage and deferred dev-only decisions
- flaky-test and vulnerability ownership actions

## Severity Policy

Default CI policy:

| Area | Blocking rule |
| --- | --- |
| Adversarial corpus | Any P0 or P1 failure blocks release. Pass rate must be 100%. |
| Provider contracts | Runnable required targets fail on failed checks. Missing FAG-25 staging inputs are prerequisites, not failures. |
| Runtime scenarios | Runnable required targets fail on failed checks. Missing FAG-26 runtime inputs are prerequisites, not failures. |
| Dependencies | High and critical findings marked `fix-now` block release. Deferred dev-tool findings remain report actions. |
| Flaky tests | Unquarantined flaky tests block release readiness. |

Threat-model gaps are reported with owner and required action. They become
blocking when the release owner changes `requiredThreatCoverageStatuses` to
exclude `gap`.

## Provider Prerequisites

FAG-25 should satisfy these inputs before provider contracts become hard gates:

- Gmail: staging OAuth client, deployed webhook endpoint, seeded tenant history.
- Google Calendar: staging OAuth client, sync-token fixture, watch callback URL.
- Telegram: bot token fixture and webhook signing fixture.
- Discord: staging bot and rate-limit fixture.

Until those exist, the JSON report lists them under `prerequisites` and the
gate can still protect the existing corpus, dependency, and runnable runtime
checks.

## Runtime Prerequisites

FAG-26 should satisfy these inputs before desktop/browser scenarios become hard
gates:

- production desktop/browser session lifecycle
- screenshot/input/navigation adapters behind the bridge interface
- per-session profile lifecycle and teardown cleanup
- file ingress/egress containment fixtures

FAG-21 scheduler and control-plane scenarios can run earlier and should stay
blocking when their checks are executable.

## Threat Coverage

The default plan maps current coverage to an OWASP Agentic-style model:

| Threat | Current status | Owner |
| --- | --- | --- |
| Prompt injection and delegated instruction attacks | Covered | QA |
| Sensitive information disclosure | Covered | QA |
| Tool misuse and unauthorized action | Partial | Policy/runtime |
| Memory and long-session state poisoning | Gap | Control plane |
| Dependency and tool supply chain | Partial | Security |

Each gap must carry a concrete `requiredAction`. Do not leave unknown gaps as
plain text in issue comments; add them to the release-gate plan so they show up
in machine-readable readiness output.

## Dependency Audit Workflow

FAG-14 established the baseline remediation path. For every new audit finding,
record:

- package name
- severity
- direct or transitive source if known
- runtime surface: `runtime`, `dev-tooling`, `test-only`, or `unknown`
- decision: `fix-now`, `defer`, or `accept-risk`
- remediation note

High and critical runtime findings should be `fix-now` unless the security owner
explicitly accepts the risk. Dev-tooling findings may be deferred, but the gate
keeps them visible in `actions`.

## Regression Workflow

1. Add or update the failing case in `packages/qa-harness`.
2. Assign an owner in the report-producing plan.
3. Keep P0/P1 failures blocking until fixed.
4. Quarantine only genuinely flaky tests, with owner and last failure.
5. Keep provider/runtime missing inputs as prerequisites until FAG-25/FAG-26
   supply executable staging targets.
