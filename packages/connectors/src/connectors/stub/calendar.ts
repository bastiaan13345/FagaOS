/**
 * Stub calendar connector. Mirror of `StubEmailConnector` for calendar
 * operations. Returns deterministic fixtures keyed off the account id.
 */
import { createHash } from 'node:crypto';
import type { AuditLog } from '@fagaos/core';
import { ConnectorError } from '../../errors.js';
import type {
  CalendarsListResult,
  Connector,
  ConnectorId,
  ConnectorRequest,
  DmConversationsListResult,
  DmSendResult,
  EventCreateResult,
  EventDeleteResult,
  EventGetResult,
  EventUpdateResult,
  EventsListResult,
  MailGetResult,
  MailListResult,
  MailSendResult,
} from '../../connector.js';
import { EventSchema, type Event } from '../../models/schemas.js';
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
  calendar_id: z.string().min(1).optional(),
  event_id: z.string().min(1),
});
export type EventGetArgs = z.infer<typeof EventGetArgsSchema>;

export const EventCreateArgsSchema = z.object({
  calendar_id: z.string().min(1).optional(),
  title: z.string().min(1),
  description: z.string().optional(),
  start: z.object({ tz: z.string().min(1), at: z.string().datetime() }),
  end: z.object({ tz: z.string().min(1), at: z.string().datetime() }),
  all_day: z.boolean().default(false),
  attendees: z
    .array(z.object({ address: z.string().min(1), name: z.string().optional(), optional: z.boolean().optional() }))
    .default([]),
  conference: z
    .object({ provider: z.enum(['google_meet', 'teams', 'other']), join_url: z.string().url().optional() })
    .optional(),
});
export type EventCreateArgs = z.infer<typeof EventCreateArgsSchema>;

export const EventUpdateArgsSchema = z.object({
  calendar_id: z.string().min(1).optional(),
  event_id: z.string().min(1),
  etag: z.string().min(1),
  title: z.string().min(1).optional(),
  description: z.string().optional(),
  start: z.object({ tz: z.string().min(1), at: z.string().datetime() }).optional(),
  end: z.object({ tz: z.string().min(1), at: z.string().datetime() }).optional(),
  all_day: z.boolean().optional(),
  attendees: z
    .array(z.object({ address: z.string().min(1), name: z.string().optional(), optional: z.boolean().optional() }))
    .optional(),
});
export type EventUpdateArgs = z.infer<typeof EventUpdateArgsSchema>;

export const EventDeleteArgsSchema = z.object({
  calendar_id: z.string().min(1).optional(),
  event_id: z.string().min(1),
});
export type EventDeleteArgs = z.infer<typeof EventDeleteArgsSchema>;

// Re-export the argument schemas the gateway / other connectors expect.
export { GcalCalendarsListArgsSchema, GcalEventGetArgsSchema, GcalEventsListArgsSchema } from '../google-calendar/index.js';

export class StubCalendarConnector implements Connector {
  readonly id: ConnectorId = STUB_ID;
  readonly operations = [
    'calendar.calendars.list',
    'calendar.events.list',
    'calendar.events.get',
    'calendar.events.create',
    'calendar.events.update',
    'calendar.events.delete',
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
    const args = EventGetArgsSchema.parse(request.args);
    const calendar = fakeCalendar(request.account);
    return { event: fakeEvent(request.account, calendar, stableIndex(args.event_id, 0, 4)) };
  }

  async createEvent(
    request: ConnectorRequest<EventCreateArgs>,
    _audit: AuditLog,
  ): Promise<EventCreateResult> {
    const args = EventCreateArgsSchema.parse(request.args);
    const calendar = fakeCalendar(request.account);
    const id = `stub-event-${request.account.id}-${createHash('sha256')
      .update(`${args.title}|${args.start.at}|${args.end.at}|${Date.now()}`)
      .digest('hex')
      .slice(0, 8)}`;
    const event: Event = EventSchema.parse({
      id,
      account_id: request.account.id,
      calendar_id: args.calendar_id ?? calendar.id,
      title: args.title,
      description: args.description,
      start: args.start,
      end: args.end,
      all_day: args.all_day,
      attendees: args.attendees.map((a) => ({
        contact: { address: a.address, name: a.name },
        status: 'needsAction',
        optional: a.optional ?? false,
      })),
      conference: args.conference,
      status: 'confirmed',
      provider_ref: { provider: request.account.provider, native_id: id, etag: `stub-etag-${id}` },
    });
    return { event };
  }

  async updateEvent(
    request: ConnectorRequest<EventUpdateArgs>,
    _audit: AuditLog,
  ): Promise<EventUpdateResult> {
    const args = EventUpdateArgsSchema.parse(request.args);
    const calendar = fakeCalendar(request.account);
    const existing = fakeEvent(request.account, calendar, stableIndex(args.event_id, 0, 4));
    const event: Event = EventSchema.parse({
      ...existing,
      title: args.title ?? existing.title,
      description: args.description ?? existing.description,
      start: args.start ?? existing.start,
      end: args.end ?? existing.end,
      all_day: args.all_day ?? existing.all_day,
      attendees: args.attendees
        ? args.attendees.map((a) => ({
            contact: { address: a.address, name: a.name },
            status: 'needsAction',
            optional: a.optional ?? false,
          }))
        : existing.attendees,
      provider_ref: { ...existing.provider_ref, etag: args.etag },
    });
    return { event };
  }

  async deleteEvent(
    request: ConnectorRequest<EventDeleteArgs>,
    _audit: AuditLog,
  ): Promise<EventDeleteResult> {
    EventDeleteArgsSchema.parse(request.args);
    return;
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
  async replyMessage(): Promise<never> {
    throw new ConnectorError('not_found', 'StubCalendarConnector does not implement mail operations');
  }
  async forwardMessage(): Promise<never> {
    throw new ConnectorError('not_found', 'StubCalendarConnector does not implement mail operations');
  }
  async listConversations(): Promise<DmConversationsListResult> {
    throw new ConnectorError('not_found', 'StubCalendarConnector does not implement messaging operations');
  }
  async sendDm(): Promise<DmSendResult> {
    throw new ConnectorError('not_found', 'StubCalendarConnector does not implement messaging operations');
  }
}

function stableIndex(input: string, lo: number, hi: number): number {
  const h = createHash('sha256').update(input).digest();
  const v = h.readUInt32BE(0);
  return lo + (v % (hi - lo + 1));
}
