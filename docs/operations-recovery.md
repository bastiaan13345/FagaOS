# FagaOS — Operational recovery: keys, secrets, and policy

> Runbook for the on-call engineer. Every step here is reversible;
> the recovery model is "log, drain, rotate, verify, resume".

## Key compromise: rotate immediately

**Symptom:** a capability-signing key (or its HMAC secret) is
suspected of being exposed. This is the single most urgent
recovery scenario — every outstanding token signed by the key is
forgivable.

**T+0 (within 5 minutes):**

1. Mark the workspace in a `degraded` state in the audit log so
   the on-call timeline captures the decision.
2. Call `secretStore.rotate({ purpose: 'capability-signing' })`.
   This:
   - Generates a new 32-byte secret.
   - Marks the new key as the active capability-signing key.
   - Retires the previous key with `retiredAt = now`.
   - Writes the new state to the file-backed store (atomic rename,
     mode `0o600`).
3. The new active key id is logged to the audit log entry
   `policy.key.rotate`. The control plane reads this and tells
   every in-process issuer to refresh.
4. **Do not** call `forgetKey` on the compromised key yet. The
   grace window keeps in-flight tokens verifiable while the
   rotation propagates.

**T+5 (within the 1h grace window):**

5. Every agent that was holding a token signed by the old key
   refreshes it. The control plane can also invalidate live
   sessions: `session.kill({ sessionId, reason:
   'capability_key_rotated' })`.
6. Watch the `verify` call audit entries for the `key_retired`
   rejection code. If any in-flight call is rejected with
   `key_retired` before the grace window elapses, the rotation is
   not complete — re-run `rotate` to push the grace window.

**T+1h (after the grace window elapses):**

7. `secretStore.forgetKey(oldKeyId)`. The key is now unknown to
   the verifier; any token signed by it is rejected as
   `token_unknown_key`. This is the hard cut-off.
8. The audit log entry `policy.key.forget` is written. The on-call
   timeline is now closed.

## Key rotation on a schedule

The capability-signing key should be rotated every 30 days
(matching the Phase 0 default in `docs/architecture.md` §9). The
control plane schedules this:

```ts
// In the control plane's scheduler:
setInterval(() => {
  secretStore.rotate({ purpose: 'capability-signing' });
}, 30 * 24 * 60 * 60 * 1000);
```

The rotation is non-disruptive: the new key is active immediately
and tokens minted under the new key verify from the moment of
`rotate()`. The old key continues to verify for the duration of
the grace window (default 1h). After 1h the old key is rejected.

**Verification after rotation:**

- Inspect the audit log for `policy.key.rotate` entries. Each
  entry records the new key id, the old key id, and the timestamp.
- The number of `key_retired` rejections should be zero during a
  routine rotation. A non-zero count means agents did not refresh
  their tokens in time — investigate before retiring the key.

## Audit-checkpoint key rotation

The audit-checkpoint key (used by `@fagaos/core/audit/log.ts`) is
independent of the capability-signing key. Rotation ceremony:

1. Add the new key as `purpose: 'audit-checkpoint'`.
2. The audit log starts signing new checkpoints with the new
   key. Old checkpoints are still verifiable because the
   `CheckpointSigner` is pluggable.
3. After 24h (one full checkpoint cycle), retire the old key.
4. The old key is no longer used for signing but is kept for
   verification until the next rotation. Call `forgetKey` only
   after the audit log is no longer expected to be verified
   against the old key (typically: never, unless the key was
   compromised).

## Policy rollback

A published policy is the source of truth for every `decide()`.
To roll back to a previous version:

1. Find the target version id:
   `administrator.listVersions().find(v => v.state === 'superseded')`.
2. The superseded version is still in the store. Re-submit it:
   `administrator.submitForReview(targetId)` (this will fail
   because superseded versions cannot be re-submitted — see below).
3. If the engine allows it, draft a new version that mirrors the
   superseded rule set, run it through the normal
   `submitForReview → approve → publish` flow.

