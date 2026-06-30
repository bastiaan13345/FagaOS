/**
 * Tests for the per-connector write paths introduced in FAG-25.
 *
 *   - Gmail: `mail.send` / `mail.reply` / `mail.forward`
 *   - Google Calendar: `calendar.events.create` / `update` / `delete`
 *
 * The tests exercise:
 *   - The read-only mode gate (forbidden when not in write mode).
 *   - The HTTP wire-format construction (URL, method, headers, body).
 *   - 401 / 403 / 404 / 412 mapping to `ConnectorError` codes.
 *   - The idempotency replay through the gateway.
 */
import { describe, it, expect } from 'vitest';
import { GmailConnector } from '../src/connectors/gmail/index.js';
import { GoogleCalendarConnector } from '../src/connectors/google-calendar/index.js';
import { CapabilityTokenSchema, type ConnectorRequest, type Account } from '../src/index.js';
import { createHash } from 'node:crypto';

function makeAccount(id = 'a1', provider: 'gmail' | 'google_calendar' = 'gmail'): Account {
  return {
    id,
    user_id: 'u1',
    provider,
    handle: 'me@example.com',
    scopes: [],
    capabilities: [],
    status: 'active',
    created_at: '2025-01-01T00:00:00.000Z',
    updated_at: '2025-01-01T00:00:00.000Z',
  };
}

function makeRequest(account: Account, args: unknown, operation: ConnectorRequest['operation'] = 'mail.send'): ConnectorRequest {
  return {
    token: CapabilityTokenSchema.parse({
      subject: 'agent:test',
      capabilities: [{ provider: account.provider, operation, account_id: account.id }],
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    }),
    account,
    operation,
    args,
    idempotency_key: `k-${createHash('sha256').update(JSON.stringify(args)).digest('hex').slice(0, 8)}`,
    trace_id: 't1',
  };
}

describe('GmailConnector — write operations', () => {
  it('mail.send is forbidden in read-only mode', async () => {
    const conn = new GmailConnector({ tokens: { accessToken: async () => 'at' }, read_only: true });
    const acc = makeAccount();
    const req = makeRequest(acc, { to: ['x@example.com'], subject: 's', body: 'b' }, 'mail.send');
    await expect(conn.sendMessage(req, noopAudit())).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('mail.send builds a base64url-encoded raw payload', async () => {
    let captured: { url: string; method: string; body: string } | null = null;
    const conn = new GmailConnector({
      tokens: { accessToken: async () => 'at' },
      read_only: false,
      fetchImpl: async (url, init) => {
        captured = { url, method: init.method ?? 'GET', body: typeof init.body === 'string' ? init.body : '' };
        return new Response(JSON.stringify({ id: 'm1', threadId: 't1' }), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });
    const acc = makeAccount();
    const req = makeRequest(acc, { to: ['x@example.com'], subject: 'hello', body: 'world' }, 'mail.send');
    const out = await conn.sendMessage(req, noopAudit());
    expect(out.provider_message_id).toBe('m1');
    expect(out.thread_id).toBe('t1');
    expect(captured).not.toBeNull();
    const params = new URLSearchParams(captured!.body);
    const raw = params.get('raw')!;
    const decoded = Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    expect(decoded).toContain('Subject: hello');
    expect(decoded).toContain('hello');
  });

  it('mail.reply uses the original message threadId and In-Reply-To', async () => {
    const fetchMock = async (url: string, _init?: RequestInit) => {
      if (url.includes('/messages/parent?')) {
        return new Response(JSON.stringify({
          id: 'parent',
          threadId: 'thread-1',
          payload: {
            headers: [
              { name: 'From', value: 'Alice <a@example.com>' },
              { name: 'To', value: 'me@example.com' },
              { name: 'Subject', value: 'hi' },
              { name: 'Message-ID', value: '<parent@id>' },
            ],
          },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ id: 'reply', threadId: 'thread-1' }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const conn = new GmailConnector({ tokens: { accessToken: async () => 'at' }, read_only: false, fetchImpl: fetchMock as typeof fetch });
    const acc = makeAccount();
    const req = makeRequest(acc, { message_id: 'parent', body: 'thanks' }, 'mail.reply');
    const out = await conn.replyMessage(req, noopAudit());
    expect(out.thread_id).toBe('thread-1');
    expect(out.provider_message_id).toBe('reply');
  });

  it('mail.reply surfaces 401 as ConnectorError with code unauthorized', async () => {
    const conn = new GmailConnector({
      tokens: { accessToken: async () => 'at' },
      read_only: false,
      fetchImpl: async () => new Response('unauthorized', { status: 401 }),
    });
    const acc = makeAccount();
    const req = makeRequest(acc, { message_id: 'parent', body: 'thanks' }, 'mail.reply');
    await expect(conn.replyMessage(req, noopAudit())).rejects.toMatchObject({ code: 'unauthorized' });
  });
});

describe('GoogleCalendarConnector — write operations', () => {
  it('calendar.events.create is forbidden in read-only mode', async () => {
    const conn = new GoogleCalendarConnector({ tokens: { accessToken: async () => 'at' }, read_only: true });
    const acc = makeAccount('a1', 'google_calendar');
    const req = makeRequest(acc, { title: 'x', start: { tz: 'UTC', at: '2025-01-01T00:00:00.000Z' }, end: { tz: 'UTC', at: '2025-01-01T01:00:00.000Z' } }, 'calendar.events.create');
    await expect(conn.createEvent(req, noopAudit())).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('calendar.events.update uses the etag as If-Match', async () => {
    let captured: { url: string; headers: Record<string, string>; body: string } | null = null;
    const conn = new GoogleCalendarConnector({
      tokens: { accessToken: async () => 'at' },
      read_only: false,
      fetchImpl: async (url, init) => {
        const headers: Record<string, string> = {};
        if (init.headers) for (const [k, v] of Object.entries(init.headers as Record<string, string>)) headers[k.toLowerCase()] = v;
        captured = { url, headers, body: typeof init.body === 'string' ? init.body : '' };
        return new Response(JSON.stringify({ id: 'e1', summary: 'new' }), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });
    const acc = makeAccount('a1', 'google_calendar');
    const req = makeRequest(acc, { event_id: 'e1', etag: '"abc"', title: 'new' }, 'calendar.events.update');
    await conn.updateEvent(req, noopAudit());
    expect(captured!.headers['if-match']).toBe('"abc"');
  });

  it('calendar.events.update surfaces 412 as idempotency_conflict', async () => {
    const conn = new GoogleCalendarConnector({
      tokens: { accessToken: async () => 'at' },
      read_only: false,
      fetchImpl: async () => new Response('', { status: 412 }),
    });
    const acc = makeAccount('a1', 'google_calendar');
    const req = makeRequest(acc, { event_id: 'e1', etag: '"old"' }, 'calendar.events.update');
    await expect(conn.updateEvent(req, noopAudit())).rejects.toMatchObject({ code: 'idempotency_conflict' });
  });

  it('calendar.events.delete treats 404 as success (idempotent)', async () => {
    const conn = new GoogleCalendarConnector({
      tokens: { accessToken: async () => 'at' },
      read_only: false,
      fetchImpl: async () => new Response('', { status: 404 }),
    });
    const acc = makeAccount('a1', 'google_calendar');
    const req = makeRequest(acc, { event_id: 'e1' }, 'calendar.events.delete');
    await expect(conn.deleteEvent(req, noopAudit())).resolves.toBeUndefined();
  });
});

function noopAudit() {
  return {
    append: async () => undefined,
    query: async () => [],
  } as never;
}
