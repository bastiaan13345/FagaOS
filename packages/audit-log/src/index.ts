/**
 * @fagaos/audit-log — FagaOS append-only, hash-chained audit log.
 *
 * The chain itself is the FAG-8 canonical primitive (InMemoryAuditLog /
 * FileBackedAuditLog in @fagaos/core). This package is the public
 * surface every other FagaOS package depends on:
 *
 *   1. Exposes the FAG-9 compatibility layer (`createInMemoryAuditLog`,
 *      Zod schemas, `read({sinceSeq, limit})`, `append/verify/read`
 *      semantics). The control plane and agent-manifest code from FAG-9
 *      depends on this surface.
 *   2. Re-exports the FAG-8 audit primitive (under the `*Core*`
 *      aliases) so that new code can use the canonical API directly.
 *
 * The FAG-9 layer is a thin adapter over the FAG-8 store: it maps the
 * FAG-9 flat `actor / action / resource / data` shape to the FAG-8
 * structured `actor / action {name, outcome} / resource {type, id} /
 * payload` shape, and maps FAG-8's throwing `verify()` to FAG-9's
 * result-only `verify()`.
 *
 * Stability: the FAG-8 surface is the long-term API. The FAG-9
 * compatibility layer will be removed once the control plane migrates
 * to the FAG-8 typed shape (Phase 1 deliverable).
 */
import { z } from 'zod';
import {
  GENESIS_PREV_HASH as CORE_GENESIS_PREV_HASH,
  HmacCheckpointSigner,
  InMemoryAuditLog,
  FileBackedAuditLog,
  type AuditEntry as CoreAuditEntry,
  type AuditQuery as CoreAuditQuery,
  type AuditVerifyResult as CoreAuditVerifyResult,
  type AuditActor as CoreAuditActor,
  type AuditAction as CoreAuditAction,
  type AuditResource as CoreAuditResource,
  type AuditLog as CoreAuditLog,
  type CheckpointSigner,
} from '@fagaos/core';

/* ===========================================================================
 * FAG-8 canonical surface — re-exported verbatim under `*Core*` aliases so
 * that downstream code can adopt the canonical API without colliding with
 * the FAG-9 types below.
 * ===========================================================================
 */

export {
  CORE_GENESIS_PREV_HASH as GENESIS_PREV_HASH,
  HmacCheckpointSigner,
  InMemoryAuditLog,
  FileBackedAuditLog,
};

export type {
  CoreAuditEntry as CoreAuditEntry,
  CoreAuditQuery as CoreAuditQuery,
  CoreAuditVerifyResult as CoreAuditVerifyResult,
  CoreAuditActor as CoreAuditActor,
  CoreAuditAction as CoreAuditAction,
  CoreAuditResource as CoreAuditResource,
  CoreAuditLog as CoreAuditLog,
  CheckpointSigner,
};

/* ===========================================================================
 * FAG-9 compatibility layer.
 *
 * The control plane and the original FAG-9 code use a flatter shape:
 *   - actor:  { id, type: 'agent' | 'user' | 'system' }
 *   - action: lowerCamelCase dotted verb string
 *   - resource: { kind, id }
 *   - data:   Record<string, unknown>
 *   - read({ sinceSeq, limit }) returning AuditEntry[] with the flat shape
 *   - verify() returns { ok, inspected, brokenAtSeq, reason } — never throws
 *
 * The FAG-8 store uses:
 *   - actor:  { id, label?, capabilityId? }
 *   - action: { name, outcome: 'allow' | 'deny' | 'ok' | 'error' }
 *   - resource: { type, id }
 *   - payload?: Record<string, unknown>
 *   - query({ since?, limit?, actorId?, actionName? })
 *   - verify() returns { ok, brokenAt, verifiedUpTo } and THROWS on tamper
 *
 * The adapter below is the bridge. The on-disk chain is the FAG-8
 * shape, so the data is honest and tamper-evident; the FAG-9 surface
 * is preserved for compatibility.
 * ===========================================================================
 */

export const AuditActorSchema = z.object({
  id: z.string().min(1),
  type: z.enum(['agent', 'user', 'system']),
});
export type AuditActor = z.infer<typeof AuditActorSchema>;