The reason for not allowing re-submission of a superseded version
is to keep every published version an explicit
`approve → publish` decision, with a fresh review trail. The
slightly higher cost (drafting a new version) is the price for
audit clarity.

**Fast-path rollback for a confirmed-bad rule:**

If the bad rule was just published and there is a real-time
risk, the operator can:

1. `administrator.retire(currentlyPublishedId)` — moves the live
   version to `retired`. The engine now falls back to default-deny
   (no rule set).
2. The connector gateway and desktop-bridge will start
   rejecting every call with `deny`. This is a hard stop; the
   operator should communicate it to on-call consumers.
3. The operator drafts, reviews, approves, and publishes the
   corrected rule set on the normal path.
4. The audit log entries `policy.retire` and `policy.publish`
   form a complete before/after trail.

## File-backed secret store recovery

The `FileBackedSecretStore` writes to a single JSON file under
mode `0o600`. If the file is lost or corrupted:

1. **Lost file (e.g. disk failure).** The next `rotate()` call
   creates a new file. The previous keys are unknown; any token
   signed by them is rejected as `token_unknown_key`.
2. **Corrupted file (e.g. partial write).** The constructor
   throws on the next read. The on-call engineer can:
   - Restore the file from the most recent backup. The format is
     the JSON shape shown in `docs/policy-secrets.md`.
   - If no backup is available, rotate every purpose to mint
     fresh keys and accept that all in-flight tokens are now
     invalid. The audit log records the rotation.

The file is written with `renameSync` after writing to a temp
file, so a partial write leaves the previous file intact. The
worst case is "lost file" — never "corrupted file with bad keys
served". A vault-backed `SecretStore` adapter (production) does
not have this risk because the vault is the source of truth.

## Cross-workspace token rejection

A token is bound to the `workspaceId` it was minted for. The
verifier rejects a token whose `body.workspaceId` does not match
its own. This is enforced at every verifier call, before the
policy engine is consulted.

If a token from workspace A appears in workspace B's traffic:

1. The verifier returns `code: 'token_workspace_mismatch'`.
2. The audit log records the mismatch. This is a strong indicator
   of either a misconfigured client or a deliberate cross-tenant
   attack.
3. The on-call engineer should treat this as a security incident:
   identify the source of the request, revoke the offending
   token's key (if it was minted under a workspace A key that
   was supposed to be workspace-private), and review the policy
   that allowed the cross-workspace call to reach the verifier.

## Governance workflow dead-ends

A draft that needs to be edited after `submitForReview`:

- The administrator must `review(decision: 'request_changes')` to
  return the version to `draft`, then `updateDraft` to patch it.

A draft that needs to be abandoned:

- The version is left in `draft` state. The administrator can
  optionally call `updateDraft({ rules: [] })` to mark it
  explicitly empty before letting it age out.

A version that was approved but never published:

- The version stays in `approved` indefinitely. The administrator
  can `updateDraft` (rejected — the version is approved) or
  `review(decision: 'request_changes')` (rejected — the version
  is approved, not in_review). The fix is to draft a new version
  that supersedes the approved-but-stale one.

## Health check

The control plane should expose a `/health` endpoint that returns
200 only when:

- The secret store's active capability-signing key is not
  retired.
- The policy store has a published version.
- The policy engine's `effectiveVersion()` matches the store's
  `getPublished()?.version`.

Any of these failing should page the on-call. The corresponding
component (secret store, policy store, or engine) is in a state
that should not happen in steady-state operation.

## Audit log invariants

After any recovery operation, the audit log must contain:

- `policy.key.rotate` for every key rotation
- `policy.key.forget` for every hard deletion
- `policy.publish` for every policy version that went live
- `policy.retire` for every live version that was retired
- `connector.<provider>.<operation>` entries with
  `outcome: 'deny'` and `payload.reason: 'key_retired'` for any
  in-flight calls rejected by the rotation
- `connector.<provider>.<operation>` entries with
  `outcome: 'deny'` and `payload.reason: 'token_unknown_key'`
  for any in-flight calls rejected by the forget

The on-call engineer is expected to verify these entries exist
before closing the incident.
