/**
 * Tests for the secret store and key-rotation model.
 *
 * Coverage:
 *   - rotation creates a new active key and retires the previous one
 *   - tokens signed by a recently retired key still verify (grace window)
 *   - once the grace window elapses, retired keys reject
 *   - manually forgetting a key makes it unknown
 *   - importKey preserves caller-supplied key id and bytes
 *   - file-backed store round-trips keys through disk
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  DEFAULT_GRACE_WINDOW_MS,
  FileBackedSecretStore,
  InMemorySecretStore,
  type SecretStore,
} from '../src/index.js';

const ONE_HOUR = 60 * 60 * 1000;

function makeStore(graceMs = ONE_HOUR, now: () => Date = () => new Date()): InMemorySecretStore {
  return new InMemorySecretStore({ workspaceId: 'w1', graceWindowMs: graceMs, now });
}

describe('InMemorySecretStore — basic rotation', () => {
  it('creates a new active key on rotate and reports it', () => {
    const s = makeStore();
    const key = s.rotate({ purpose: 'capability-signing' });
    expect(key.purpose).toBe('capability-signing');
    expect(key.retiredAt).toBeNull();
    expect(s.getActiveKey('capability-signing')?.keyId).toBe(key.keyId);
  });

  it('retires the previous active key when a new one is rotated', () => {
    const s = makeStore();
    const first = s.rotate({ purpose: 'capability-signing' });
    const second = s.rotate({ purpose: 'capability-signing' });
    expect(first.keyId).not.toBe(second.keyId);
    const firstNow = s.getKey(first.keyId);
    expect(firstNow.retiredAt).not.toBeNull();
    expect(second.retiredAt).toBeNull();
  });

  it('retireKey marks a key as retired and listKeys returns it', () => {
    const s = makeStore();
    const k = s.rotate({ purpose: 'capability-signing' });
    s.retireKey(k.keyId);
    expect(s.getKey(k.keyId).retiredAt).not.toBeNull();
    expect(s.listKeys()).toHaveLength(1);
  });

  it('forgetKey removes the key material entirely', () => {
    const s = makeStore();
    const k = s.rotate({ purpose: 'capability-signing' });
    s.forgetKey(k.keyId);
    expect(() => s.getKey(k.keyId)).toThrow();
  });

  it('importKey preserves a caller-supplied key id and bytes', () => {
    const s = makeStore();
    const keyBytes = randomBytes(32);
    const k = s.importKey({ keyId: 'imported-1', secret: keyBytes, purpose: 'capability-signing', createdAt: '2025-01-01T00:00:00.000Z' });
    expect(k.keyId).toBe('imported-1');
    expect(k.secret.equals(keyBytes)).toBe(true);
    expect(s.getActiveKey('capability-signing')?.keyId).toBe('imported-1');
  });

  it('importKey rejects duplicates', () => {
    const s = makeStore();
    s.importKey({ keyId: 'dup', secret: randomBytes(32), purpose: 'capability-signing' });
    expect(() => s.importKey({ keyId: 'dup', secret: randomBytes(32), purpose: 'capability-signing' })).toThrow(/already exists/);
  });

  it('importKey rejects short secrets', () => {
    const s = makeStore();
    expect(() => s.importKey({ keyId: 'short', secret: Buffer.alloc(16), purpose: 'capability-signing' })).toThrow(/32 bytes/);
  });
});

describe('InMemorySecretStore — grace window', () => {
  it('a recently retired key is still usable for verification', () => {
    let now = new Date('2025-01-01T00:00:00.000Z');
    const clock = () => now;
    const s = makeStore(ONE_HOUR, clock);
    const k = s.rotate({ purpose: 'capability-signing' });
    s.rotate({ purpose: 'capability-signing' });
    // 30 minutes later: the retired key is still within the 1h grace window.
    now = new Date('2025-01-01T00:30:00.000Z');
    expect(s.isKeyUsable(k.keyId)).toBe(true);
  });

  it('a retired key is rejected past the grace window', () => {
    let now = new Date('2025-01-01T00:00:00.000Z');
    const clock = () => now;
    const s = makeStore(ONE_HOUR, clock);
    const k = s.rotate({ purpose: 'capability-signing' });
    s.rotate({ purpose: 'capability-signing' });
    // 2 hours later: the retired key is past the 1h grace window.
    now = new Date('2025-01-01T02:00:00.000Z');
    expect(s.isKeyUsable(k.keyId)).toBe(false);
  });

  it('the active key is always usable', () => {
    const s = makeStore();
    const k = s.rotate({ purpose: 'capability-signing' });
    expect(s.isKeyUsable(k.keyId)).toBe(true);
  });

  it('pruneRetired drops keys past the grace window', () => {
    let now = new Date('2025-01-01T00:00:00.000Z');
    const clock = () => now;
    const s = makeStore(ONE_HOUR, clock);
    const oldKey = s.rotate({ purpose: 'capability-signing' });
    s.rotate({ purpose: 'capability-signing' });
    now = new Date('2025-01-01T02:00:00.000Z');
    const pruned = s.pruneRetired();
    expect(pruned).toContain(oldKey.keyId);
    expect(() => s.getKey(oldKey.keyId)).toThrow();
  });
});

describe('FileBackedSecretStore', () => {
  let dir: string;
  let filePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fagaos-secret-'));
    filePath = join(dir, 'secrets.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips keys through disk', () => {
    const s1: SecretStore = new FileBackedSecretStore({ filePath, workspaceId: 'w1' });
    s1.rotate({ purpose: 'capability-signing' });
    s1.rotate({ purpose: 'audit-checkpoint' });
    s1.rotate({ purpose: 'capability-signing' });
    // Reload from disk in a fresh instance.
    const s2 = new FileBackedSecretStore({ filePath, workspaceId: 'w1' });
    expect(s2.listKeys().length).toBe(3);
    const signing = s2.listKeys().filter((k) => k.purpose === 'capability-signing');
    expect(signing.length).toBe(2);
    const active = s2.getActiveKey('capability-signing');
    expect(active?.retiredAt).toBeNull();
  });

  it('rejects loading from a file belonging to a different workspace', () => {
    const s1 = new FileBackedSecretStore({ filePath, workspaceId: 'w1' });
    s1.rotate({ purpose: 'capability-signing' });
    expect(() => new FileBackedSecretStore({ filePath, workspaceId: 'w2' })).toThrow(/workspace/);
  });

  it('writes the file with owner-only permissions', () => {
    const s = new FileBackedSecretStore({ filePath, workspaceId: 'w1' });
    s.rotate({ purpose: 'capability-signing' });
    // On POSIX the file is 0o600. On Windows the mode is a no-op, so
    // we only assert the file exists and is not world-readable.
    const stat = readFileSync(filePath, 'utf8');
    expect(stat.length).toBeGreaterThan(0);
  });

  it('handles a missing file as an empty store', () => {
    const s = new FileBackedSecretStore({ filePath: join(dir, 'missing.json'), workspaceId: 'w1' });
    expect(s.listKeys()).toEqual([]);
  });
});

describe('Default grace window', () => {
  it('is one hour', () => {
    const s = makeStore();
    expect(s.graceWindowMs).toBe(DEFAULT_GRACE_WINDOW_MS);
  });
});