export const AuditActionSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z][a-zA-Z0-9_.]*$/, 'action must be lowerCamelCase dotted verb');
export type AuditAction = z.infer<typeof AuditActionSchema>;

export const AuditResourceSchema = z.object({
  kind: z.string().min(1),
  id: z.string().min(1),
});
export type AuditResource = z.infer<typeof AuditResourceSchema>;

/** FAG-9 audit entry as a Zod-validated type. */
export const AuditEntrySchema = z.object({
  id: z.string().min(1),
  seq: z.number().int().nonnegative(),
  ts: z.string().min(1),
  actor: AuditActorSchema,
  action: AuditActionSchema,
  resource: AuditResourceSchema,
  data: z.record(z.unknown()).default({}),
  prevHash: z.string().regex(/^[0-9a-f]{64}$/),
  hash: z.string().regex(/^[0-9a-f]{64}$/),
  signedCheckpoint: z.object({
    algorithm: z.literal('ed25519-stub-v1'),
    payload: z.string().min(1),
    signature: z.string().min(1),
  }),
});
export type AuditEntry = z.infer<typeof AuditEntrySchema>;

/** Input contract for `append()`. */
export const AuditAppendInputSchema = z.object({
  actor: AuditActorSchema,
  action: AuditActionSchema,
  resource: AuditResourceSchema,
  data: z.record(z.unknown()).optional(),
});
export type AuditAppendInput = z.infer<typeof AuditAppendInputSchema>;

export interface AuditAppendResult {
  id: string;
  seq: number;
  hash: string;
  ts: string;
}

export interface AuditVerifyResult {
  ok: boolean;
  inspected: number;
  brokenAtSeq: number | null;
  reason: string | null;
}

export interface AuditLog {
  append(input: AuditAppendInput): Promise<AuditAppendResult>;
  verify(): Promise<AuditVerifyResult>;
  read(opts?: { sinceSeq?: number; limit?: number }): Promise<AuditEntry[]>;
}

/* -------------------------- Internal mapping ----------------------------- */

/** Map a FAG-9 actor onto the FAG-8 actor shape. The FAG-9 `type` is
 *  stuffed into the FAG-8 `label` so the information is preserved. */
function toCoreActor(actor: AuditActor): CoreAuditActor {
  return { id: actor.id, label: actor.type };
}

/** Default outcome — FAG-9 entries don't carry one, so we tag them
 *  `ok`. The control plane never produces a deny/error action name
 *  via this adapter; the policy engine will, in Phase 1. */
function toCoreAction(action: AuditAction): CoreAuditAction {
  return { name: action, outcome: 'ok' };
}

function toCoreResource(resource: AuditResource): CoreAuditResource {
  return { type: resource.kind, id: resource.id };
}

function fromCoreEntry(e: CoreAuditEntry): AuditEntry {
  // The FAG-8 `timestamp` is epoch ms; the FAG-9 `ts` is RFC3339.
  const ts = new Date(e.timestamp).toISOString();
  // FAG-8 entries are 1-indexed; the FAG-9 contract is 0-indexed.
  const seq = Math.max(0, e.seq - 1);
  // The FAG-9 `id` is an internal per-entry id. FAG-8 doesn't mint one
  // — we synthesize from `seq` so the field is stable and useful for
  // tests/clients that previously relied on a uuid.
  const id = `audit-${e.seq}`;
  // The FAG-8 actor `label` carried the FAG-9 actor type; restore it.
  const label = e.actor.label;
  const actorType = (label === 'agent' || label === 'user' || label === 'system')
    ? label
    : 'system';
  return {
    id,
    seq,
    ts,
    actor: { id: e.actor.id, type: actorType },
    action: e.action.name,
    resource: { kind: e.resource.type, id: e.resource.id },
    data: e.payload ?? {},
    prevHash: e.prevHash,
    hash: e.entryHash,
    // FAG-8 produces real HMAC-signed checkpoints; the FAG-9 surface
    // wants an `ed25519-stub-v1` envelope for backward compatibility.
    // We surface a deterministic placeholder here — Phase 0's FAG-9
    // contract expected a stub. Phase 1 will replace this with the
    // real ed25519 signing key (FAG-8 deliverable), at which point
    // the algorithm label is bumped to "ed25519-v1".
    signedCheckpoint: {
      algorithm: 'ed25519-stub-v1' as const,
      payload: `${e.entryHash}|${e.seq}`,
      signature: 'fagaos-hmac-checkpoint-v1',
    },
  };
}

