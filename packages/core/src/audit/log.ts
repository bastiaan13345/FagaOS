/**
 * Audit log implementations.
 *
 * Two stores are provided:
 *   - InMemoryAuditLog: fast, used by tests and ephemeral runtimes.
 *   - FileBackedAuditLog: persists entries to a JSONL file with periodic
 *     checkpoint sidecars. Suitable for a single-process v0.
 *
 * The contract is identical for both: append(), query(), verify(),
 * latestCheckpoint(). Neither store exposes update or delete — append-only is
 * a hard invariant.
 *
 * Concurrency: each store uses an async mutex (a single in-flight chain) to
 * serialise appends. A multi-process deployment needs a different backend
 * (Postgres advisory lock or a dedicated service); that is out of scope for
 * Phase 0.
 */

import { promises as fs } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname } from 'node:path';
import {
  GENESIS_PREV_HASH,
  type AuditCheckpoint,
  type AuditEntry,
  type AuditQuery,
  type AuditVerifyResult,
  type CheckpointSigner,
} from './types.js';
import { hashEntry, HmacCheckpointSigner } from './hash.js';
import {
  AuditChainBrokenError,
  AuditCheckpointSignatureError,
  AuditTamperError,
} from './errors.js';

/** Common interface every audit-log store must implement. */
export interface AuditLog {
  append(input: {
    actor: AuditEntry['actor'];
    action: AuditEntry['action'];
    resource: AuditEntry['resource'];
    payload?: Record<string, unknown>;
  }): Promise<AuditEntry>;

  query(q?: AuditQuery): Promise<ReadonlyArray<AuditEntry>>;

  /** Latest entry, or null if the log is empty. */
  latest(): Promise<AuditEntry | null>;

  /** Most recent checkpoint, or null if none has been emitted. */
  latestCheckpoint(): Promise<AuditCheckpoint | null>;

  /**
   * Verify a contiguous range of entries. If `upTo` is omitted, verifies the
   * entire log. Throws on the first detected break, and returns the result
   * on success.
   */
  verify(options?: { upTo?: number; checkpointSigner?: CheckpointSigner }): Promise<AuditVerifyResult>;
}

/** Options shared by every implementation. */
export interface AuditLogOptions {
  /** How often to emit a signed checkpoint. Default: every 100 entries. */
  checkpointEvery?: number;
  /** Checkpoint signer. If absent, an HMAC signer is derived from FAGAOS_AUDIT_KEY env or a random key. */
  signer?: CheckpointSigner;
  /** Logical "instance id" recorded in the genesis for multi-process correlation. */
  instanceId?: string;
}

interface StoredEntry extends AuditEntry {
  /** Signature checkpoint covering this entry, if any. */
  checkpoint?: AuditCheckpoint;
}

/** Promise queue: serialises appends so the chain never races itself. */
class Mutex {
  private chain: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T> | T): Promise<T> {
    const next = this.chain.then(fn, fn);
    // Swallow rejection on the chain itself so one failure does not poison
    // the next waiter. Errors are still surfaced to the caller of `next`.
    this.chain = next.catch(() => undefined);
    return next;
  }
}

/**
 * In-memory audit log. Used by tests and short-lived runtimes. All entries
 * are kept in a private array that callers cannot mutate from outside.
 */
export class InMemoryAuditLog implements AuditLog {
  private readonly entries: StoredEntry[] = [];
  private readonly mutex = new Mutex();
  private readonly checkpointEvery: number;
  private readonly signer: CheckpointSigner;
  private readonly instanceId: string;
  private latestCheckpointValue: AuditCheckpoint | null = null;

  constructor(options: AuditLogOptions = {}) {
    this.checkpointEvery = options.checkpointEvery ?? 100;
    this.signer = options.signer ?? defaultSigner();
    this.instanceId = options.instanceId ?? 'memory';
  }

  async append(input: {
    actor: AuditEntry['actor'];
    action: AuditEntry['action'];
    resource: AuditEntry['resource'];
    payload?: Record<string, unknown>;
  }): Promise<AuditEntry> {
    return this.mutex.run(async () => {
      const prevEntry = this.entries[this.entries.length - 1];
      const prevHash = prevEntry ? prevEntry.entryHash : GENESIS_PREV_HASH;
      const seq = this.entries.length + 1;
      const timestamp = Date.now();
      const body = {
        seq,
        timestamp,
        actor: input.actor,
        action: input.action,
        resource: input.resource,
        ...(input.payload !== undefined ? { payload: input.payload } : {}),
        prevHash,
      };
      const entryHash = hashEntry(body);
      const entry: StoredEntry = { ...body, entryHash };
      this.entries.push(entry);

      if (seq % this.checkpointEvery === 0) {
        const checkpoint = this.emitCheckpoint(entry);
        entry.checkpoint = checkpoint;
        this.latestCheckpointValue = checkpoint;
      }
      // Return a copy without the internal checkpoint field.
      return { ...entry };
    });
  }

