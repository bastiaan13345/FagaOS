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
    await expect(c.listConversations()).rejects.toMatchObject({ code: 'not_found' });
    await expect(c.sendDm()).rejects.toMatchObject({ code: 'not_found' });
  });
});
