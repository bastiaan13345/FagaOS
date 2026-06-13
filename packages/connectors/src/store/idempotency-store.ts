/**
 * Idempotency store.
 *
 * Every write call to the gateway carries an idempotency key (a
 * UUIDv7-like value supplied by the caller). The gateway stores
 * `key → (provider_id, response_sha256, created_at)` for 24 hours and:
 *   - replays with the same key return the stored response verbatim
 *   - replays with the *same* key but a *different* body are rejected
 *     with `idempotency_conflict`
 *   - entries older than `ttlMs` are silently dropped
 *
 * Reads do not need idempotency keys in the strict sense, but the
 * gateway also dedupes `mail.list`/`calendar.events.list` calls within a
 * 1-second window to avoid a noisy agent looping the same query.
 */
export interface IdempotencyRecord {
  /** Provider-issued id (e.g. `provider_message_id`). May be null for reads. */
  provider_id: string | null;
  /** sha256 of the request body, hex. Used to detect conflicting replays. */
  request_hash: string;
  /** Free-form opaque response payload. */
  response: unknown;
  /** Unix epoch milliseconds. */
  created_at: number;
}

export interface IdempotencyStore {
  /**
   * Reserve or look up an idempotency key. If the key is new, returns
   * `null` and the caller proceeds with the operation. If the key is
   * present and matches the request hash, returns the stored record
   * and the caller should return its `response` verbatim. If the key
   * is present and the hash differs, throws an `idempotency_conflict`
   * error.
   */
  reserveOrLookup(args: {
    key: string;
    request_hash: string;
  }): Promise<IdempotencyRecord | null>;

  /** Commit a response under a previously-reserved key. */
  commit(args: {
    key: string;
    request_hash: string;
    response: unknown;
    provider_id?: string | null;
  }): Promise<void>;

  /** Drop entries older than the store's TTL. Safe to call periodically. */
  sweep(now: number): Promise<number>;
}
