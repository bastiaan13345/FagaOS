/**
 * Account store interface.
 *
 * Phase 1 ships an in-memory implementation. The interface is
 * persistence-agnostic so Phase 2+ can swap in a Postgres-backed
 * implementation without changing the gateway.
 *
 * The store does NOT hold credentials. It holds the metadata the agent
 * runtime needs to know about an account (handle, provider, scopes,
 * status). The plaintext token lives behind the gateway's credential
 * vault (out of scope for this issue).
 */
import type { Account, AccountStatus, Provider } from '../models/schemas.js';

export interface AccountStore {
  /** Insert or update an account. Idempotent on `id`. */
  upsert(account: Account): Promise<void>;
  /** Lookup by id. Returns `null` if not present. */
  get(id: string): Promise<Account | null>;
  /** List all accounts for a (user, provider) pair. */
  listForUser(userId: string, provider: Provider): Promise<Account[]>;
  /** List all accounts for a user across providers. */
  listForUserAll(userId: string): Promise<Account[]>;
  /** Update the status field. `null` is rejected. */
  setStatus(id: string, status: AccountStatus): Promise<void>;
  /** Total number of accounts, for tests / metrics. */
  size(): Promise<number>;
}
