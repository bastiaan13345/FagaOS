# FagaOS — Risk Register

> Companion to `architecture.md`. Each entry: id, title, likelihood ×
> impact, category, mitigation. The top 15 are tracked; another 5 are
> deferred to v2.

## Tracking

| # | ID | Title | Likelihood | Impact | Severity | Status |
|---|----|-------|-----------|--------|----------|--------|
| 1 | R1 | Prompt injection hijacks an agent and exfiltrates data | H | H | Critical | mitigated in v1 |
| 2 | R2 | Compromised third-party skill escapes its sandbox | M | H | High | mitigated in v1 |
| 3 | R3 | LLM-generated code reads sensitive data and exfiltrates | H | H | Critical | mitigated in v1 |
| 4 | R4 | Capability token replay | M | H | High | mitigated in v1 |
| 5 | R5 | Audit log tampering | L | H | High | mitigated in v1 (this phase) |
| 6 | R6 | Cross-tenant data leak via shared connector | L | H | High | partial; needs Phase 3 |
| 7 | R7 | Bus message injection / spoofing | M | M | Medium | mitigated in v1 |
| 8 | R8 | Dependency supply-chain attack | M | H | High | partial; needs SCA in CI |
| 9 | R9 | Insider threat: rogue operator | L | H | High | deferred to v2 |
| 10 | R10 | Model exfiltration via crafted prompts | L | H | High | partial; rate-limit |
| 11 | R11 | Sandbox escape via WASM runtime bug | L | H | High | mitigated in v1 (gVisor fallback) |
| 12 | R12 | DoS via runaway agent | M | M | Medium | mitigated in v1 (token budget) |
| 13 | R13 | Side-channel: timing in policy engine | L | M | Medium | deferred to v2 |
| 14 | R14 | Audit log storage exhaustion | M | M | Medium | mitigated in v1 (rotation) |
| 15 | R15 | Connector credential theft | M | H | High | mitigated in v1 (vault) |

### Deferred to v2

- R16 — model weight exfiltration via repeated subtle queries
- R17 — collusion between sibling orchestrators
- R18 — backdoor in a pinned LLM dependency
- R19 — timing attack on the capability token HMAC
- R20 — physical / cold-boot memory disclosure

## R5 detail — Audit log tampering

**Threat.** An attacker (or a bug) modifies a stored audit entry to
hide an action. The log itself becomes untrustworthy, so incident
response loses its primary evidence.

**Mitigation (Phase 0).** SHA-256 hash chain across entries, plus
HMAC-SHA-256 signed checkpoints at intervals. Any modification to a
stored entry breaks the chain and is detected on `verify()`. Three
failure modes are detected and surfaced as typed errors:

- `AuditTamperError` — recomputed entry hash does not match declared
  hash (entry body changed)
- `AuditChainBrokenError` — entry's `prevHash` does not match the
  previous entry's `entryHash` (entry removed or reordered)
- `AuditCheckpointSignatureError` — checkpoint signature invalid
  (signing key mismatch, or signed by a non-audit component)

**Limitations acknowledged.** A sufficiently powerful attacker who
also controls the signing key can rewrite the entire chain and forge
matching checkpoints. The mitigation assumes the signing key is held
in a separate, audited location (the audit component runs under a
dedicated OS user with no network access in production). That
configuration lands in Phase 5.

## Open questions

- **FAG-3 (Research):** Bet on A2A now or defer?
- **FAG-4 (Desktop/Browser):** Does Layer 4 isolation (separate OS
  user for the browser plane) break extension compatibility? What's
  the fallback?
- **FAG-5 (Integrations):** Per-integration minimum capability set,
  and the PII redaction story for email read.
- **FAG-7 (QA):** A prompt-injection regression test fixture
  library, and a CI step that runs them.
