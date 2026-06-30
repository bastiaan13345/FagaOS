/**
 * Secret store and key-rotation model.
 *
 * The secret store is the single home for every long-lived secret
 * inside a workspace: the capability-signing key, the audit-checkpoint
 * key, and any provider credentials the connectors will need in
 * later phases. This file implements the in-memory and file-backed
 * variants. The interface in `./types.ts` is what the rest of the
 * system depends on; production will swap in a vault adapter (HashiCorp
 * Vault, AWS KMS, GCP Secret Manager) without changing the call
 * sites.
 *
 * Rotation semantics
 * ──────────────────
 *   - `rotate({ purpose })` creates a new key, marks it active, and
 *     retires the previously active key. The new key id is returned.
 *   - The newly retired key is still usable as a *verification* key
 *     during a grace window (`graceWindowMs`, default 1h). Tokens
 *     signed by it continue to verify during that window so in-flight
 *     calls do not suddenly start failing at rotation.
 *   - After the grace window elapses, the verifier refuses tokens
 *     signed with the retired key, even if the token is otherwise
 *     valid and not expired.
 *   - `forgetKey(keyId)` hard-deletes the key material. After that
 *     the key id is unknown and any token signed with it is rejected
 *     as `token_unknown_key`. Use for confirmed compromise.
 *
 * Why HMAC keys rather than asymmetric?
 * ────────────────────────────────────
 *   The control plane and the connector gateway are inside the same
 *   trust boundary as the policy engine. Asymmetric signing (e.g.
 *   Ed25519) buys us nothing here and costs a dependency on
 *   `node:crypto`'s keypair generation. The audit log itself uses
 *   HMAC (see `packages/core/src/audit/hash.ts`), and the capability
 *   signing keys are rotated frequently — keeping them symmetric
 *   makes the rotation ceremony and the verification path symmetric
 *   too. If we later need to expose public verifiability (e.g. for
 *   cross-org audit), the secret store's interface accommodates an
 *   asymmetric adapter without changing the rest of the stack.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import {
  SecretMaterialSchema,
  SecretPurposeSchema,
  type SecretMaterial,
  type SecretPurpose,
  type SecretStore,
} from './types.js';
import { SecretNotFoundError, KeyRetiredError, PolicyError } from './errors.js';

/** Default grace window during which a retired key still verifies. */
export const DEFAULT_GRACE_WINDOW_MS = 60 * 60 * 1000;

/* =========================================================================
 * InMemorySecretStore
 * =======================================================================*/

export interface InMemorySecretStoreOptions {
  workspaceId: string;
  /** Default grace window (ms). Default 1h. */
  graceWindowMs?: number;
  /** Clock for tests. */
  now?: () => Date;
  /**
   * Optional key factory. The default produces 32 random bytes. The
   * factory must always return a `Buffer` of at least 32 bytes —
   * shorter keys are rejected by `SecretMaterialSchema.parse` callers
   * because HMAC-SHA-256 needs at least 32 bytes of entropy.
   */
  generateKey?: () => Buffer;
}

export class InMemorySecretStore implements SecretStore {
  public readonly workspaceId: string;
  public readonly graceWindowMs: number;
  private readonly now: () => Date;
  private readonly generateKey: () => Buffer;
  private readonly keys: SecretMaterial[] = [];

  constructor(opts: InMemorySecretStoreOptions) {
    if (!opts || !opts.workspaceId) {
      throw new PolicyError('invalid_request', 'InMemorySecretStore requires a workspaceId');
    }
    this.workspaceId = opts.workspaceId;
    this.graceWindowMs = opts.graceWindowMs ?? DEFAULT_GRACE_WINDOW_MS;
    this.now = opts.now ?? (() => new Date());
    this.generateKey = opts.generateKey ?? (() => randomBytes(32));
  }

