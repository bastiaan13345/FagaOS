/**
 * Additional secret-store coverage — FileBackedSecretStore, prune,
 * and edge cases on rotate / forget.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  FileBackedSecretStore,
  InMemorySecretStore,
} from '../src/index.js';

describe('InMemorySecretStore — additional coverage', () => {
  it('rotate without a keyId generates an auto keyId', () => {
    const s = new InMemorySecretStore({ workspaceId: 'w1' });
    const k = s.rotate({ purpose: 'provider-credentials' });
    expect(k.keyId).toMatch(/^provider-credentials-/);
  });

  it('rotate with a custom keyId uses it', () => {
    const s = new InMemorySecretStore({ workspaceId: 'w1' });
    const k = s.rotate({ keyId: 'my-key-1', purpose: 'capability-signing' });
    expect(k.keyId).toBe('my-key-1');
  });

  it('forgetKey throws for an unknown keyId', () => {
    const s = new InMemorySecretStore({ workspaceId: 'w1' });
    expect(() => s.forgetKey('nope')).toThrow(/no key/);
  });

  it('retireKey throws for an unknown keyId', () => {
    const s = new InMemorySecretStore({ workspaceId: 'w1' });
    expect(() => s.retireKey('nope')).toThrow(/no key/);
  });

  it('getKey returns a defensive copy of the secret bytes', () => {
    const s = new InMemorySecretStore({ workspaceId: 'w1' });
    const k = s.rotate({ purpose: 'capability-signing' });
    const r1 = s.getKey(k.keyId);
    const r2 = s.getKey(k.keyId);
    expect(r1.secret).not.toBe(r2.secret);
    expect(r1.secret.equals(r2.secret)).toBe(true);
  });

  it('different purposes are independent', () => {
    const s = new InMemorySecretStore({ workspaceId: 'w1' });
    const a = s.rotate({ purpose: 'capability-signing' });
    const b = s.rotate({ purpose: 'audit-checkpoint' });
    expect(a.keyId).not.toBe(b.keyId);
    expect(s.getActiveKey('capability-signing')?.keyId).toBe(a.keyId);
    expect(s.getActiveKey('audit-checkpoint')?.keyId).toBe(b.keyId);
  });

  it('pruneRetired keeps keys that are still within the grace window', () => {
    let now = new Date('2025-01-01T00:00:00.000Z');
    const clock = () => now;
    const s = new InMemorySecretStore({ workspaceId: 'w1', now: clock, graceWindowMs: 60 * 60 * 1000 });
    const old = s.rotate({ purpose: 'capability-signing' });
    s.rotate({ purpose: 'capability-signing' });
    // 10 minutes later — still inside the 1h grace window.
    now = new Date('2025-01-01T00:10:00.000Z');
    const pruned = s.pruneRetired();
    expect(pruned).not.toContain(old.keyId);
    expect(() => s.getKey(old.keyId)).not.toThrow();
  });
});

describe('FileBackedSecretStore — additional coverage', () => {
  let dir: string;
  let filePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fagaos-secret-extra-'));
    filePath = join(dir, 'secrets.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('retire persists the retirement', () => {
    const s1 = new FileBackedSecretStore({ filePath, workspaceId: 'w1' });
    const k = s1.rotate({ purpose: 'capability-signing' });
    s1.retireKey(k.keyId);
    const s2 = new FileBackedSecretStore({ filePath, workspaceId: 'w1' });
    expect(s2.getKey(k.keyId).retiredAt).not.toBeNull();
  });

  it('forget persists the deletion', () => {
    const s1 = new FileBackedSecretStore({ filePath, workspaceId: 'w1' });
    const k = s1.rotate({ purpose: 'capability-signing' });
    s1.forgetKey(k.keyId);
    const s2 = new FileBackedSecretStore({ filePath, workspaceId: 'w1' });
    expect(() => s2.getKey(k.keyId)).toThrow();
  });

  it('importKey persists the import', () => {
    const secret = randomBytes(32);
    const s1 = new FileBackedSecretStore({ filePath, workspaceId: 'w1' });
    s1.importKey({ keyId: 'imported', secret, purpose: 'capability-signing' });
    const s2 = new FileBackedSecretStore({ filePath, workspaceId: 'w1' });
    const r = s2.getKey('imported');
    expect(r.secret.equals(secret)).toBe(true);
  });

  it('throws on a corrupt JSON file', () => {
    writeFileSync(filePath, '{not valid json', 'utf8');
    expect(() => new FileBackedSecretStore({ filePath, workspaceId: 'w1' })).toThrow();
  });

  it('handles an empty file as an empty store', () => {
    writeFileSync(filePath, '', 'utf8');
    const s = new FileBackedSecretStore({ filePath, workspaceId: 'w1' });
    expect(s.listKeys()).toEqual([]);
  });

  it('the file is created on first rotate', () => {
    expect(existsSync(filePath)).toBe(false);
    const s = new FileBackedSecretStore({ filePath, workspaceId: 'w1' });
    s.rotate({ purpose: 'capability-signing' });
    expect(existsSync(filePath)).toBe(true);
  });
});
