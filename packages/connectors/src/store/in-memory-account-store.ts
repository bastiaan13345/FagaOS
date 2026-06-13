/**
 * In-memory account store. Used by tests and short-lived runtimes. The
 * write path is synchronous from the caller's perspective (no
 * persistence) but returns a Promise so the interface matches a future
 * async store.
 */
import type { Account, AccountStatus, Provider } from '../models/schemas.js';
import { AccountSchema } from '../models/schemas.js';
import type { AccountStore } from './account-store.js';

export class InMemoryAccountStore implements AccountStore {
  private readonly byId = new Map<string, Account>();

  async upsert(account: Account): Promise<void> {
    // Round-trip through the schema to normalise defaults and reject
    // malformed input early. This is the single point where an account
    // is shape-checked; downstream code can rely on every field.
    const parsed = AccountSchema.parse(account);
    this.byId.set(parsed.id, parsed);
  }

  async get(id: string): Promise<Account | null> {
    return this.byId.get(id) ?? null;
  }

  async listForUser(userId: string, provider: Provider): Promise<Account[]> {
    const out: Account[] = [];
    for (const a of this.byId.values()) {
      if (a.user_id === userId && a.provider === provider) out.push(a);
    }
    return out;
  }

  async listForUserAll(userId: string): Promise<Account[]> {
    const out: Account[] = [];
    for (const a of this.byId.values()) {
      if (a.user_id === userId) out.push(a);
    }
    return out;
  }

  async setStatus(id: string, status: AccountStatus): Promise<void> {
    const existing = this.byId.get(id);
    if (!existing) {
      throw new Error(`account "${id}" not found`);
    }
    this.byId.set(id, { ...existing, status, updated_at: new Date().toISOString() });
  }

  async size(): Promise<number> {
    return this.byId.size;
  }
}