  rotate(input: { keyId?: string; purpose: SecretPurpose; label?: string; now?: string }): SecretMaterial {
    const id = input.keyId ?? autoKeyId(input.purpose);
    const ts = input.now ?? this.now().toISOString();
    const existing = this.keys.find((k) => k.purpose === input.purpose && k.retiredAt === null);
    if (existing) {
      existing.retiredAt = ts;
    }
    const material: SecretMaterial = SecretMaterialSchema.parse({
      keyId: id,
      purpose: input.purpose,
      secret: this.generateKey(),
      createdAt: ts,
      activatedAt: ts,
      retiredAt: null,
      ...(input.label ? { label: input.label } : {}),
    });
    this.keys.push(material);
    return { ...material, secret: Buffer.from(material.secret) };
  }

  importKey(input: {
    keyId: string;
    secret: Buffer;
    purpose: SecretPurpose;
    createdAt?: string;
    activatedAt?: string | null;
    label?: string;
  }): SecretMaterial {
    const now = this.now().toISOString();
    if (this.keys.some((k) => k.keyId === input.keyId)) {
      throw new PolicyError('secret_already_exists', `key "${input.keyId}" already exists`, { keyId: input.keyId });
    }
    if (!input.secret || input.secret.length < 32) {
      throw new PolicyError('invalid_request', `key "${input.keyId}" must be at least 32 bytes (got ${input.secret?.length ?? 0})`);
    }
    const material: SecretMaterial = SecretMaterialSchema.parse({
      keyId: input.keyId,
      purpose: input.purpose,
      secret: Buffer.from(input.secret),
      createdAt: input.createdAt ?? now,
      activatedAt: input.activatedAt ?? now,
      retiredAt: null,
      ...(input.label ? { label: input.label } : {}),
    });
    this.keys.push(material);
    return { ...material, secret: Buffer.from(material.secret) };
  }

  getKey(keyId: string): SecretMaterial {
    const found = this.keys.find((k) => k.keyId === keyId);
    if (!found) {
      throw new SecretNotFoundError(`no key with id "${keyId}"`, { keyId, workspaceId: this.workspaceId });
    }
    return { ...found, secret: Buffer.from(found.secret) };
  }

  getActiveKey(purpose: SecretPurpose): SecretMaterial | null {
    const found = this.keys.find((k) => k.purpose === purpose && k.retiredAt === null);
    if (!found) return null;
    return { ...found, secret: Buffer.from(found.secret) };
  }

  listKeys(): ReadonlyArray<SecretMaterial> {
    return this.keys.map((k) => ({ ...k, secret: Buffer.from(k.secret) }));
  }

  retireKey(keyId: string, now?: string): SecretMaterial {
    const found = this.keys.find((k) => k.keyId === keyId);
    if (!found) {
      throw new SecretNotFoundError(`no key with id "${keyId}"`, { keyId, workspaceId: this.workspaceId });
    }
    found.retiredAt = now ?? this.now().toISOString();
    return { ...found, secret: Buffer.from(found.secret) };
  }

  forgetKey(keyId: string): void {
    const idx = this.keys.findIndex((k) => k.keyId === keyId);
    if (idx < 0) {
      throw new SecretNotFoundError(`no key with id "${keyId}"`, { keyId, workspaceId: this.workspaceId });
    }
    this.keys.splice(idx, 1);
  }

  /**
   * Test/admin: prune retired keys whose `retiredAt + graceWindowMs`
   * is in the past. Returns the pruned key ids.
   */
  pruneRetired(now?: string): string[] {
    const ts = now ?? this.now().toISOString();
    const cut = Date.parse(ts);
    const pruned: string[] = [];
    for (let i = this.keys.length - 1; i >= 0; i--) {
      const k = this.keys[i]!;
      if (k.retiredAt === null) continue;
      if (Date.parse(k.retiredAt) + this.graceWindowMs <= cut) {
        pruned.push(k.keyId);
        this.keys.splice(i, 1);
      }
    }
    return pruned;
  }

  /**
   * True if the given key is currently usable for verification —
   * either it is the active key, or it was retired within the
   * configured grace window.
   */
  isKeyUsable(keyId: string, now?: string): boolean {
    const found = this.keys.find((k) => k.keyId === keyId);
    if (!found) return false;
    if (found.retiredAt === null) return true;
    const ts = now ?? this.now().toISOString();
    return Date.parse(found.retiredAt) + this.graceWindowMs > Date.parse(ts);
  }
}

