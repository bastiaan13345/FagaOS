/**
 * Reauth-status tracker.
 *
 * When a connector detects that an access-token refresh failed with
 * `invalid_grant` (or the platform's equivalent), it calls
 * `markReauthRequired(accountId, reason)`. The gateway reads this on
 * every call and refuses to dispatch if the account is in
 * `reauth_required` state, returning `ConnectorError` with code
 * `reauth_required` instead.
 *
 * The tracker is intentionally tiny: a `Map<account_id, ReauthInfo>`.
 * The gateway is the only reader. Clearing the flag is the FagaOS
 * control plane's job once the user has re-linked the account.
 */
export interface ReauthInfo {
  /** RFC 3339 timestamp at which the flag was set. */
  at: string;
  /** Human-readable reason (e.g. "invalid_grant"). */
  reason: string;
}

export class ReauthTracker {
  private readonly flags = new Map<string, ReauthInfo>();

  markReauthRequired(accountId: string, reason: string): void {
    this.flags.set(accountId, { at: new Date().toISOString(), reason });
  }

  clear(accountId: string): void {
    this.flags.delete(accountId);
  }

  isRequired(accountId: string): boolean {
    return this.flags.has(accountId);
  }

  get(accountId: string): ReauthInfo | null {
    return this.flags.get(accountId) ?? null;
  }

  size(): number {
    return this.flags.size;
  }
}
