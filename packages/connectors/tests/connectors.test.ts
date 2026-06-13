/**
 * Connector (gmail / google-calendar) component tests.
 *
 * Each test injects a `fetch` stub that returns canned provider
 * responses; the connector is exercised end-to-end up to the
 * `globalThis.fetch` boundary.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  GmailConnector,
  GoogleCalendarConnector,
  type GoogleTokenProvider,
} from '../src/index.js';

const tokens: GoogleTokenProvider = {
  accessToken: async () => 'test-token',
};

function makeResponse(body: unknown, init: { status?: number } = {}): Response {
  const status = init.status ?? 200;
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('GmailConnector — listMessages', () => {
  it('lists messages and normalises each one', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const u = url.toString();
      if (u.includes('/users/me/messages?') || u.endsWith('/users/me/messages') || u.includes('maxResults')) {
        return makeResponse({ messages: [{ id: 'm1', threadId: 't1' }] });
      }
      if (u.includes('/users/me/messages/m1')) {
        return makeResponse({
          id: 'm1',
          threadId: 't1',
          labelIds: ['INBOX', 'UNREAD'],
          internalDate: String(Date.parse('2025-01-01T10:00:00Z')),
          payload: {
            headers: [
              { name: 'From', value: 'Alice <a@example.com>' },
              { name: 'To', value: 'me@example.com' },
              { name: 'Subject', value: 'Hi' },
              { name: 'Date', value: 'Wed, 01 Jan 2025 10:00:00 +0000' },
            ],
            body: { data: Buffer.from('Hello, world.').toString('base64') },
          },
        });
      }
      return makeResponse({ error: 'not found' }, { status: 404 });
    });
    const connector = new GmailConnector({ tokens, fetchImpl: fetchImpl as unknown as typeof fetch, read_only: true });
    const account = {
      id: 'a1',
      user_id: 'u1',
      provider: 'gmail' as const,
      handle: 'me@example.com',
      scopes: ['gmail.readonly'],
      capabilities: ['read_mail'] as ('read_mail')[],
      status: 'active' as const,
      created_at: '2025-01-01T00:00:00Z',
      updated_at: '2025-01-01T00:00:00Z',
    };
    const result = await connector.listMessages(
      {
        token: { subject: 'agent', capabilities: [], expires_at: new Date(Date.now() + 60_000).toISOString() },
        account,
        operation: 'mail.list',
        args: { query: 'in:inbox', limit: 5 },
        idempotency_key: 'k1',
        trace_id: 't1',
      },
      {} as never,
    );
    expect(result.messages.length).toBe(1);
    expect(result.messages[0]?.subject).toBe('Hi');
    expect(result.messages[0]?.from.address).toBe('a@example.com');
    expect(result.messages[0]?.from.name).toBe('Alice');
    expect(result.messages[0]?.body_text).toBe('Hello, world.');
    expect(result.messages[0]?.status_flags.read).toBe(false);
  });

  it('refuses to send in read-only mode', async () => {
    const connector = new GmailConnector({ tokens, fetchImpl: vi.fn() as unknown as typeof fetch, read_only: true });
    await expect(
      connector.sendMessage(
        {
          token: { subject: 'a', capabilities: [], expires_at: new Date(Date.now() + 60_000).toISOString() },
          account: { id: 'a1', user_id: 'u1', provider: 'gmail', handle: 'me@x.com', scopes: [], capabilities: [], status: 'active', created_at: '', updated_at: '' },
          operation: 'mail.send',
          args: { to: ['x@example.com'], subject: 's', body: 'b' },
          idempotency_key: 'k',
          trace_id: 't',
        },
        {} as never,
      ),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });
});

describe('GmailConnector — processPubSubMessage', () => {
  it('parses a valid history notification', () => {
    const c = new GmailConnector({ tokens, fetchImpl: vi.fn() as unknown as typeof fetch });
    const data = Buffer.from(JSON.stringify({ emailAddress: 'me@example.com', historyId: '12345' })).toString('base64');
    const out = c.processPubSubMessage({ message: { data, messageId: 'm1' }, subscription: 'sub' });
    expect(out.historyId).toBe('12345');
  });

  it('rejects a malformed notification', () => {
    const c = new GmailConnector({ tokens, fetchImpl: vi.fn() as unknown as typeof fetch });
    expect(() =>
      c.processPubSubMessage({ message: { data: 'not-base64', messageId: 'm1' }, subscription: 'sub' }),
    ).toThrow();
  });
});

describe('GoogleCalendarConnector — listEvents', () => {
  it('lists events with a sync token', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request) => {
      return makeResponse({
        items: [
          {
            id: 'e1',
            status: 'confirmed',
            summary: 'Stand-up',
            start: { dateTime: '2025-01-01T10:00:00Z', timeZone: 'UTC' },
            end: { dateTime: '2025-01-01T10:30:00Z', timeZone: 'UTC' },
            attendees: [{ email: 'a@example.com', responseStatus: 'accepted' }],
            etag: 'W/"1"',
          },
        ],
        nextSyncToken: 'next-sync',
      });
    });
    const c = new GoogleCalendarConnector({ tokens, fetchImpl: fetchImpl as unknown as typeof fetch });
    const account = {
      id: 'a1',
      user_id: 'u1',
      provider: 'google_calendar' as const,
      handle: 'me@example.com',
      scopes: ['calendar.events.readonly'],
      capabilities: [] as never[],
      status: 'active' as const,
      created_at: '2025-01-01T00:00:00Z',
      updated_at: '2025-01-01T00:00:00Z',
    };
    const out = await c.listEvents(
      {
        token: { subject: 'agent', capabilities: [], expires_at: new Date(Date.now() + 60_000).toISOString() },
        account,
        operation: 'calendar.events.list',
        args: { calendar_id: 'primary', sync_token: 'old-token' },
        idempotency_key: 'k',
        trace_id: 't',
      },
      {} as never,
    );
    expect(out.next_sync_token).toBe('next-sync');
    expect(out.events[0]?.title).toBe('Stand-up');
    expect(out.events[0]?.all_day).toBe(false);
    expect(out.events[0]?.attendees[0]?.contact.address).toBe('a@example.com');
    expect(out.events[0]?.status).toBe('confirmed');
  });

  it('handles 410 GONE on a sync token by surfacing reauth_required', async () => {
    const fetchImpl = vi.fn(async () => makeResponse({ error: 'gone' }, { status: 410 }));
    const c = new GoogleCalendarConnector({ tokens, fetchImpl: fetchImpl as unknown as typeof fetch });
    const account = {
      id: 'a1', user_id: 'u1', provider: 'google_calendar' as const, handle: 'me@x.com',
      scopes: [], capabilities: [] as never[], status: 'active' as const,
      created_at: '', updated_at: '',
    };
    await expect(
      c.listEvents(
        {
          token: { subject: 'a', capabilities: [], expires_at: new Date(Date.now() + 60_000).toISOString() },
          account, operation: 'calendar.events.list',
          args: { calendar_id: 'primary', sync_token: 'old' },
          idempotency_key: 'k', trace_id: 't',
        },
        {} as never,
      ),
    ).rejects.toMatchObject({ code: 'reauth_required' });
  });
});

describe('GoogleCalendarConnector — listCalendars', () => {
  it('returns the user calendar list', async () => {
    const fetchImpl = vi.fn(async () =>
      makeResponse({
        items: [
          { id: 'primary', summary: 'Personal', primary: true, accessRole: 'owner', backgroundColor: '#ff0000' },
        ],
      }),
    );
    const c = new GoogleCalendarConnector({ tokens, fetchImpl: fetchImpl as unknown as typeof fetch });
    const account = {
      id: 'a1', user_id: 'u1', provider: 'google_calendar' as const, handle: 'me@x.com',
      scopes: [], capabilities: [] as never[], status: 'active' as const,
      created_at: '', updated_at: '',
    };
    const out = await c.listCalendars(
      {
        token: { subject: 'a', capabilities: [], expires_at: new Date(Date.now() + 60_000).toISOString() },
        account, operation: 'calendar.calendars.list', args: {},
        idempotency_key: 'k', trace_id: 't',
      },
      {} as never,
    );
    expect(out.calendars[0]?.primary).toBe(true);
    expect(out.calendars[0]?.color).toBe('#ff0000');
  });
});
