# FagaOS — Production policy, secrets, and capability model

> Source of truth for the policy, secrets, and capability surface
> shipped in FAG-24. The control plane, connector gateway, and
> desktop-bridge all consult the components described here.

## Components

| Component | Lives in | Responsibility |
|---|---|---|
| `PolicyEngine` (`InMemoryCedarLikePolicyEngine`) | `packages/policy/src/engine.ts` | Answers "may agent X do action Y to resource Z?" against the current published rule set. Default-deny. DENY overrides ALLOW. |
| `SecretStore` (`InMemorySecretStore`, `FileBackedSecretStore`) | `packages/policy/src/secret-store.ts` | Workspace-bound secret store with explicit key rotation. Holds capability-signing keys, audit-checkpoint keys, and provider credentials. |
| `CapabilityIssuer` | `packages/policy/src/issuer.ts` | Mints short-lived, signed capability tokens. Signs with the current active capability-signing key. |
| `CapabilityVerifier` | `packages/policy/src/verifier.ts` | Verifies a token's signature, expiry, key id, and policy decision. Returns a typed `VerifyResult`. |
| `PolicyDecisionStore` (`InMemoryPolicyDecisionStore`) | `packages/policy/src/policy-store.ts` | Durable boundary for the rule set and review trail. The in-memory implementation is the local-dev default. |
| `PolicyAdministrator` | `packages/policy/src/governance.ts` | `draft → submitForReview → review → publish` workflow with an `onChange` hook for audit emission. |

The `createInMemoryPolicyStack({ workspaceId, ... })` factory in
`packages/policy/src/index.ts` wires every component into a
consistent stack. Production can swap the in-memory engine or store
for a backend adapter without changing the rest of the system.

## Capability token shape

```jsonc
{
  "body": {
    "subject": "agent:worker-1",
    "capabilities": [
      {
        "namespace": "connector",
        "action": "mail.send",
        "resourceType": "connector.account",
        "resourceId": "acct_abc"
      }
    ],
    "issuedAt": "2026-06-30T12:00:00.000Z",
    "expiresAt": "2026-06-30T12:05:00.000Z",
    "workspaceId": "wsp_1",
    "keyId": "k1",
    "algorithm": "hmac-sha256-v1"
  },
  "signature": "3f7a...64hex"
}
```

- `signature` is HMAC-SHA-256 over the canonical JSON of `body`,
  using the secret bytes of the key with `keyId === body.keyId`.
- Canonicalisation: object keys are sorted recursively, arrays
  preserve order, `Buffer`s render as hex. See
  `packages/policy/src/canonical.ts`.
- The verifier rejects the token if the key id is unknown, the
  signature does not match, the token is outside its
  `[notBefore, expiresAt]` window, the key is retired past the
  grace window, the token's workspace does not match the
  verifier's workspace, or the policy engine denies the request.

## Policy language

A rule:

```jsonc
{
  "id": "allow-mail-send-for-worker-agents",
  "effect": "ALLOW",
  "principal": { "type": "prefix", "prefix": "agent:worker:" },
  "action": { "type": "exact", "namespace": "connector", "name": "mail.send" },
  "resource": { "type": "type", "resourceType": "connector.account" },
  "condition": {
    "op": "lte",
    "path": "amount",
    "value": 100
  }
}
```

Supported matchers (Phase 2):

- **principal**: `id`, `prefix`, `role` (matched against
  `context.roles[]`), `any`
- **action**: `exact` (namespace + name), `namespace` (any name in
  the namespace), `any`
- **resource**: `exact` (type + id), `type` (any id of the type),
  `any`
- **condition**: tree of `all` / `any` / `not` over leaves
  - `eq`, `neq` against string | number | boolean | null
  - `lt`, `lte`, `gt`, `gte` against number
  - `in` against `string[] | number[]`
  - `startsWith` against string
  - `exists` against any value (including null)

Evaluation order: a DENY rule that matches always wins. The first
matching DENY rule's `id` is the `policyId` recorded in the audit
log. If no DENY matches, the first matching ALLOW rule's `id` is
the `policyId`. If no rule matches, the decision is `{ allow: false,
reason: 'no_matching_allow' }`.

## Governance workflow

```
draft → submitForReview → review → approve → publish
                                ↘ reject / request_changes → draft
```

- `draft({ rules, createdBy, changeNote? })` — create a new
  version in `draft` state. The version number is monotonic per
  workspace.
- `updateDraft(versionId, { rules?, changeNote? })` — patch a
  draft. Rejected from any non-draft state.
- `submitForReview(versionId)` — move a draft to `in_review`. The
  draft must have at least one rule.
