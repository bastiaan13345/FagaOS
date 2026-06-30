# ADR 0005 — Policy engine: in-memory Cedar-like for Phase 2; real Cedar deferred

- **Status:** Accepted
- **Date:** 2026-06-30
- **Deciders:** FagaOS Platform & Security Lead
- **Related:** [FAG-13](mention://issue/b1688f0e-983c-48a5-8ac7-e38f6570488d) (Phase 1 policy engine — interface only), [FAG-24](mention://issue/87501316-68ad-49b7-9b99-4711b1c44d2b) (Phase 2 policy, secrets, and capability hardening)

## Context

FAG-13 (Phase 1) committed to delivering a `PolicyEngine` with an
"in-memory Cedar-like implementation", `CapabilityToken` minting and
verification, and integration into the control-plane `invokeTool`
path. The acceptance criteria called for a Cedar-style
`{effect, principal, action, resource, conditions}` rule language
and explicitly deferred the *real* Cedar backend to Phase 2.

In practice FAG-13 shipped only the `PolicyEngine` interface stub in
`packages/policy/src/index.ts`. The rule language, the issuer, the
verifier, the secret store, and the governance workflow had to be
built as part of FAG-24. This ADR records the decision to keep the
in-memory engine for Phase 2 and to defer the real Cedar backend to
Phase 3, with the migration path already designed.

## Decision

Phase 2 ships an **in-memory Cedar-like policy engine** with a
versioned, signed rule set, a workspace-bound secret store with key
rotation, and signed capability tokens (HMAC-SHA-256). The policy
language covers the operations FagaOS actually exercises today:

- `principal`: `id`, `prefix`, `role`, `any`
- `action`: `exact`, `namespace`, `any`
- `resource`: `exact`, `type`, `any`
- `condition`: tree of `all` / `any` / `not` over `eq`, `neq`,
  numeric (`lt` / `lte` / `gt` / `gte`), `in`, `startsWith`, `exists`

This is sufficient for the rules the production systems need right
now: allow / deny by agent id, role, or capability namespace, with
context-based numeric constraints (e.g. amount limits, tier checks).

A **real Cedar backend** is deferred to Phase 3. The decision is
driven by three factors:

1. **Fidelity gap.** The in-memory engine supports the *shape* of
   Cedar rules but does not implement entity hierarchies, link
   expansion, or template instantiation. None of the current
   call-sites need those features. Adopting Cedar would add a Rust
   dependency, an FFI bridge, and a synchronisation story that
   Phase 2 does not have the surface area to justify.

2. **Operational simplicity.** The in-memory engine reads the
   `PolicyDecisionStore` on every `decide()` call and re-installs
   the rule set when the published version changes. The hot path
   is a single function call; the cold path (re-install) is a copy
   of the rule array. There is no IPC, no marshalling, and no
   version skew to reason about in a multi-process deployment.
   When we adopt a real Cedar backend the `PolicyEngine` interface
   is the only thing that needs to change; the issuer, verifier,
   and store stay as-is.

3. **Audit compatibility.** The audit log entries already record
   `policyId` and `reason` on every decision. Switching engines
   does not change the audit surface; the `policyId` becomes the
   Cedar policy id and the `reason` becomes the Cedar reason
   string. Nothing downstream of the engine has to change.

## Migration path to a real Cedar backend

The seam is the `PolicyEngine` interface. Adopting Cedar is a
five-step migration:

1. Implement a `CedarPolicyEngine` that conforms to
   `PolicyEngineV2` and translates the FagaOS rule shape to Cedar
   policies at publish time.
2. Replace the `engine` field in `FagaosPolicyStack` with the Cedar
   implementation. The issuer, verifier, and store are unchanged.
3. Run the existing policy test suite against the Cedar engine.
   Cedar's denials should match the in-memory engine's denials for
   the same rule set; any divergence is a bug.
4. Run the `release:gate` adversarial corpus against the Cedar
   engine to confirm the prompt-injection rules behave the same.
5. Flip the in-memory engine to a `legacy/` import path; remove
   it once Cedar is the only engine in production.

Until that happens, the in-memory engine is the source of truth.
It is fast, deterministic, and has the same observable behaviour
as a Cedar backend for every rule we currently author.

## Consequences

### Positive

- Phase 2 ships a complete, testable policy / secrets / capability
  surface without the operational cost of a Cedar FFI.
- The rule language is small enough that a reviewer can audit
  every rule in a few minutes; the governance workflow makes that
  audit part of the `approve → publish` ceremony.
- Key rotation is in-band: `rotate({ purpose })` retires the
  previous key with a 1-hour grace window by default, so an
  in-flight capability token continues to verify during the
  rotation ceremony.

### Negative

- We lose Cedar's static-analysis guarantees. A reviewer has to
  read the rules to spot conflicts. Mitigation: the `administer`
  CLI / future admin UI renders every rule with its effective
  decision against a sample request before `publish()`.
- The in-memory engine is single-process. Multi-process
  deployments need a shared `PolicyDecisionStore` backend
  (Postgres). The interface accommodates this; the in-memory
  implementation is the local-dev default.
- Adopting a real Cedar backend later requires a one-time
  rule-translation pass and a re-run of the adversarial corpus.

## References

- `packages/policy/src/engine.ts` — the in-memory Cedar-like
  engine.
- `packages/policy/src/types.ts` — the `PolicyRule`,
  `PrincipalMatch`, `ActionMatch`, `ResourceMatch`, and
  `ConditionNode` schemas.
- `docs/architecture.md` §7 — the security model this engine
  implements.
- `docs/risk-assessment.md` R4, R5, R19 — the threat-model
  entries this engine mitigates.