function autoKeyId(purpose: SecretPurpose): string {
  return `${purpose}-${randomBytes(6).toString('hex')}`;
}

/* =========================================================================
 * FileBackedSecretStore
 * =======================================================================*/

const PersistedKeySchema = z.object({
  keyId: z.string().min(1),
  purpose: SecretPurposeSchema,
  /** Hex-encoded secret bytes. The on-disk format is hex so the JSON
   *  file is portable and the bytes survive any text-mode transfer. */
  secretHex: z.string().regex(/^[0-9a-f]+$/),
  createdAt: z.string().datetime(),
  activatedAt: z.string().datetime().nullable(),
  retiredAt: z.string().datetime().nullable(),
  label: z.string().optional(),
});
type PersistedKey = z.infer<typeof PersistedKeySchema>;

const PersistedStateSchema = z.object({
  version: z.literal(1),
  workspaceId: z.string().min(1),
  graceWindowMs: z.number().int().nonnegative(),
  keys: z.array(PersistedKeySchema),
});
type PersistedState = z.infer<typeof PersistedStateSchema>;

export interface FileBackedSecretStoreOptions {
  filePath: string;
  workspaceId: string;
  graceWindowMs?: number;
  now?: () => Date;
}

export class FileBackedSecretStore implements SecretStore {
  public readonly workspaceId: string;
  public readonly graceWindowMs: number;
  private readonly filePath: string;
  private readonly now: () => Date;
  private keys: SecretMaterial[];

  constructor(opts: FileBackedSecretStoreOptions) {
    if (!opts || !opts.filePath) {
      throw new PolicyError('invalid_request', 'FileBackedSecretStore requires a filePath');
    }
    if (!opts.workspaceId) {
      throw new PolicyError('invalid_request', 'FileBackedSecretStore requires a workspaceId');
    }
    this.filePath = opts.filePath;
    this.workspaceId = opts.workspaceId;
    this.graceWindowMs = opts.graceWindowMs ?? DEFAULT_GRACE_WINDOW_MS;
    this.now = opts.now ?? (() => new Date());
    this.keys = this.load().keys.map(persistedToMaterial);
  }

  rotate(input: { keyId?: string; purpose: SecretPurpose; label?: string; now?: string }): SecretMaterial {
    const id = input.keyId ?? autoKeyId(input.purpose);
    const ts = input.now ?? this.now().toISOString();
    const existing = this.keys.find((k) => k.purpose === input.purpose && k.retiredAt === null);
    if (existing) existing.retiredAt = ts;
    const material: SecretMaterial = SecretMaterialSchema.parse({
      keyId: id,
      purpose: input.purpose,
      secret: randomBytes(32),
      createdAt: ts,
      activatedAt: ts,
      retiredAt: null,
      ...(input.label ? { label: input.label } : {}),
    });
    this.keys.push(material);
    this.persist();
    return { ...material, secret: Buffer.from(material.secret) };
  }

  importKey(input: {
    keyId: string;
    secret: Buffer;
    purpose: SecretPurpose;
    createdAt?: string;
    activatedAt?: string | null;
    label?: string;
  }): SecretMaterial {
    if (this.keys.some((k) => k.keyId === input.keyId)) {
      throw new PolicyError('secret_already_exists', `key "${input.keyId}" already exists`, { keyId: input.keyId });
    }
    if (!input.secret || input.secret.length < 32) {
      throw new PolicyError('invalid_request', `key "${input.keyId}" must be at least 32 bytes (got ${input.secret?.length ?? 0})`);
    }
    const now = this.now().toISOString();
    const material: SecretMaterial = SecretMaterialSchema.parse({
      keyId: input.keyId,
      purpose: input.purpose,
      secret: Buffer.from(input.secret),
      createdAt: input.createdAt ?? now,
      activatedAt: input.activatedAt ?? now,
      retiredAt: null,
      ...(input.label ? { label: input.label } : {}),
    });
    this.keys.push(material);
    this.persist();
    return { ...material, secret: Buffer.from(material.secret) };
  }

