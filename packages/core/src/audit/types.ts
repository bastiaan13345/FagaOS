/**
 * Audit log types.
 *
 * The audit log is the security primitive at the base of FagaOS: every
 * capability mint, every policy decision, every connector call, every
 * sandbox boundary crossing must produce an entry. The log itself must be
 * tamper-evident — that is, any modification to a stored entry must be
 * detectable on the next verify() pass.
 *
 * Design follows §7.6 of docs/architecture.md:
 *   - append-only
 *   - SHA-256 hash-chained entries
 *   - signed checkpoints at intervals
 *   - entries record (actor, action, resource, timestamp, prevHash, payload)
 */

/** Genesis prev-hash value: 64 zero hex chars. The first entry points at this. */
export const GENESIS_PREV_HASH = '0'.repeat(64);

/** What (or who) performed the action. */
export interface AuditActor {
  /** Stable identifier — typically an agent id, a user id, or "system". */
  id: string;
  /** Free-form human-readable label for log readability. Not security-bearing. */
  label?: string;
  /** Optional capability token id under which the action was performed. */
  capabilityId?: string;
}

/** The action being recorded. Action names are dot-namespaced by subsystem. */
export interface AuditAction {
  /** Subsystem, e.g. "policy.decide", "connector.gmail.send", "sandbox.exec". */
  name: string;
  /** Outcome — "allow" | "deny" | "error" | "ok". Verifiers should expect a fixed set. */
  outcome: 'allow' | 'deny' | 'ok' | 'error';
}

/** The resource the action targeted. */
export interface AuditResource {
  /** Resource type, e.g. "file", "connector.account", "policy.rule". */
  type: string;
  /** Stable resource identifier. */
  id: string;
}

/** A single immutable entry in the log. Once appended, the fields must never change. */
export interface AuditEntry {
  /** Monotonically increasing sequence number, 1-indexed. */
  seq: number;
  /** Unix epoch milliseconds when the entry was constructed. */
  timestamp: number;
  actor: AuditActor;
  action: AuditAction;
  resource: AuditResource;
  /** Arbitrary structured detail. Must be JSON-serialisable. Kept small in v1. */
  payload?: Record<string, unknown>;
  /** Hash of the previous entry (or GENESIS_PREV_HASH for seq=1). */
  prevHash: string;
  /** SHA-256 of the canonical form of every field above (excluding this one). */
  entryHash: string;
}

/** A signed checkpoint over a chain position. */
export interface AuditCheckpoint {
  /** Sequence number of the entry being attested to. */
  seq: number;
  /** entryHash of the entry at that sequence number. */
  entryHash: string;
  /** Unix epoch milliseconds when the checkpoint was created. */
  timestamp: number;
  /** Hex-encoded signature produced by the CheckpointSigner. */
  signature: string;
  /** Identifier of the signing key, for rotation/audit purposes. */
  keyId: string;
}

/** Query parameters for read-only listing. */
export interface AuditQuery {
  /** Return entries with seq >= since. */
  since?: number;
  /** Return at most `limit` entries. */
  limit?: number;
  /** Filter by actor id (exact match). */
  actorId?: string;
  /** Filter by action name (exact match). */
  actionName?: string;
}

/** Result of a verify() pass over a range of entries. */
export interface AuditVerifyResult {
  /** True iff every entry hashed to its declared entryHash, and the chain linked. */
  ok: boolean;
  /** First sequence number that failed, or null if ok. */
  brokenAt: number | null;
  /** Reason for failure when ok is false. */
  reason?: 'prev_hash_mismatch' | 'entry_hash_mismatch' | 'checkpoint_signature_invalid';
  /** Highest sequence number that was verified. */
  verifiedUpTo: number;
}

/** Strategy for signing checkpoints. */
export interface CheckpointSigner {
  /** Identifier of the signing key. */
  readonly keyId: string;
  /** Produce a signature over (seq, entryHash, timestamp). */
  sign(seq: number, entryHash: string, timestamp: number): string;
  /** Verify a signature. Throws on malformed input; returns false on signature mismatch. */
  verify(checkpoint: AuditCheckpoint): boolean;
}