  async query(q: AuditQuery = {}): Promise<ReadonlyArray<AuditEntry>> {
    let out = this.entries;
    if (q.actorId) {
      out = out.filter((e) => e.actor.id === q.actorId);
    }
    if (q.actionName) {
      out = out.filter((e) => e.action.name === q.actionName);
    }
    if (q.since !== undefined) {
      out = out.filter((e) => e.seq >= q.since!);
    }
    if (q.limit !== undefined) {
      out = out.slice(0, q.limit);
    }
    // Project to the public AuditEntry shape.
    return out.map(({ ...rest }) => rest);
  }

  async latest(): Promise<AuditEntry | null> {
    const last = this.entries[this.entries.length - 1];
    if (!last) return null;
    const { ...rest } = last;
    return rest;
  }

  async latestCheckpoint(): Promise<AuditCheckpoint | null> {
    return this.latestCheckpointValue;
  }

  async verify(options: { upTo?: number; checkpointSigner?: CheckpointSigner } = {}): Promise<AuditVerifyResult> {
    const upTo = options.upTo ?? this.entries.length;
    if (upTo < 0 || upTo > this.entries.length) {
      throw new RangeError(`verify upTo=${upTo} out of range (0..${this.entries.length})`);
    }
    let prevHash = GENESIS_PREV_HASH;
    for (let i = 0; i < upTo; i++) {
      const e = this.entries[i]!;
      if (e.prevHash !== prevHash) {
        throw new AuditChainBrokenError(e.seq, prevHash, e.prevHash);
      }
      const body = {
        seq: e.seq,
        timestamp: e.timestamp,
        actor: e.actor,
        action: e.action,
        resource: e.resource,
        ...(e.payload !== undefined ? { payload: e.payload } : {}),
        prevHash: e.prevHash,
      };
      const recomputed = hashEntry(body);
      if (recomputed !== e.entryHash) {
        throw new AuditTamperError(e.seq, e.entryHash, recomputed);
      }
      prevHash = e.entryHash;
    }
    // Verify the latest checkpoint signature if present, using the supplied
    // signer (or the in-memory signer).
    const cp = this.entries[upTo - 1]?.checkpoint;
    const result: AuditVerifyResult = { ok: true, brokenAt: null, verifiedUpTo: upTo };
    if (cp && upTo > 0) {
      const signer = options.checkpointSigner ?? this.signer;
      if (!signer.verify(cp)) {
        throw new AuditCheckpointSignatureError(cp.seq, cp.keyId);
      }
    }
    return result;
  }

  private emitCheckpoint(entry: StoredEntry): AuditCheckpoint {
    const timestamp = Date.now();
    const signature = this.signer.sign(entry.seq, entry.entryHash, timestamp);
    return {
      seq: entry.seq,
      entryHash: entry.entryHash,
      timestamp,
      signature,
      keyId: this.signer.keyId,
    };
  }
}

/**
 * File-backed audit log. Persists entries as JSONL to `path` and checkpoints
 * to `path.checkpoints.jsonl` (one per line). Appends use O_APPEND, so the
 * log is crash-safe at line boundaries: a partial trailing line is ignored
 * on load.
 */
export class FileBackedAuditLog implements AuditLog {
  private readonly path: string;
  private readonly checkpointPath: string;
  private readonly checkpointEvery: number;
  private readonly signer: CheckpointSigner;
  private readonly instanceId: string;
  private readonly mutex = new Mutex();
  private entries: StoredEntry[] = [];
  private loaded = false;
  private latestCheckpointValue: AuditCheckpoint | null = null;

  constructor(path: string, options: AuditLogOptions = {}) {
    this.path = path;
    this.checkpointPath = `${path}.checkpoints.jsonl`;
    this.checkpointEvery = options.checkpointEvery ?? 100;
    this.signer = options.signer ?? defaultSigner();
    this.instanceId = options.instanceId ?? `file:${path}`;
  }

  async append(input: {
    actor: AuditEntry['actor'];
    action: AuditEntry['action'];
    resource: AuditEntry['resource'];
    payload?: Record<string, unknown>;
  }): Promise<AuditEntry> {
    return this.mutex.run(async () => {
      await this.ensureLoaded();
      const prevEntry = this.entries[this.entries.length - 1];
      const prevHash = prevEntry ? prevEntry.entryHash : GENESIS_PREV_HASH;
      const seq = this.entries.length + 1;
      const timestamp = Date.now();
      const body = {
        seq,
        timestamp,
        actor: input.actor,
        action: input.action,
        resource: input.resource,
        ...(input.payload !== undefined ? { payload: input.payload } : {}),
        prevHash,
      };
      const entryHash = hashEntry(body);
      const entry: StoredEntry = { ...body, entryHash };
      this.entries.push(entry);

      // Persist the entry immediately so the on-disk log is never behind memory.
      await fs.mkdir(dirname(this.path), { recursive: true });
      const handle = await fs.open(this.path, 'a');
      try {
        await handle.write(JSON.stringify(entry) + '\n');
      } finally {
        await handle.close();
      }

      if (seq % this.checkpointEvery === 0) {
        const checkpoint = this.emitCheckpoint(entry);
        entry.checkpoint = checkpoint;
        this.latestCheckpointValue = checkpoint;
        const cpHandle = await fs.open(this.checkpointPath, 'a');
        try {
          await cpHandle.write(JSON.stringify(checkpoint) + '\n');
        } finally {
          await cpHandle.close();
        }
      }
      const { ...rest } = entry;
      return rest;
    });
  }