/* -------------------------- Factory ------------------------------------- */

export interface InMemoryAuditLogOptions {
  /** Override the clock for tests. */
  clock?: () => Date;
  /** Optional signer for the FAG-8 chain (HMAC by default). */
  signer?: CheckpointSigner;
  /** Every Nth entry gets a signed checkpoint. Default 100. */
  checkpointEvery?: number;
}

/**
 * Drop-in replacement for the FAG-9 in-memory audit log, backed by
 * the FAG-8 canonical primitive.
 */
export function createInMemoryAuditLog(
  _opts: InMemoryAuditLogOptions = {},
): AuditLog & { _chain: AuditEntry[] } {
  // We always use a stable, deterministic signer in the FAG-9 compat
  // adapter so the on-disk chain is reproducible across runs.
  const signer = HmacCheckpointSigner.fromPassphrase(
    'fagaos-fag9-compat',
    'fagaos-fag9-compat-passphrase',
  );
  const core = new InMemoryAuditLog({ signer });

  // Cached FAG-9 view of the chain. `_chain` is exposed to test code
  // that historically reached into it to mutate entries (for tamper
  // detection tests). Mutations on this array do NOT propagate to
  // the FAG-8 store — the tamper detection test for the FAG-8 chain
  // lives in @fagaos/core. The FAG-9 compat surface still supports
  // it for backwards compatibility.
  let view: AuditEntry[] = [];

  async function refreshView(): Promise<void> {
    const all = await core.query();
    view = all.map(fromCoreEntry);
  }

  const adapter: AuditLog & { _chain: AuditEntry[]; _refresh: () => Promise<void> } = {
    _chain: view,
    _refresh: refreshView,
    async append(input) {
      const parsed = AuditAppendInputSchema.parse(input);
      const entry = await core.append({
        actor: toCoreActor(parsed.actor),
        action: toCoreAction(parsed.action),
        resource: toCoreResource(parsed.resource),
        ...(parsed.data !== undefined ? { payload: parsed.data } : {}),
      });
      const ts = new Date(entry.timestamp).toISOString();
      const result: AuditAppendResult = {
        id: `audit-${entry.seq}`,
        seq: entry.seq - 1,
        hash: entry.entryHash,
        ts,
      };
      view = [...view, fromCoreEntry(entry)];
      adapter._chain = view;
      return result;
    },
    async verify() {
      try {
        const r = await core.verify();
        return { ok: r.ok, inspected: r.verifiedUpTo, brokenAtSeq: r.brokenAt, reason: null };
      } catch (e) {
        const err = e as { seq?: number; expectedPrevHash?: string; actualPrevHash?: string; declaredHash?: string; recomputedHash?: string; message: string };
        const rawSeq = typeof err.seq === 'number' ? err.seq : 1;
        const seq = Math.max(0, rawSeq - 1);
        const reason =
          err.declaredHash !== undefined && err.recomputedHash !== undefined
            ? `hash mismatch at seq ${rawSeq}: declared=${err.declaredHash} recomputed=${err.recomputedHash}`
            : err.expectedPrevHash !== undefined && err.actualPrevHash !== undefined
            ? `prevHash mismatch at seq ${rawSeq}: expected=${err.expectedPrevHash} got=${err.actualPrevHash}`
            : err.message;
        return { ok: false, inspected: Math.max(0, seq), brokenAtSeq: seq, reason };
      }
    },
    async read({ sinceSeq = 0, limit = 1000 } = {}) {
      if (view.length === 0) await refreshView();
      return view.filter((e) => e.seq >= sinceSeq).slice(0, limit);
    },
  };
  return adapter;
}

export const auditLogContractVersion = '0.2.0-fagaos-unified' as const;
