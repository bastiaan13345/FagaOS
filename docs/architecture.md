# FagaOS — Core Platform Architecture

> Status: design complete (FAG-6). Implementation in progress (FAG-8 onwards).

This document is the source of truth for FagaOS's architecture. The
repository's `README.md` points here; the package-level code points
back. When in doubt, this file wins.

## 1. Mission

FagaOS is an operating system for AI agents. It provides:

- a capability-based authorisation model with default-deny
- a four-layer sandbox stack (WASM, seccomp, gVisor, separate OS user)
- an append-only, tamper-evident audit log (Phase 0 ships this)
- a hierarchical orchestration model with sibling-shadow fault detection
- durable, tiered state (RAM → SQLite → Postgres → event log)
- a message bus with at-least-once delivery and idempotency keys

It does **not** ship a model. It does not pick an agent framework. It
defines the substrate that any agent framework can run on.

## 2. Top-level shape

```
┌──────────────────────────────────────────────────────────┐
│                    User sessions (5–15 each)             │
│  ┌────────────────────────────────────────────────────┐  │
│  │                Orchestrator                        │  │
│  │   plan · delegate · monitor · checkpoint          │  │
│  └──────┬──────┬──────┬──────┬──────┬─────────────────┘  │
│         │      │      │      │      │                    │
│     Worker Worker Worker Worker Worker                   │
│     (capability-scoped, sandboxed)                      │
└──────────────────────────────────────────────────────────┘
                          │
                          ▼
┌──────────────────────────────────────────────────────────┐
│                       FagaOS core                        │
│  Capability broker · Policy Engine · Audit log · Bus     │
└──────────────────────────────────────────────────────────┘
                          │
        ┌─────────────────┼─────────────────┐
        ▼                 ▼                 ▼
   Connectors        Desktop plane      External models
   (Gmail, …)        (browser/desktop   (Claude, GPT, …)
                      under separate
                      OS user)
```

## 3. Orchestration

Hierarchical. One Orchestrator coordinates a small (5–15) team of
worker agents per user session. Sibling orchestrators can shadow for
fault detection. Workers are **not** peers to the orchestrator; they
cannot override it.

This is non-negotiable. A peer-to-peer agent swarm cannot enforce
authority. The orchestrator is the only entity that can mint
capability tokens, and workers are bound by them.

## 4. Transport: NATS JetStream

Subject-based addressing:

- `agent.<id>.in` — direct message to an agent
- `cmd.<verb>` — broadcast command
- `evt.<type>` — event subscription
- `audit.<seq>` — audit log stream (immutable)

At-least-once delivery. Idempotency keys deduplicate at the consumer.
24-hour hot retention + cold archive. Migrate to Kafka only if we
outgrow it; NATS → Kafka is a clean path.

## 5. State

Tiered:

| Tier | Storage | Lifetime | Use |
|------|---------|----------|-----|
| 1 | Working RAM | per task | tool-call scratch space |
| 2 | SQLite (per session) | hours–days | session memory |
| 3 | Postgres (per workspace) | weeks–months | episodic + vector memory |
| 4 | Append-only event log | permanent | everything else |

SQLite/Postgres only, no exotic stores. Checkpoints at every
tool-call boundary, encrypted at rest, replayed on restart.

## 6. Sandboxing — four layers, mandatory

1. **WASM** (Wasmtime) for LLM-generated code execution — no network,
   30 s wall-time cap, per-execution token budget
2. **Per-agent OS process** under dedicated user, seccomp-bpf profile
3. **gVisor container** for untrusted MCP servers
4. **Separate OS user** for the desktop/browser automation plane

Each layer stops a class of attack the others don't. ~15% memory
overhead, modest ops cost. Worth it.

## 7. Security model

### 7.1 Capability-based, default-deny

