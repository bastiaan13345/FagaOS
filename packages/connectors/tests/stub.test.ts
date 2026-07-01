/**
 * Stub connector tests.
 *
 * The stubs are the default Phase 1 connector; their contract is
 * "deterministic fixtures keyed by account id". The tests assert
 * that the same account always gets the same shape and that the
 * not-implemented operations fail with `not_found` rather than
 * silently returning data.
 */
import { describe, it, expect } from 'vitest';
import { StubEmailConnector, StubCalendarConnector } from '../src/index.js';
import type { Account } from '../src/index.js';

function makeAccount(provider: 'gmail' | 'google_calendar' = 'gmail'): Account {
  return {
    id: 'a1',
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

function makeToken() {
  return {
    subject: 'agent:test',
    capabilities: [],
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  };
}

function makeRequest(account: Account, operation: 'mail.send' | 'mail.reply' | 'mail.forward' | 'calendar.events.create' | 'calendar.events.update' | 'calendar.events.delete', args: unknown) {
  return {
    token: makeToken(),
    account,
    operation,
    args,
    idempotency_key: 'k',
    trace_id: 't',
  };
}

describe('StubEmailConnector', () => {
  const c = new StubEmailConnector();

  it('returns deterministic message fixtures for listMessages', async () => {
    const out1 = await c.listMessages(
      {
        token: makeToken(),
        account: makeAccount('gmail'),
        operation: 'mail.list',
        args: { query: 'in:inbox', limit: 3 },
        idempotency_key: 'k',
        trace_id: 't',
      },
      {} as never,
    );
    const out2 = await c.listMessages(
      {
        token: makeToken(),
        account: makeAccount('gmail'),
        operation: 'mail.list',
        args: { query: 'in:inbox', limit: 3 },
        idempotency_key: 'k2',
        trace_id: 't2',
      },
      {} as never,
    );
    expect(out1.messages.length).toBeGreaterThan(0);
    expect(out2.messages.length).toBe(out1.messages.length);
    expect(out1.messages[0]?.id).toBe(out2.messages[0]?.id);
  });

  it('rejects calendar-shaped operations', async () => {
    await expect(
      c.listCalendars(
        {
          token: makeToken(),
          account: makeAccount('gmail'),
          operation: 'calendar.calendars.list',
          args: {},
          idempotency_key: 'k',
          trace_id: 't',
        },
        {} as never,
      ),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('replyMessage returns a stable stub id derived from the inputs', async () => {
    const account = makeAccount('gmail');
    const out = await c.replyMessage(
      makeRequest(account, 'mail.reply', { message_id: 'm1', body: 'thanks', reply_all: true }),
      {} as never,
    );
    expect(out.provider_message_id).toMatch(/^stub-reply-/);
    expect(out.thread_id).toBe('stub-thread-m1');
  });

  it('replyMessage produces different ids for different inputs', async () => {
    const account = makeAccount('gmail');
    const a = await c.replyMessage(
      makeRequest(account, 'mail.reply', { message_id: 'm1', body: 'thanks', reply_all: false }),
      {} as never,
    );
    const b = await c.replyMessage(
      makeRequest(account, 'mail.reply', { message_id: 'm2', body: 'thanks', reply_all: false }),
      {} as never,
    );
    expect(a.provider_message_id).not.toBe(b.provider_message_id);
  });

  it('forwardMessage returns a stub id for valid forward args', async () => {
    const account = makeAccount('gmail');
    const out = await c.forwardMessage(
      makeRequest(account, 'mail.forward', { message_id: 'm1', to: ['x@example.com'], body: 'fyi' }),
      {} as never,
    );
    expect(out.provider_message_id).toMatch(/^stub-fwd-/);
  });

  it('rejects every calendar-shaped operation with not_found', async () => {
    const account = makeAccount('gmail');
    await expect(c.getEvent()).rejects.toMatchObject({ code: 'not_found' });
    await expect(c.createEvent()).rejects.toMatchObject({ code: 'not_found' });
    await expect(c.updateEvent()).rejects.toMatchObject({ code: 'not_found' });
    await expect(c.deleteEvent()).rejects.toMatchObject({ code: 'not_found' });
    await expect(c.listEvents()).rejects.toMatchObject({ code: 'not_found' });
    void account;
  });
});

describe('StubCalendarConnector', () => {
  const c = new StubCalendarConnector();

  it('returns a primary calendar and a few events', async () => {
    const cals = await c.listCalendars(
      {
        token: makeToken(),
        account: makeAccount('google_calendar'),
        operation: 'calendar.calendars.list',
        args: {},
        idempotency_key: 'k',
        trace_id: 't',
      },
      {} as never,
    );
    expect(cals.calendars.length).toBe(1);
    expect(cals.calendars[0]?.primary).toBe(true);

    const events = await c.listEvents(
      {
        token: makeToken(),
        account: makeAccount('google_calendar'),
        operation: 'calendar.events.list',
        args: { calendar_id: 'primary', limit: 3 },
        idempotency_key: 'k',
        trace_id: 't',
      },
      {} as never,
    );
    expect(events.events.length).toBeGreaterThan(0);
    expect(events.next_sync_token).toMatch(/^stub-sync-/);

    const event = await c.getEvent(
      {
        token: makeToken(),
        account: makeAccount('google_calendar'),
        operation: 'calendar.events.get',
        args: { event_id: 'evt_1' },
        idempotency_key: 'k-event',
        trace_id: 't-event',
      },
      {} as never,
    );
    expect(event.event.id).toBeTruthy();
  });

  it('createEvent returns a deterministic event with a stub id and etag', async () => {
    const account = makeAccount('google_calendar');
    const out = await c.createEvent(
      makeRequest(account, 'calendar.events.create', {
        title: 'standup',
        start: { tz: 'UTC', at: '2025-01-01T10:00:00.000Z' },
        end: { tz: 'UTC', at: '2025-01-01T11:00:00.000Z' },
        attendees: [{ address: 'x@example.com', name: 'X', optional: true }],
      }),
      {} as never,
    );
    expect(out.event.id).toMatch(/^stub-event-a1-[0-9a-f]{8}$/);
    expect(out.event.title).toBe('standup');
    expect(out.event.status).toBe('confirmed');
    expect(out.event.attendees[0]?.optional).toBe(true);
    expect(out.event.provider_ref?.etag).toMatch(/^stub-etag-stub-event-a1-/);
  });

  it('updateEvent merges args onto the existing event and stamps the new etag', async () => {
    const account = makeAccount('google_calendar');
    const out = await c.updateEvent(
      makeRequest(account, 'calendar.events.update', {
        event_id: 'evt_1',
        etag: 'new-etag',
        title: 'updated title',
        all_day: true,
      }),
      {} as never,
    );
    expect(out.event.title).toBe('updated title');
    expect(out.event.all_day).toBe(true);
    expect(out.event.provider_ref?.etag).toBe('new-etag');
  });

  it('updateEvent falls back to the existing attendees when none are supplied', async () => {
    const account = makeAccount('google_calendar');
    const out = await c.updateEvent(
      makeRequest(account, 'calendar.events.update', {
        event_id: 'evt_1',
        etag: 'new-etag',
      }),
      {} as never,
    );
    // The existing event's attendees array should be preserved.
    expect(out.event.attendees.length).toBeGreaterThan(0);
    expect(out.event.provider_ref?.etag).toBe('new-etag');
  });

  it('deleteEvent resolves with no value', async () => {
    const account = makeAccount('google_calendar');
    await expect(
      c.deleteEvent(
        makeRequest(account, 'calendar.events.delete', { event_id: 'evt_1' }),
        {} as never,
      ),
    ).resolves.toBeUndefined();
  });

  it('rejects mail-shaped operations', async () => {
    await expect(
      c.listMessages(
        {
          token: makeToken(),
          account: makeAccount('google_calendar'),
          operation: 'mail.list',
          args: {},
          idempotency_key: 'k',
          trace_id: 't',
        },
        {} as never,
      ),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(c.getMessage()).rejects.toMatchObject({ code: 'not_found' });
    await expect(c.sendMessage()).rejects.toMatchObject({ code: 'not_found' });
    await expect(c.replyMessage()).rejects.toMatchObject({ code: 'not_found' });
    await expect(c.forwardMessage()).rejects.toMatchObject({ code: 'not_found' });
    await expect(c.listConversations()).rejects.toMatchObject({ code: 'not_found' });
    await expect(c.sendDm()).rejects.toMatchObject({ code: 'not_found' });
  });
});