- `review(versionId, { reviewer, decision, reason? })` — record a
  reviewer's decision. `approve` transitions to `approved`. `reject`
  and `request_changes` transition back to `draft`.
- `publish(versionId, publishedBy)` — promote an approved version
  to live. The previously published version is moved to
  `superseded`.
- `retire(versionId)` — manually retire a published version.

Every transition emits a `GovernanceEvent` to the optional
`onChange` hook. The control plane is expected to wire this hook
to the audit log so every state change is auditable.

## Connector gateway enforcement

`ConnectorGateway` accepts an optional `capabilityVerifier` and
`workspaceId` in its options. When supplied, every dispatch:

1. Runs the existing structural `tokenAuthorizes` pre-check.
2. Runs the supplied `CapabilityVerifier` against a synthesised
   `PolicyRequest { actor, action: { namespace: 'connector', name:
   operation }, resource: { type: 'connector.account', id:
   account.id } }`.
3. Rejects with `ConnectorError('forbidden', '...')` on any
   verifier denial.

The token to verify is the `policyToken` field on each gateway
input (e.g. `MailListInput.policyToken`). A missing `policyToken`
when the verifier is configured is itself a denial.

## Desktop-bridge enforcement

`LocalDesktopBridge` accepts a `capabilityVerifier` callback. The
Phase 2 `createPolicyCapabilityVerifier` adapts the policy
package's verifier to that callback shape. The bridge threads a
`token` field on `BridgeOperationOptions` and `CreateSessionInput`
through `requireCapability` so every public method is covered.

The desktop-bridge policy namespace is `desktop`; the resource
type is `desktop.session` and the resource id is the session id.
The policy engine sees a fully-resolved `PolicyRequest` and applies
the same DENY-overrides-ALLOW semantics as for connector calls.

## Production storage

### In-memory (local dev)

`createInMemoryPolicyStack` produces a stack backed by the
in-memory engine and store. The stack is process-local; restarts
lose every rule and every key. Suitable for unit tests and
ephemeral runtimes only.

### File-backed (single-process)

`FileBackedSecretStore` writes the secret material to a JSON file
with mode `0o600` (owner-only) using atomic-rename semantics. The
file lives outside the working tree, e.g.
`/etc/fagaos/wsp_1/secrets.json`. The on-disk format is:

```json
{
  "version": 1,
  "workspaceId": "wsp_1",
  "graceWindowMs": 3600000,
  "keys": [
    {
      "keyId": "k1",
      "purpose": "capability-signing",
      "secretHex": "...",
      "createdAt": "...",
      "activatedAt": "...",
      "retiredAt": null,
      "label": "initial"
    }
  ]
}
```

Multi-process deployments (production) need a `SecretStore`
adapter that talks to a vault (HashiCorp Vault, AWS KMS, GCP
Secret Manager). The interface in
`packages/policy/src/types.ts` is the contract; production
replaces `InMemorySecretStore` with the vault adapter.

### Policy store

`InMemoryPolicyDecisionStore` is the local-dev default. Production
needs a `PolicyDecisionStore` adapter that persists versions and
reviews to the durable control-plane database (Postgres, in
Phase 3). The interface accommodates this; the `publish` event
fires `onChange` so the engine can re-install the live version.

## Audit correlation

Every governance event (draft, submit, review, publish, retire)
emits a `GovernanceEvent` to the `onChange` hook. The control
plane is expected to translate this to an audit entry of shape:

```jsonc
{
  "actor": { "id": "<event.actor>", "type": "user" },
  "action": { "name": "policy.<event.type>", "outcome": "<event.decision ?? 'ok'>" },
  "resource": { "type": "policy.version", "id": "<event.versionId>" },
  "payload": { "version": <event.version>, "decision": "<event.decision?>" }
}
```

Every `decide()` and every verifier call records a `policyId` and
`reason`. The audit log is the single source of truth for
"why was this allowed / denied?".

## Threat-model coverage

| Risk | Engine / store / verifier behaviour |
|---|---|
| R1 (prompt injection) | Default-deny at the engine; verifier rejects on scope mismatch |
| R4 (token replay) | Token expiry, key id binding, retire-window cut-off |
| R5 (audit tampering) | HMAC-signed tokens, hash-chained audit log |
| R9 (rogue operator) | Governance workflow requires an explicit `approve` from a second identity |
| R13 (timing in policy engine) | HMAC comparison uses `timingSafeEqual`; engine matchers are constant-time on the rule count |
| R19 (timing on token HMAC) | Same — `timingSafeEqual` |
| R20 (cold-boot) | File-backed store is on encrypted storage; the in-memory store zeros its buffer on `forgetKey` |
