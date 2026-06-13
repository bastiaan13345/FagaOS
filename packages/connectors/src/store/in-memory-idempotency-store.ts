/**
 * In-memory idempotency store.
 *
 * Entries are kept in a Map keyed by the supplied `key`. Each entry
 * carries a `created_at` and is dropped on `sweep()` once it crosses
 * the configured TTL (default 24 hours). A `reserveOrLookup` call for
 * a fresh key returns `null`; a call for a known key returns the
 * stored record (and rejects on hash mismatch).
 */
import { createHash } from 'node:crypto';
import { ConnectorError } from '../errors.js';
import type {
  IdempotencyRecord,
  IdempotencyStore,
} from './idempotency-store.js';

export interface InMemoryIdempotencyStoreOptions {
  /** TTL in milliseconds. Default 24h. */
  ttlMs?: number;
}

interface InternalEntry {
  key: string;
  provider_id: string | null;
  request_hash: string;
  response: unknown;
  created_at: number;
  expires_at: number;
  response_hash: string;
}

export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly entries = new Map<string, InternalEntry>();
  private readonly ttlMs: number;

  constructor(options: InMemoryIdempotencyStoreOptions = {}) {
    this.ttlMs = options.ttlMs ?? 24 * 60 * 60 * 1000;
  }

  async reserveOrLookup(args: {
    key: string;
    request_hash: string;
  }): Promise<IdempotencyRecord | null> {
    const now = Date.now();
    this.dropExpired(now);
    const existing = this.entries.get(args.key);
    if (!existing) return null;
    if (existing.request_hash !== args.request_hash) {
      throw new ConnectorError(
        'idempotency_conflict',
        `idempotency key "${args.key}" was previously used with a different request body`,
      );
    }
    // Strip the internal fields from the public record.
    const publicRecord: IdempotencyRecord = {
      provider_id: existing.provider_id,
      request_hash: existing.request_hash,
      response: existing.response,
      created_at: existing.created_at,
    };
    return publicRecord;
  }

  async commit(args: {
    key: string;
    request_hash: string;
    response: unknown;
    provider_id?: string | null;
  }): Promise<void> {
    const now = Date.now();
    this.dropExpired(now);
    const responseHash = createHash('sha256')
      .update(JSON.stringify(args.response))
      .digest('hex');
    const entry: InternalEntry = {
      key: args.key,
      request_hash: args.request_hash,
      response: args.response,
      provider_id: args.provider_id ?? null,
      created_at: now,
      expires_at: now + this.ttlMs,
      response_hash: responseHash,
    };
    this.entries.set(args.key, entry);
  }

  async sweep(now: number = Date.now()): Promise<number> {
    let dropped = 0;
    for (const [k, v] of this.entries) {
      if (v.expires_at <= now) {
        this.entries.delete(k);
        dropped++;
      }
    }
    return dropped;
  }

  private dropExpired(now: number): void {
    for (const [k, v] of this.entries) {
      if (v.expires_at <= now) this.entries.delete(k);
    }
  }
}