Every tool call requires a signed, short-lived, resource-scoped
capability token minted by a Policy Engine (Cedar preferred).
Capabilities are unforgeable by agents, blind to tool output (so prompt
injection cannot escalate privilege), and bounded with numeric
constraints.

### 7.2 Append-only audit log

Every authorisation decision, every sandbox boundary crossing, every
connector call produces an entry. The log is hash-chained
(SHA-256) and signed (HMAC-SHA-256 checkpoints every 100 entries).

This is what `@fagaos/core` ships in Phase 0. See
`packages/core/src/audit/` and `packages/core/tests/audit.test.ts`.

### 7.3 No agent can modify policy

That is the single most important invariant. The Policy Engine runs
out-of-band from agents; the orchestrator and the workers consume its
decisions but cannot influence them.

### 7.4 Prompt injection defences

Architectural, not prompt-level:

- data/instruction boundary at the LLM client
- canary tokens on high-value resources
- high-risk actions (send message, delete, spend, code change,
  cross-network) require user confirmation
- capability tokens do not carry context

## 8. Threat model

The top three risks, full register in `risk-assessment.md`:

- **R1 — Prompt injection hijacks an agent and exfiltrates data**
  (H×H, Critical). Layered defences in §7.6.
- **R3 — LLM-generated code reads sensitive data and exfiltrates**
  (H×H, Critical). WASM sandbox + static exfil-pattern check +
  explicit `network.out` capability + per-execution token cap.
- **R2 — Compromised third-party skill escapes its sandbox**
  (M×H, High). gVisor for untrusted MCP servers, signed skills,
  network egress allowlist, no ambient authority.

## 9. Key management

- Audit signing key: out-of-band, supplied via `FAGAOS_AUDIT_KEY`
  environment variable or a key file outside the working tree. Never
  in the repository.
- Capability signing keys: rotated by the Policy Engine on a fixed
  schedule (30 days default).
- Connector credentials: stored in a dedicated vault, fetched at
  call time, never logged.

## 10. Failure handling

5 s heartbeat, 3 misses = `SUSPECT`, capability tokens suspended,
restart from last checkpoint (≤3 attempts), then escalate to the
human owner.

## 11. Lifecycle states

```
NULL → IDLE → RUNNING → COMPLETED
                  │
                  ├── DEAD       (graceful shutdown)
                  └── CRASHED    (kill -9, OOM, sandbox breach)
```

`SUSPECT` is a transient overlay on `RUNNING` while the heartbeat
misses accumulate.

## 12. Roadmap (16 weeks, 5 phases)

1. **Skeleton (week 1–2)** — monorepo, CI, audit log primitive.
   ← *We are here. FAG-8.*
2. **Lifecycle (week 3–4)** — agent lifecycle states, heartbeat,
   checkpoint/replay.
3. **Security core (week 5–7)** — Cedar policy engine binding,
   capability broker, prompt-injection corpus.
4. **Inter-agent (week 8–10)** — NATS bus, idempotency, sibling
   orchestrators.
5. **Hardening + production (week 11–16)** — adversarial corpus,
   24 h soak, rollback, doc, GA cut.

## 13. Open questions for other teams

- **FAG-3 (Research):** Bet on A2A now or defer?
- **FAG-4 (Desktop/Browser):** Does Layer 4 isolation (separate OS
  user for the browser plane) break extension compatibility? What's
  the fallback?
- **FAG-5 (Integrations):** Per-integration minimum capability set,
  and the PII redaction story for email read.
- **FAG-7 (QA):** A prompt-injection regression test fixture
  library, and a CI step that runs them.

## 14. What this document is not

- Not a protocol spec. Subject naming and message shapes will live in
  `docs/bus-protocol.md` once Phase 4 lands.
- Not a deployment guide. That is `docs/operations.md` (Phase 5).
- Not a contributor guide. That is the root `README.md`.

When the design changes, edit this file in the same PR as the code
change. Out-of-date architecture docs are worse than no architecture
docs.
