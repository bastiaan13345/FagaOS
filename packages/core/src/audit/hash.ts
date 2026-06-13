/**
 * Hash chain primitives for the audit log.
 *
 * Canonicalisation matters: two semantically identical entries must produce
 * the same entryHash on every platform and on every run. We sort object keys
 * recursively before stringifying. The function is total over JSON-serialisable
 * values and never reads from global state.
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { GENESIS_PREV_HASH, type AuditEntry } from './types.js';

/** Sort object keys recursively. Arrays preserve order; null and primitives pass through. */
export function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const obj = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = canonicalize(obj[key]);
  }
  return sorted;
}

/** SHA-256 hex of the canonical JSON of a value. */
export function sha256Hex(value: unknown): string {
  const canonical = canonicalize(value);
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

/**
 * Compute the entry hash for an entry *body*. The body is every field of the
 * entry except `entryHash` itself. Pass an object shaped like:
 *   { seq, timestamp, actor, action, resource, payload?, prevHash }
 *
 * Returns a 64-char hex string.
 */
export function hashEntry(body: {
  seq: number;
  timestamp: number;
  actor: AuditEntry['actor'];
  action: AuditEntry['action'];
  resource: AuditEntry['resource'];
  payload?: Record<string, unknown>;
  prevHash: string;
}): string {
  return sha256Hex(body);
}

/**
 * Walk an entry list and return the chain of entryHashes. Useful for tests
 * and for offline verification of an exported segment.
 */
export function hashChain(entries: ReadonlyArray<AuditEntry>): string[] {
  const out: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    const expectedPrev = i === 0 ? GENESIS_PREV_HASH : entries[i - 1]!.entryHash;
    if (e.prevHash !== expectedPrev) {
      throw new Error(
        `Chain break at index ${i} (seq=${e.seq}): prevHash ${e.prevHash} != expected ${expectedPrev}`,
      );
    }
    const recomputed = hashEntry({
      seq: e.seq,
      timestamp: e.timestamp,
      actor: e.actor,
      action: e.action,
      resource: e.resource,
      ...(e.payload !== undefined ? { payload: e.payload } : {}),
      prevHash: e.prevHash,
    });
    if (recomputed !== e.entryHash) {
      throw new Error(`Tamper at seq=${e.seq}: recomputed ${recomputed} != declared ${e.entryHash}`);
    }
    out.push(e.entryHash);
  }
  return out;
}

/**
 * HMAC-based checkpoint signer. The key is opaque bytes; the keyId is a label
 * for rotation/audit. v1 ships with HMAC; future versions may swap in
 * asymmetric signing (Ed25519) without changing the AuditCheckpoint shape.
 */
export class HmacCheckpointSigner {
  constructor(
    public readonly keyId: string,
    private readonly key: Buffer,
  ) {
    if (key.length < 32) {
      throw new Error(`HmacCheckpointSigner requires a key of at least 32 bytes (got ${key.length})`);
    }
  }

  /** Convenience: derive a key from a passphrase via SHA-256. Not for production. */
  static fromPassphrase(keyId: string, passphrase: string): HmacCheckpointSigner {
    const key = createHash('sha256').update(passphrase).digest();
    return new HmacCheckpointSigner(keyId, key);
  }

  sign(seq: number, entryHash: string, timestamp: number): string {
    const mac = createHmac('sha256', this.key);
    mac.update(`${seq}|${entryHash}|${timestamp}`);
    return mac.digest('hex');
  }

  verify(checkpoint: { seq: number; entryHash: string; timestamp: number; signature: string; keyId: string }): boolean {
    if (checkpoint.keyId !== this.keyId) return false;
    const expected = this.sign(checkpoint.seq, checkpoint.entryHash, checkpoint.timestamp);
    // timingSafeEqual requires equal-length buffers.
    const a = Buffer.from(expected, 'hex');
    const b = Buffer.from(checkpoint.signature, 'hex');
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }
}