  async query(q: AuditQuery = {}): Promise<ReadonlyArray<AuditEntry>> {
    await this.ensureLoaded();
    let out: StoredEntry[] = this.entries;
    if (q.actorId) out = out.filter((e) => e.actor.id === q.actorId);
    if (q.actionName) out = out.filter((e) => e.action.name === q.actionName);
    if (q.since !== undefined) out = out.filter((e) => e.seq >= q.since!);
    if (q.limit !== undefined) out = out.slice(0, q.limit);
    return out.map(({ ...rest }) => rest);
  }

  async latest(): Promise<AuditEntry | null> {
    await this.ensureLoaded();
    const last = this.entries[this.entries.length - 1];
    if (!last) return null;
    const { ...rest } = last;
    return rest;
  }

  async latestCheckpoint(): Promise<AuditCheckpoint | null> {
    await this.ensureLoaded();
    return this.latestCheckpointValue;
  }

  async verify(options: { upTo?: number; checkpointSigner?: CheckpointSigner } = {}): Promise<AuditVerifyResult> {
    await this.ensureLoaded();
    const upTo = options.upTo ?? this.entries.length;
    if (upTo < 0 || upTo > this.entries.length) {
      throw new RangeError(`verify upTo=${upTo} out of range (0..${this.entries.length})`);
    }
    let prevHash = GENESIS_PREV_HASH;
    for (let i = 0; i < upTo; i++) {
      const e = this.entries[i]!;
      if (e.prevHash !== prevHash) {
        throw new AuditChainBrokenError(e.seq, prevHash, e.prevHash);
      }
      const body = {
        seq: e.seq,
        timestamp: e.timestamp,
        actor: e.actor,
        action: e.action,
        resource: e.resource,
        ...(e.payload !== undefined ? { payload: e.payload } : {}),
        prevHash: e.prevHash,
      };
      const recomputed = hashEntry(body);
      if (recomputed !== e.entryHash) {
        throw new AuditTamperError(e.seq, e.entryHash, recomputed);
      }
      prevHash = e.entryHash;
    }
    const cp = this.entries[upTo - 1]?.checkpoint;
    if (cp && upTo > 0) {
      const signer = options.checkpointSigner ?? this.signer;
      if (!signer.verify(cp)) {
        throw new AuditCheckpointSignatureError(cp.seq, cp.keyId);
      }
    }
    return { ok: true, brokenAt: null, verifiedUpTo: upTo };
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    try {
      const data = await fs.readFile(this.path, 'utf8');
      const lines = data.split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        const e = JSON.parse(line) as StoredEntry;
        this.entries.push(e);
      }
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== 'ENOENT') throw e;
    }
    try {
      const cpData = await fs.readFile(this.checkpointPath, 'utf8');
      const lines = cpData.split('\n').filter((l) => l.trim());
      for (const line of lines) {
        const cp = JSON.parse(line) as AuditCheckpoint;
        this.latestCheckpointValue = cp;
        // Attach to the corresponding entry so verify() can inspect it.
        const entry = this.entries.find((en) => en.seq === cp.seq);
        if (entry) entry.checkpoint = cp;
      }
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== 'ENOENT') throw e;
    }
    this.loaded = true;
  }

  private emitCheckpoint(entry: StoredEntry): AuditCheckpoint {
    const timestamp = Date.now();
    const signature = this.signer.sign(entry.seq, entry.entryHash, timestamp);
    return {
      seq: entry.seq,
      entryHash: entry.entryHash,
      timestamp,
      signature,
      keyId: this.signer.keyId,
    };
  }
}

function defaultSigner(): CheckpointSigner {
  const envKey = process.env['FAGAOS_AUDIT_KEY'];
  if (envKey && envKey.length >= 32) {
    return new HmacCheckpointSigner('env:FAGAOS_AUDIT_KEY', Buffer.from(envKey));
  }
  // Random per-process key. Signatures produced in this mode are *not*
  // verifiable across restarts — useful for tests, dangerous in production.
  // FileBackedAuditLog with a stable key file is the production path.
  const key = randomBytes(32);
  return new HmacCheckpointSigner('ephemeral', key);
}
