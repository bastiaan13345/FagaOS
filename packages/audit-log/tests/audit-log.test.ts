import { describe, it, expect } from 'vitest';
import { createInMemoryAuditLog, auditLogContractVersion } from '../src/index.js';

describe('@fagaos/audit-log — FAG-9 compatibility layer over FAG-8', () => {
  it('exports a contract version', () => {
    expect(typeof auditLogContractVersion).toBe('string');
    expect(auditLogContractVersion).toMatch(/^0\./);
  });

  it('assigns monotonically increasing seq starting at 0 (FAG-9 semantics)', async () => {
    const log = createInMemoryAuditLog();
    const a = await log.append({
      actor: { id: 'agent:a', type: 'agent' },
      action: 'session.create',
      resource: { kind: 'session', id: 's1' },
    });
    const b = await log.append({
      actor: { id: 'agent:a', type: 'agent' },
      action: 'session.kill',
      resource: { kind: 'session', id: 's1' },
    });
    expect(a.seq).toBe(0);
    expect(b.seq).toBe(1);
    expect(a.hash).not.toBe(b.hash);
  });

  it('verifies a clean chain', async () => {
    const log = createInMemoryAuditLog();
    for (let i = 0; i < 5; i++) {
      await log.append({
        actor: { id: 'system:test', type: 'system' },
        action: 'noop.tick',
        resource: { kind: 'system', id: 'ticker' },
        data: { i },
      });
    }
    const result = await log.verify();
    expect(result.ok).toBe(true);
    expect(result.inspected).toBe(5);
    expect(result.brokenAtSeq).toBeNull();
  });

  it('read() returns entries ordered by seq and supports sinceSeq paging', async () => {
    const log = createInMemoryAuditLog();
    for (let i = 0; i < 5; i++) {
      await log.append({
        actor: { id: 'agent:a', type: 'agent' },
        action: 'noop.tick',
        resource: { kind: 'system', id: 't' },
        data: { i },
      });
    }
    const page = await log.read({ sinceSeq: 2, limit: 2 });
    expect(page.map((e) => e.seq)).toEqual([2, 3]);
  });

  it('rejects malformed input', async () => {
    const log = createInMemoryAuditLog();
    await expect(
      // @ts-expect-error testing runtime validation
      log.append({ actor: { id: '', type: 'agent' } }),
    ).rejects.toThrow();
  });

  it('preserves FAG-9 flat actor / action / resource / data shape', async () => {
    const log = createInMemoryAuditLog();
    await log.append({
      actor: { id: 'user:alice', type: 'user' },
      action: 'session.create',
      resource: { kind: 'session', id: 's1' },
      data: { prompt: 'hi' },
    });
    const entries = await log.read();
    expect(entries).toHaveLength(1);
    const e = entries[0]!;
    expect(e.actor).toEqual({ id: 'user:alice', type: 'user' });
    expect(typeof e.action).toBe('string');
    expect(e.action).toBe('session.create');
    expect(e.resource).toEqual({ kind: 'session', id: 's1' });
    expect(e.data).toEqual({ prompt: 'hi' });
    expect(e.ts).toMatch(/T/);
    expect(e.prevHash).toMatch(/^[0-9a-f]{64}$/);
    expect(e.hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
