/**
 * Stub calendar connector. Mirror of `StubEmailConnector` for calendar
 * operations. Returns deterministic fixtures keyed off the account id.
 */
import type { AuditLog } from '@fagaos/core';
import { ConnectorError } from '../../errors.js';
import type {
  CalendarsListResult,
  Connector,
  ConnectorId,
  ConnectorRequest,
  DmConversationsListResult,
  DmSendResult,
  EventGetResult,
  EventsListResult,
  MailGetResult,
  MailListResult,
  MailSendResult,
} from '../../connector.js';
import type { Account } from '../../models/schemas.js';
import { z } from 'zod';
import { fakeCalendar, fakeEvent } from './email.js';

const STUB_ID: ConnectorId = 'google_calendar';

export const CalendarsListArgsSchema = z.object({}).strict();
export type CalendarsListArgs = z.infer<typeof CalendarsListArgsSchema>;

export const EventsListArgsSchema = z.object({
  calendar_id: z.string().min(1).optional(),
  time_min: z.string().datetime().optional(),
  time_max: z.string().datetime().optional(),
  limit: z.number().int().positive().max(100).default(20),
  sync_token: z.string().nullable().default(null),
});
export type EventsListArgs = z.infer<typeof EventsListArgsSchema>;

export const EventGetArgsSchema = z.object({
  event_id: z.string().min(1),
});
export type EventGetArgs = z.infer<typeof EventGetArgsSchema>;

export class StubCalendarConnector implements Connector {
  readonly id: ConnectorId = STUB_ID;
  readonly operations = [
    'calendar.calendars.list',
    'calendar.events.list',
    'calendar.events.get',
  ] as const;

  async listCalendars(
    request: ConnectorRequest<CalendarsListArgs>,
    _audit: AuditLog,
  ): Promise<CalendarsListResult> {
    CalendarsListArgsSchema.parse(request.args);
    return { calendars: [fakeCalendar(request.account)] };
  }

  async listEvents(
    request: ConnectorRequest<EventsListArgs>,
    _audit: AuditLog,
  ): Promise<EventsListResult> {
    const args = EventsListArgsSchema.parse(request.args);
    const calendar = fakeCalendar(request.account);
    const events = Array.from({ length: Math.min(args.limit, 5) }, (_, i) =>
      fakeEvent(request.account, calendar, i),
    );
    return { events, next_sync_token: `stub-sync-${request.account.id}` };
  }

  async getEvent(
    request: ConnectorRequest<EventGetArgs>,
    _audit: AuditLog,
  ): Promise<EventGetResult> {
    // Validate the args; the result is identical for every event id
    // because the stub is a fixture.
    const _args = EventGetArgsSchema.parse(request.args);
    const calendar = fakeCalendar(request.account);
    return { event: fakeEvent(request.account, calendar, 0) };
  }

  // Methods that don't apply to calendar: throw `not_found` so callers
  // get a clear error.
  async listMessages(): Promise<MailListResult> {
    throw new ConnectorError('not_found', 'StubCalendarConnector does not implement mail operations');
  }
  async getMessage(): Promise<MailGetResult> {
    throw new ConnectorError('not_found', 'StubCalendarConnector does not implement mail operations');
  }
  async sendMessage(): Promise<MailSendResult> {
    throw new ConnectorError('not_found', 'StubCalendarConnector does not implement mail operations');
  }
  async listConversations(): Promise<DmConversationsListResult> {
    throw new ConnectorError('not_found', 'StubCalendarConnector does not implement messaging operations');
  }
  async sendDm(): Promise<DmSendResult> {
    throw new ConnectorError('not_found', 'StubCalendarConnector does not implement messaging operations');
  }

  // Unused but kept for type-narrowing; the gateway never calls them.
  private _unused(_account: Account): void {
    /* intentionally empty */
  }
}
