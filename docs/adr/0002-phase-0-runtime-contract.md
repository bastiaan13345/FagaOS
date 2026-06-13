# ADR 0002 — FagaOS Phase 0 runtime contract layer

> Status: **Accepted** (FAG-9, unified into the FAG-8 monorepo in FAG-10)
> Date: 2026-06-13
> Deciders: FagaOS Platform & Security Lead

## Context

FAG-6 delivered the design for the core platform: hierarchical orchestrator, NATS JetStream transport, tiered state, 4-layer sandboxing, capability-based auth, and an append-only hash-chained audit log. FAG-3 confirmed the framework choices (MCP, A2A-ready Agent Cards, Firecracker/gVisor isolation, OWASP Agentic Top 10 control framework).

FAG-8 (parallel Phase 0) lands the monorepo skeleton and the canonical audit log primitive. FAG-9 ships the typed agent contract and the control-plane API stubs the orchestrator uses to manage agents, tools, and sessions — wired into the FAG-8 audit log primitive from day one.

FAG-10 unifies the FAG-8 monorepo and the FAG-9 runtime contract layer into a single repository and a single release train. The FAG-8 audit log primitive is the canonical chain; `@fagaos/audit-log` is a thin compatibility layer that re-exports the FAG-8 store with the FAG-9 flat `actor / action / resource / data` shape, so the FAG-9 control plane keeps working against the same on-disk chain.

## Decision

### Stack

- **TypeScript / Node ≥20** as the implementation language. (FAG-8 set the floor at Node 20; the FAG-9 ADR asked for 22, but we follow FAG-8 to keep a single toolchain.)
- **Zod** for schemas. Single source of truth for both TypeScript types and JSON Schema, no second `*.schema.json` to drift.
- **`node:http`** for the API stubs. No framework lock-in for Phase 0; the orchestrator drives the in-process API; HTTP is for the orchestrator-to-orchestrator and CLI use cases.
- **Vitest** for tests. TypeScript-native, no transpile dance.
- **Composite TS / NodeNext** for the workspace build, per FAG-8's `tsconfig.json`.

The ADR-001-* tech stack ADR (owned by FAG-8) is the source of truth on language / runtime choices; this ADR is the contract layer, not the tool stack.

### Package layout

```
fagaos/
├── packages/
│   ├── core/                # FAG-8 audit log primitive, policy, runtime, connectors
│   ├── agent-manifest/      # FAG-9 AgentCard schema (Zod + JSON Schema)
│   ├── audit-log/           # FAG-9 compatibility layer over FAG-8 core's audit primitive
│   └── control-plane/       # FAG-9 control plane + HTTP transport
├── apps/
│   └── control-plane-server/  # the runnable HTTP server
└── docs/
    ├── agent-card.md
    ├── api/control-plane.openapi.yaml
    └── adr/0002-phase-0-runtime-contract.md  (this file)
```

Each package is a workspace; the root `package.json` wires them.

### Decoupling from FAG-8

The control plane depends on the `AuditLog` *interface* from `@fagaos/audit-log`, not on the FAG-8 implementation directly. `@fagaos/audit-log` re-exports `@fagaos/core`'s `InMemoryAuditLog` / `FileBackedAuditLog` and provides a thin FAG-9 compatibility surface (`createInMemoryAuditLog`, `read({sinceSeq, limit})`, Zod-validated `append`/`verify`). The on-disk chain is the FAG-8 store; the FAG-9 surface is preserved for compatibility.

### The AgentCard

The card is the Phase 0 contract for an agent. It declares identity, capabilities, MCP endpoints, auth requirements, owner, version, and **tool server references** — the seam where FAG-4 and FAG-5 plug in.

The shape is influenced by the de-facto A2A / Google Agent Card format so a future A2A export is a 1-file adapter.

`auth.secretRef` is a **reference**, never a value. The secret vault (Phase 1) resolves it; the card is safe to publish.

### The audit log wiring

Every public `ControlPlane` method produces at least one entry in the audit log:

| Method                  | Action          | Actor             | Resource kind   |
| ----------------------- | --------------- | ----------------- | --------------- |
| `registerCard`          | `card.register` | `system:control-plane` | `agent`    |
| `createSession`         | `session.create`| caller            | `session`       |
| `deleteSession`         | `session.delete`| `system:control-plane` | `session` |
| `invokeTool`            | `tool.invoke`   | `agent:<id>`      | `tool`          |
| `killSession`           | `session.kill`  | `system:control-plane` | `session` |
| (read via `getSessionLog`) | (none — read) | (n/a)             | (n/a)           |

The chain is verified with `audit.verify()`; the control plane test suite runs a full lifecycle and asserts `verify().ok === true`.

### Tool server seam (FAG-4 / FAG-5)

`stubToolGateway` is the placeholder. It records the call, returns a deterministic stub, and is the only place in `@fagaos/control-plane` where FAG-4 and FAG-5 plug in. Concrete servers (Firecracker microVM + Playwright+MCP for desktop/browser; Nylas/Nango for email/messaging/calendar) replace it in Phase 1 without changing the API surface.

## Consequences

- The orchestrator can drive the control plane in-process for tests and over HTTP for production (single-port server in `apps/control-plane-server`).
- The audit log is auditable end-to-end today: full lifecycle, including tool invocations and kills.
- FAG-4 and FAG-5 can land in parallel — they only touch the tool gateway and the `ToolServerRef.category` enum.
- Phase 1 swaps: real audit log primitive (FAG-8), real tool servers (FAG-4/FAG-5), persistent card registry, persistent session store. None of these change the public contracts.
- FAG-9's `createInMemoryAuditLog` is now a thin wrapper over FAG-8's `InMemoryAuditLog`. The wrapper preserves the FAG-9 flat-shape contract; Phase 1 will retire it in favour of the FAG-8 typed surface.

## Open questions

- Capability token minting lands in Phase 1 with the policy engine. The card already declares capabilities; the control plane will check them on every `invokeTool` call once the policy engine is wired in.
- Streaming the audit log (`GET /sessions/:id/log` returns paged JSON; SSE / chunked transfer is a Phase 1 addition).
- File-backed audit log: `@fagaos/core` already ships `FileBackedAuditLog`; `@fagaos/audit-log` will expose it in Phase 1 as a one-liner so the server can persist chains across restarts.