  getKey(keyId: string): SecretMaterial {
    const found = this.keys.find((k) => k.keyId === keyId);
    if (!found) {
      throw new SecretNotFoundError(`no key with id "${keyId}"`, { keyId, workspaceId: this.workspaceId });
    }
    return { ...found, secret: Buffer.from(found.secret) };
  }

  getActiveKey(purpose: SecretPurpose): SecretMaterial | null {
    const found = this.keys.find((k) => k.purpose === purpose && k.retiredAt === null);
    if (!found) return null;
    return { ...found, secret: Buffer.from(found.secret) };
  }

  listKeys(): ReadonlyArray<SecretMaterial> {
    return this.keys.map((k) => ({ ...k, secret: Buffer.from(k.secret) }));
  }

  retireKey(keyId: string, now?: string): SecretMaterial {
    const found = this.keys.find((k) => k.keyId === keyId);
    if (!found) {
      throw new SecretNotFoundError(`no key with id "${keyId}"`, { keyId, workspaceId: this.workspaceId });
    }
    found.retiredAt = now ?? this.now().toISOString();
    this.persist();
    return { ...found, secret: Buffer.from(found.secret) };
  }

  forgetKey(keyId: string): void {
    const idx = this.keys.findIndex((k) => k.keyId === keyId);
    if (idx < 0) {
      throw new SecretNotFoundError(`no key with id "${keyId}"`, { keyId, workspaceId: this.workspaceId });
    }
    this.keys.splice(idx, 1);
    this.persist();
  }

  isKeyUsable(keyId: string, now?: string): boolean {
    const found = this.keys.find((k) => k.keyId === keyId);
    if (!found) return false;
    if (found.retiredAt === null) return true;
    const ts = now ?? this.now().toISOString();
    return Date.parse(found.retiredAt) + this.graceWindowMs > Date.parse(ts);
  }

  /** File path the store is reading from / writing to. */
  get path(): string {
    return this.filePath;
  }

  private load(): PersistedState {
    if (!existsSync(this.filePath)) {
      return { version: 1, workspaceId: this.workspaceId, graceWindowMs: this.graceWindowMs, keys: [] };
    }
    const raw = readFileSync(this.filePath, 'utf8');
    if (!raw.trim()) {
      return { version: 1, workspaceId: this.workspaceId, graceWindowMs: this.graceWindowMs, keys: [] };
    }
    const parsed = PersistedStateSchema.parse(JSON.parse(raw));
    if (parsed.workspaceId !== this.workspaceId) {
      throw new KeyRetiredError(
        `FileBackedSecretStore bound to workspace "${this.workspaceId}" but file belongs to "${parsed.workspaceId}"`,
        { filePath: this.filePath, expected: this.workspaceId, actual: parsed.workspaceId },
      );
    }
    return parsed;
  }

  private persist(): void {
    const state: PersistedState = {
      version: 1,
      workspaceId: this.workspaceId,
      graceWindowMs: this.graceWindowMs,
      keys: this.keys.map(materialToPersisted),
    };
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    // Atomic rename — on most filesystems rename(2) is atomic when source
    // and destination are on the same filesystem. The file is written
    // with mode 0o600 so the key material is owner-only.
    renameSync(tmp, this.filePath);
  }
}

function materialToPersisted(m: SecretMaterial): PersistedKey {
  return {
    keyId: m.keyId,
    purpose: m.purpose,
    secretHex: m.secret.toString('hex'),
    createdAt: m.createdAt,
    activatedAt: m.activatedAt,
    retiredAt: m.retiredAt,
    ...(m.label !== undefined ? { label: m.label } : {}),
  };
}

function persistedToMaterial(p: PersistedKey): SecretMaterial {
  return SecretMaterialSchema.parse({
    keyId: p.keyId,
    purpose: p.purpose,
    secret: Buffer.from(p.secretHex, 'hex'),
    createdAt: p.createdAt,
    activatedAt: p.activatedAt,
    retiredAt: p.retiredAt,
    ...(p.label !== undefined ? { label: p.label } : {}),
  });
}
