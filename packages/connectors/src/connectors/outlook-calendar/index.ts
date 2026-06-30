/**
 * Outlook Calendar connector (Microsoft Graph).
 *
 * Implements the normalised calendar surface against the Microsoft
 * Graph endpoint:
 *   - calendar.calendars.list → GET /me/calendars
 *   - calendar.events.list    → GET /me/events with deltaToken
 *   - calendar.events.get     → GET /me/events/{id}
 *   - calendar.events.create  → POST /me/events
 *   - calendar.events.update  → PATCH /me/events/{id}
 *   - calendar.events.delete  → DELETE /me/events/{id}
 *
 * Delta sync: Graph provides delta queries (`/me/events/delta`) that
 * return a `deltaLink` we treat as the `next_sync_token`. The
 * connector wraps the delta query transparently for the agent.
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
  EventCreateResult,
  EventDeleteResult,
  EventGetResult,
  EventUpdateResult,
  EventsListResult,
  MailGetResult,
  MailListResult,
  MailSendResult,
} from '../../connector.js';
import {
  CalendarSchema,
  EventSchema,
  type Calendar,
  type Event,
} from '../../models/schemas.js';
import { z } from 'zod';
import type { GraphTokenProvider } from '../outlook/token-provider.js';
import {
  EventCreateArgsSchema,
  EventDeleteArgsSchema,
  EventUpdateArgsSchema,
  GcalCalendarsListArgsSchema,
  GcalEventGetArgsSchema,
  GcalEventsListArgsSchema,
} from '../google-calendar/index.js';

const GRAPH_API = 'https://graph.microsoft.com/v1.0';

export interface OutlookCalendarConnectorOptions {
  tokens: GraphTokenProvider;
  fetchImpl?: typeof fetch;
  api_base?: string;
  read_only?: boolean;
}

export const OutlookEventCreateArgsSchema = EventCreateArgsSchema;
export const OutlookEventUpdateArgsSchema = EventUpdateArgsSchema;
export const OutlookEventDeleteArgsSchema = EventDeleteArgsSchema;

export class OutlookCalendarConnector implements Connector {
  readonly id: ConnectorId = 'outlook_calendar';
  readonly operations = [
    'calendar.calendars.list',
    'calendar.events.list',
    'calendar.events.get',
    'calendar.events.create',
    'calendar.events.update',
    'calendar.events.delete',
  ] as const;

  private readonly tokens: GraphTokenProvider;
  private readonly fetchImpl: typeof fetch;
  private readonly apiBase: string;
  private readonly readOnly: boolean;

  constructor(opts: OutlookCalendarConnectorOptions) {
    this.tokens = opts.tokens;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.apiBase = opts.api_base ?? GRAPH_API;
    this.readOnly = opts.read_only ?? true;
  }

  async listCalendars(request: ConnectorRequest, _audit: AuditLog): Promise<CalendarsListResult> {
    GcalCalendarsListArgsSchema.parse(request.args);
    const token = await this.tokens.accessToken({ account_id: request.account.id, scopes: ['Calendars.Read'] });
    const out = await this.graphGet<GraphListResponse<GraphCalendar>>(`${this.apiBase}/me/calendars`, token);
    return { calendars: (out.value ?? []).map((c) => this.normaliseCalendar(request.account.id, c)) };
  }

  async listEvents(request: ConnectorRequest, _audit: AuditLog): Promise<EventsListResult> {
    const args = GcalEventsListArgsSchema.parse(request.args);
    const token = await this.tokens.accessToken({ account_id: request.account.id, scopes: ['Calendars.Read'] });
    const url = new URL(args.sync_token ?? `${this.apiBase}/me/events/delta`);
    if (!args.sync_token) {
      if (args.time_min) url.searchParams.set('startDateTime', args.time_min);
      if (args.time_max) url.searchParams.set('endDateTime', args.time_max);
      url.searchParams.set('$top', String(args.limit));
    }
    const out = await this.graphGet<GraphListResponse<GraphEvent>>(url.toString(), token);
    const events: Event[] = (out.value ?? []).map((e) => this.normaliseEvent(request.account.id, e));
    const next = out['@odata.nextLink'] ?? out['@odata.deltaLink'] ?? null;
    return { events, next_sync_token: next };
  }

  async getEvent(request: ConnectorRequest, _audit: AuditLog): Promise<EventGetResult> {
    const args = GcalEventGetArgsSchema.parse(request.args);
    const token = await this.tokens.accessToken({ account_id: request.account.id, scopes: ['Calendars.Read'] });
    const out = await this.graphGet<GraphEvent>(`${this.apiBase}/me/events/${encodeURIComponent(args.event_id)}`, token);
    return { event: this.normaliseEvent(request.account.id, out) };
  }

  async createEvent(request: ConnectorRequest, _audit: AuditLog): Promise<EventCreateResult> {
    if (this.readOnly) {
      throw new ConnectorError('forbidden', 'OutlookCalendarConnector is in read-only mode for this build');
    }
    const args = OutlookEventCreateArgsSchema.parse(request.args);
    const token = await this.tokens.accessToken({ account_id: request.account.id, scopes: ['Calendars.ReadWrite'] });
    const res = await this.fetchImpl(`${this.apiBase}/me/events`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', prefer: 'outlook.timezone="UTC"' },
      body: JSON.stringify({
        subject: args.title,
        body: { contentType: 'HTML', content: args.description ?? '' },
        start: toGraphDateTime(args.start, args.all_day ?? false),
        end: toGraphDateTime(args.end, args.all_day ?? false),
        isAllDay: args.all_day ?? false,
        attendees: (args.attendees ?? []).map((a) => ({
          emailAddress: { address: a.address, name: a.name },
          type: a.optional ? 'optional' : 'required',
        })),
      }),
    });
    if (!res.ok) {
      throw new ConnectorError('provider_error', `graph event create failed: ${res.status} ${res.statusText}`, await safeText(res));
    }
    const out = (await res.json()) as GraphEvent;
    return { event: this.normaliseEvent(request.account.id, out) };
  }

  async updateEvent(request: ConnectorRequest, _audit: AuditLog): Promise<EventUpdateResult> {
    if (this.readOnly) {
      throw new ConnectorError('forbidden', 'OutlookCalendarConnector is in read-only mode for this build');
    }
    const args = OutlookEventUpdateArgsSchema.parse(request.args);
    const token = await this.tokens.accessToken({ account_id: request.account.id, scopes: ['Calendars.ReadWrite'] });
    const body: Record<string, unknown> = {};
    if (args.title !== undefined) body['subject'] = args.title;
    if (args.description !== undefined) body['body'] = { contentType: 'HTML', content: args.description };
    if (args.start) body['start'] = toGraphDateTime(args.start, args.all_day ?? false);
    if (args.end) body['end'] = toGraphDateTime(args.end, args.all_day ?? false);
    if (args.attendees) {
      body['attendees'] = args.attendees.map((a) => ({
        emailAddress: { address: a.address, name: a.name },
        type: a.optional ? 'optional' : 'required',
      }));
    }
    const res = await this.fetchImpl(`${this.apiBase}/me/events/${encodeURIComponent(args.event_id)}`, {
      method: 'PATCH',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'if-match': args.etag,
        prefer: 'outlook.timezone="UTC"',
      },
      body: JSON.stringify(body),
    });
    if (res.status === 412) {
      throw new ConnectorError('idempotency_conflict', 'etag mismatch; the event changed on the server');
    }
    if (!res.ok) {
      throw new ConnectorError('provider_error', `graph event update failed: ${res.status} ${res.statusText}`, await safeText(res));
    }
    const out = (await res.json()) as GraphEvent;
    return { event: this.normaliseEvent(request.account.id, out) };
  }

  async deleteEvent(request: ConnectorRequest, _audit: AuditLog): Promise<EventDeleteResult> {
    if (this.readOnly) {
      throw new ConnectorError('forbidden', 'OutlookCalendarConnector is in read-only mode for this build');
    }
    const args = OutlookEventDeleteArgsSchema.parse(request.args);
    const token = await this.tokens.accessToken({ account_id: request.account.id, scopes: ['Calendars.ReadWrite'] });
    const res = await this.fetchImpl(`${this.apiBase}/me/events/${encodeURIComponent(args.event_id)}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
    });
    if (res.status === 404 || res.status === 204) return;
    if (!res.ok) {
      throw new ConnectorError('provider_error', `graph event delete failed: ${res.status} ${res.statusText}`, await safeText(res));
    }
  }

  async listMessages(): Promise<MailListResult> {
    throw new ConnectorError('not_found', 'OutlookCalendarConnector does not implement mail operations');
  }
  async getMessage(): Promise<MailGetResult> {
    throw new ConnectorError('not_found', 'OutlookCalendarConnector does not implement mail operations');
  }
  async sendMessage(): Promise<MailSendResult> {
    throw new ConnectorError('not_found', 'OutlookCalendarConnector does not implement mail operations');
  }
  async replyMessage(): Promise<never> {
    throw new ConnectorError('not_found', 'OutlookCalendarConnector does not implement mail operations');
  }
  async forwardMessage(): Promise<never> {
    throw new ConnectorError('not_found', 'OutlookCalendarConnector does not implement mail operations');
  }
  async listConversations(): Promise<DmConversationsListResult> {
    throw new ConnectorError('not_found', 'OutlookCalendarConnector does not implement messaging operations');
  }
  async sendDm(): Promise<DmSendResult> {
    throw new ConnectorError('not_found', 'OutlookCalendarConnector does not implement messaging operations');
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private async graphGet<T>(url: string, token: string): Promise<T> {
    const res = await this.fetchImpl(url, { headers: { authorization: `Bearer ${token}` } });
    if (res.status === 404) throw new ConnectorError('not_found', `graph 404: ${url}`);
    if (res.status === 410) {
      throw new ConnectorError('reauth_required', 'graph delta token expired; full re-sync required');
    }
    if (res.status === 401 || res.status === 403) {
      throw new ConnectorError('unauthorized', `graph auth error: ${res.status}`);
    }
    if (res.status === 429) {
      const retry = Number(res.headers.get('retry-after') ?? '1');
      throw new ConnectorError('rate_limited', `graph throttled; retry after ${retry}s`);
    }
    if (!res.ok) {
      throw new ConnectorError('provider_error', `graph error ${res.status} ${res.statusText}`, await safeText(res));
    }
    return (await res.json()) as T;
  }

  private normaliseCalendar(account_id: string, raw: GraphCalendar): Calendar {
    return CalendarSchema.parse({
      id: raw.id,
      account_id,
      name: raw.name ?? 'Unnamed calendar',
      primary: raw.isDefaultCalendar ?? false,
      color: raw.hexColor,
      read_only: raw.canEdit === false,
      provider_ref: { provider: 'outlook_calendar', native_id: raw.id },
    });
  }

  private normaliseEvent(account_id: string, raw: GraphEvent): Event {
    const allDay = !!raw.isAllDay;
    return EventSchema.parse({
      id: raw.id,
      account_id,
      calendar_id: raw.calendarId ?? 'primary',
      title: raw.subject ?? '(no title)',
      description: raw.body?.contentType === 'html' ? raw.body.content : raw.bodyPreview,
      start: allDay
        ? { tz: 'UTC', at: `${(raw.start?.dateTime ?? '').slice(0, 10) || new Date().toISOString().slice(0, 10)}T00:00:00.000Z` }
        : { tz: raw.start?.timeZone ?? 'UTC', at: raw.start?.dateTime ?? new Date().toISOString() },
      end: allDay
        ? { tz: 'UTC', at: `${(raw.end?.dateTime ?? '').slice(0, 10) || new Date().toISOString().slice(0, 10)}T00:00:00.000Z` }
        : { tz: raw.end?.timeZone ?? 'UTC', at: raw.end?.dateTime ?? new Date().toISOString() },
      all_day: allDay,
      attendees: (raw.attendees ?? []).map((a) => ({
        contact: { address: a.emailAddress.address, name: a.emailAddress.name },
        status: (a.status?.response ?? 'needsAction') as Event['attendees'][number]['status'],
        optional: a.type === 'optional',
      })),
      conference: raw.onlineMeeting?.joinUrl
        ? { provider: 'teams', join_url: raw.onlineMeeting.joinUrl }
        : undefined,
      status: (raw.isCancelled ? 'cancelled' : 'confirmed') as Event['status'],
      provider_ref: { provider: 'outlook_calendar', native_id: raw.id, etag: raw['@odata.etag'] },
    });
  }
}

interface GraphListResponse<T> {
  value?: T[];
  '@odata.nextLink'?: string;
  '@odata.deltaLink'?: string;
}

interface GraphCalendar {
  id: string;
  name?: string;
  isDefaultCalendar?: boolean;
  hexColor?: string;
  canEdit?: boolean;
}

interface GraphEvent {
  id: string;
  subject?: string;
  body?: { contentType: 'text' | 'html'; content: string };
  bodyPreview?: string;
  start?: { dateTime: string; timeZone?: string };
  end?: { dateTime: string; timeZone?: string };
  isAllDay?: boolean;
  isCancelled?: boolean;
  calendarId?: string;
  attendees?: Array<{
    emailAddress: { address: string; name?: string };
    status?: { response: 'accepted' | 'declined' | 'tentative' | 'notResponded' };
    type?: 'required' | 'optional' | 'resource';
  }>;
  onlineMeeting?: { joinUrl: string };
  '@odata.etag'?: string;
}

function toGraphDateTime(input: { tz: string; at: string }, allDay: boolean): Record<string, string> {
  if (allDay) {
    return { dateTime: input.at.slice(0, 10), timeZone: 'UTC' };
  }
  return { dateTime: input.at, timeZone: input.tz };
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

// Re-export the args schemas the gateway expects.
export { GcalCalendarsListArgsSchema as OutlookCalendarsListArgsSchema, GcalEventGetArgsSchema as OutlookEventGetArgsSchema, GcalEventsListArgsSchema as OutlookEventsListArgsSchema };

// Re-export the message-only entry point for parity with Gmail/Outlook.
export { z };
