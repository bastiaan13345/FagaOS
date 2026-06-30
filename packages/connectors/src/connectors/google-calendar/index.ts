/**
 * Google Calendar connector (read-only / production-write capable).
 *
 * Implements:
 *   - calendar.calendars.list → calendarList.list
 *   - calendar.events.list    → events.list with optional syncToken
 *   - calendar.events.get     → events.get
 *   - calendar.events.create  → events.insert
 *   - calendar.events.update  → events.patch (with If-Match etag)
 *   - calendar.events.delete  → events.delete
 *
 * Sync strategy: the connector stores a `syncToken` per
 * (account_id, calendar_id). On 410 GONE the gateway wipes the token
 * and the next call performs a full sync. The connector's contract
 * says: when the call used a syncToken and the response has
 * `nextSyncToken`, return it; the gateway persists it.
 *
 * Push: a `processWatchNotification()` helper decodes a Pub/Sub push
 * for `events.watch`. The gateway treats the notification as "a
 * change happened; run `events.list` with the stored syncToken".
 *
 * Production OAuth: the `gmail.send` companion surface is
 * `calendar.events` plus `calendar.calendarlist` (read) or
 * `calendar.events.owned` (write). Token refresh is handled by the
 * gateway; the connector never holds the refresh token.
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
import type { GoogleTokenProvider } from '../../oauth/google.js';
import {
  EventCreateArgsSchema,
  EventDeleteArgsSchema,
  EventUpdateArgsSchema,
} from '../stub/calendar.js';

const CALENDAR_API = 'https://www.googleapis.com/calendar/v3';

export interface GoogleCalendarConnectorOptions {
  tokens: GoogleTokenProvider;
  fetchImpl?: typeof fetch;
  api_base?: string;
  read_only?: boolean;
}

export const GcalCalendarsListArgsSchema = z.object({}).strict();
export const GcalEventsListArgsSchema = z.object({
  calendar_id: z.string().min(1).default('primary'),
  time_min: z.string().datetime().optional(),
  time_max: z.string().datetime().optional(),
  limit: z.number().int().positive().max(250).default(50),
  sync_token: z.string().nullable().default(null),
  single_events: z.boolean().default(true),
});
export const GcalEventGetArgsSchema = z.object({
  calendar_id: z.string().min(1).default('primary'),
  event_id: z.string().min(1),
});

// Re-export the calendar write argument schemas so other connectors
// (Outlook Calendar, CalDAV, …) can share the same input shape.
export { EventCreateArgsSchema, EventUpdateArgsSchema, EventDeleteArgsSchema } from '../stub/calendar.js';

export class GoogleCalendarConnector implements Connector {
  readonly id: ConnectorId = 'google_calendar';
  readonly operations = [
    'calendar.calendars.list',
    'calendar.events.list',
    'calendar.events.get',
    'calendar.events.create',
    'calendar.events.update',
    'calendar.events.delete',
  ] as const;

  private readonly tokens: GoogleTokenProvider;
  private readonly fetchImpl: typeof fetch;
  private readonly apiBase: string;
  private readonly readOnly: boolean;

  constructor(opts: GoogleCalendarConnectorOptions) {
    this.tokens = opts.tokens;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.apiBase = opts.api_base ?? CALENDAR_API;
    this.readOnly = opts.read_only ?? true;
  }

  async listCalendars(request: ConnectorRequest, _audit: AuditLog): Promise<CalendarsListResult> {
    GcalCalendarsListArgsSchema.parse(request.args);
    const token = await this.tokens.accessToken({
      account_id: request.account.id,
      scopes: ['https://www.googleapis.com/auth/calendar.calendarlist.readonly'],
    });
    const url = new URL(`${this.apiBase}/users/me/calendarList`);
    const out = await this.calGet<{ items?: GoogleCalendarListEntry[] }>(url.toString(), token);
    return { calendars: (out.items ?? []).map((c) => this.normaliseCalendar(request.account.id, c)) };
  }

  async listEvents(request: ConnectorRequest, _audit: AuditLog): Promise<EventsListResult> {
    const args = GcalEventsListArgsSchema.parse(request.args);
    const token = await this.tokens.accessToken({
      account_id: request.account.id,
      scopes: ['https://www.googleapis.com/auth/calendar.events.readonly'],
    });
    const url = new URL(`${this.apiBase}/calendars/${encodeURIComponent(args.calendar_id)}/events`);
    if (args.sync_token) {
      url.searchParams.set('syncToken', args.sync_token);
    } else {
      if (args.time_min) url.searchParams.set('timeMin', args.time_min);
      if (args.time_max) url.searchParams.set('timeMax', args.time_max);
      url.searchParams.set('singleEvents', String(args.single_events));
    }
    url.searchParams.set('maxResults', String(args.limit));
    const out = await this.calGet<GoogleEventsList>(url.toString(), token);
    const events: Event[] = (out.items ?? []).map((e) =>
      this.normaliseEvent(request.account.id, args.calendar_id, e),
    );
    return { events, next_sync_token: out.nextSyncToken ?? null };
  }

  async getEvent(request: ConnectorRequest, _audit: AuditLog): Promise<EventGetResult> {
    const args = GcalEventGetArgsSchema.parse(request.args);
    const token = await this.tokens.accessToken({
      account_id: request.account.id,
      scopes: ['https://www.googleapis.com/auth/calendar.events.readonly'],
    });
    const url = `${this.apiBase}/calendars/${encodeURIComponent(args.calendar_id)}/events/${encodeURIComponent(args.event_id)}`;
    const out = await this.calGet<GoogleEvent>(url, token);
    return { event: this.normaliseEvent(request.account.id, args.calendar_id, out) };
  }

  async createEvent(request: ConnectorRequest, _audit: AuditLog): Promise<EventCreateResult> {
    if (this.readOnly) {
      throw new ConnectorError('forbidden', 'GoogleCalendarConnector is in read-only mode for this build');
    }
    const args = EventCreateArgsSchema.parse(request.args);
    const calendar_id = args.calendar_id ?? 'primary';
    const token = await this.tokens.accessToken({
      account_id: request.account.id,
      scopes: ['https://www.googleapis.com/auth/calendar.events.owned'],
    });
    const url = `${this.apiBase}/calendars/${encodeURIComponent(calendar_id)}/events?sendUpdates=all`;
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(toGoogleEventInput(args)),
    });
    if (!res.ok) {
      throw new ConnectorError('provider_error', `events.insert failed: ${res.status} ${res.statusText}`, await safeText(res));
    }
    const out = (await res.json()) as GoogleEvent;
    return { event: this.normaliseEvent(request.account.id, calendar_id, out) };
  }

  async updateEvent(request: ConnectorRequest, _audit: AuditLog): Promise<EventUpdateResult> {
    if (this.readOnly) {
      throw new ConnectorError('forbidden', 'GoogleCalendarConnector is in read-only mode for this build');
    }
    const args = EventUpdateArgsSchema.parse(request.args);
    const calendar_id = args.calendar_id ?? 'primary';
    const token = await this.tokens.accessToken({
      account_id: request.account.id,
      scopes: ['https://www.googleapis.com/auth/calendar.events.owned'],
    });
    const url = `${this.apiBase}/calendars/${encodeURIComponent(calendar_id)}/events/${encodeURIComponent(args.event_id)}?sendUpdates=all`;
    const res = await this.fetchImpl(url, {
      method: 'PATCH',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'if-match': args.etag,
      },
      body: JSON.stringify(toGoogleEventPatch(args)),
    });
    if (res.status === 412) {
      throw new ConnectorError('idempotency_conflict', 'etag mismatch; the event changed on the server');
    }
    if (!res.ok) {
      throw new ConnectorError('provider_error', `events.patch failed: ${res.status} ${res.statusText}`, await safeText(res));
    }
    const out = (await res.json()) as GoogleEvent;
    return { event: this.normaliseEvent(request.account.id, calendar_id, out) };
  }

  async deleteEvent(request: ConnectorRequest, _audit: AuditLog): Promise<EventDeleteResult> {
    if (this.readOnly) {
      throw new ConnectorError('forbidden', 'GoogleCalendarConnector is in read-only mode for this build');
    }
    const args = EventDeleteArgsSchema.parse(request.args);
    const calendar_id = args.calendar_id ?? 'primary';
    const token = await this.tokens.accessToken({
      account_id: request.account.id,
      scopes: ['https://www.googleapis.com/auth/calendar.events.owned'],
    });
    const url = `${this.apiBase}/calendars/${encodeURIComponent(calendar_id)}/events/${encodeURIComponent(args.event_id)}?sendUpdates=all`;
    const res = await this.fetchImpl(url, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
    });
    if (res.status === 404) {
      return;
    }
    if (res.status === 410) {
      throw new ConnectorError('reauth_required', 'calendar sync token expired; full re-sync required');
    }
    if (!res.ok) {
      throw new ConnectorError('provider_error', `events.delete failed: ${res.status} ${res.statusText}`, await safeText(res));
    }
  }

  // Operations the connector does not implement.
  async listMessages(): Promise<MailListResult> {
    throw new ConnectorError('not_found', 'GoogleCalendarConnector does not implement mail operations');
  }
  async getMessage(): Promise<MailGetResult> {
    throw new ConnectorError('not_found', 'GoogleCalendarConnector does not implement mail operations');
  }
  async sendMessage(): Promise<MailSendResult> {
    throw new ConnectorError('not_found', 'GoogleCalendarConnector does not implement mail operations');
  }
  async replyMessage(): Promise<never> {
    throw new ConnectorError('not_found', 'GoogleCalendarConnector does not implement mail operations');
  }
  async forwardMessage(): Promise<never> {
    throw new ConnectorError('not_found', 'GoogleCalendarConnector does not implement mail operations');
  }
  async listConversations(): Promise<DmConversationsListResult> {
    throw new ConnectorError('not_found', 'GoogleCalendarConnector does not implement messaging operations');
  }
  async sendDm(): Promise<DmSendResult> {
    throw new ConnectorError('not_found', 'GoogleCalendarConnector does not implement messaging operations');
  }

  // -------------------------------------------------------------------------
  // Push
  // -------------------------------------------------------------------------

  processWatchNotification(notification: unknown): { channel_id: string; resource_id: string } {
    if (
      typeof notification !== 'object' ||
      notification === null ||
      typeof (notification as Record<string, unknown>)['message'] !== 'object'
    ) {
      throw new ConnectorError('webhook_payload_invalid', 'events.watch notification must be a Pub/Sub message');
    }
    const envelope = (notification as { message: { data?: string } }).message;
    if (!envelope.data) {
      throw new ConnectorError('webhook_payload_invalid', 'events.watch notification missing data');
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(Buffer.from(envelope.data, 'base64').toString('utf8'));
    } catch {
      throw new ConnectorError('webhook_payload_invalid', 'events.watch data is not valid base64 JSON');
    }
    const obj = decoded as Record<string, unknown>;
    if (typeof obj['channel_id'] !== 'string' || typeof obj['resource_id'] !== 'string') {
      throw new ConnectorError('webhook_payload_invalid', 'events.watch body missing channel_id/resource_id');
    }
    return { channel_id: obj['channel_id'], resource_id: obj['resource_id'] };
  }

  async watch(args: {
    account_id: string;
    calendar_id: string;
    pubsub_topic: string;
    ttl_seconds: number;
  }): Promise<{ channel_id: string; resource_id: string; expiration: string }> {
    if (this.readOnly) {
      throw new ConnectorError('forbidden', 'GoogleCalendarConnector is in read-only mode');
    }
    const token = await this.tokens.accessToken({
      account_id: args.account_id,
      scopes: ['https://www.googleapis.com/auth/calendar.events.readonly'],
    });
    const url = `${this.apiBase}/calendars/${encodeURIComponent(args.calendar_id)}/events/watch`;
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        id: `fagaos-${args.account_id}-${Date.now()}`,
        type: 'web_hook',
        address: args.pubsub_topic,
        params: { ttl: String(args.ttl_seconds) },
      }),
    });
    if (!res.ok) {
      throw new ConnectorError('provider_error', `events.watch failed: ${res.status} ${res.statusText}`, await safeText(res));
    }
    const out = (await res.json()) as { id: string; resourceId: string; expiration: string };
    return { channel_id: out.id, resource_id: out.resourceId, expiration: out.expiration };
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private async calGet<T>(url: string, token: string): Promise<T> {
    const res = await this.fetchImpl(url, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (res.status === 404) throw new ConnectorError('not_found', `calendar api 404: ${url}`);
    if (res.status === 410) {
      throw new ConnectorError('reauth_required', 'sync token expired; full re-sync required');
    }
    if (res.status === 401 || res.status === 403) {
      throw new ConnectorError('unauthorized', `calendar api auth error: ${res.status}`);
    }
    if (!res.ok) {
      throw new ConnectorError('provider_error', `calendar api error ${res.status} ${res.statusText}`, await safeText(res));
    }
    return (await res.json()) as T;
  }

  private normaliseCalendar(account_id: string, raw: GoogleCalendarListEntry): Calendar {
    return CalendarSchema.parse({
      id: raw.id,
      account_id,
      name: raw.summary,
      primary: raw.primary ?? false,
      color: raw.backgroundColor,
      read_only: raw.accessRole === 'reader' || raw.accessRole === 'freeBusyReader',
      provider_ref: { provider: 'google_calendar', native_id: raw.id },
    });
  }

  private normaliseEvent(account_id: string, calendar_id: string, raw: GoogleEvent): Event {
    const allDay = !!raw.start?.date;
    const start = allDay && raw.start?.date
      ? { tz: 'UTC', at: `${raw.start.date}T00:00:00.000Z` }
      : { tz: raw.start?.timeZone ?? 'UTC', at: new Date(raw.start?.dateTime ?? raw.start?.date ?? Date.now()).toISOString() };
    const end = allDay && raw.end?.date
      ? { tz: 'UTC', at: `${raw.end.date}T00:00:00.000Z` }
      : { tz: raw.end?.timeZone ?? 'UTC', at: new Date(raw.end?.dateTime ?? raw.end?.date ?? Date.now()).toISOString() };
    return EventSchema.parse({
      id: raw.id,
      account_id,
      calendar_id,
      title: raw.summary ?? '(no title)',
      description: raw.description,
      start,
      end,
      all_day: allDay,
      attendees: (raw.attendees ?? []).map((a) => ({
        contact: { address: a.email, name: a.displayName },
        status: (a.responseStatus ?? 'needsAction') as Event['attendees'][number]['status'],
        optional: a.optional ?? false,
      })),
      conference: raw.hangoutLink
        ? { provider: 'google_meet', join_url: raw.hangoutLink }
        : (raw.conferenceData?.entryPoints?.[0]?.uri
          ? { provider: 'google_meet', join_url: raw.conferenceData.entryPoints[0].uri }
          : undefined),
      status: (raw.status ?? 'confirmed') as Event['status'],
      provider_ref: { provider: 'google_calendar', native_id: raw.id, etag: raw.etag },
    });
  }
}

// ---------------------------------------------------------------------------
// Wire-format helpers
// ---------------------------------------------------------------------------

type GcalEventCreateInput = {
  title: string;
  description?: string | undefined;
  start: { tz: string; at: string };
  end: { tz: string; at: string };
  all_day?: boolean | undefined;
  attendees?: Array<{ address: string; name?: string | undefined; optional?: boolean | undefined }> | undefined;
  conference?: { provider: 'google_meet' | 'teams' | 'other'; join_url?: string | undefined } | undefined;
};

function toGoogleEventInput(args: GcalEventCreateInput): Record<string, unknown> {
  const allDay = args.all_day ?? false;
  return {
    summary: args.title,
    description: args.description,
    start: allDay
      ? { date: args.start.at.slice(0, 10) }
      : { dateTime: args.start.at, timeZone: args.start.tz },
    end: allDay
      ? { date: args.end.at.slice(0, 10) }
      : { dateTime: args.end.at, timeZone: args.end.tz },
    attendees: (args.attendees ?? []).map((a) => ({
      email: a.address,
      displayName: a.name,
      optional: a.optional ?? false,
    })),
    ...(args.conference?.provider === 'google_meet'
      ? { conferenceData: { createRequest: { requestId: `fagaos-${Date.now()}` } } }
      : {}),
  };
}

function toGoogleEventPatch(args: {
  title?: string | undefined;
  description?: string | undefined;
  start?: { tz: string; at: string } | undefined;
  end?: { tz: string; at: string } | undefined;
  all_day?: boolean | undefined;
  attendees?: Array<{ address: string; name?: string | undefined; optional?: boolean | undefined }> | undefined;
}): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (args.title !== undefined) out['summary'] = args.title;
  if (args.description !== undefined) out['description'] = args.description;
  if (args.start) {
    out['start'] = args.all_day
      ? { date: args.start.at.slice(0, 10) }
      : { dateTime: args.start.at, timeZone: args.start.tz };
  }
  if (args.end) {
    out['end'] = args.all_day
      ? { date: args.end.at.slice(0, 10) }
      : { dateTime: args.end.at, timeZone: args.end.tz };
  }
  if (args.attendees) {
    out['attendees'] = args.attendees.map((a) => ({
      email: a.address,
      displayName: a.name,
      optional: a.optional ?? false,
    }));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Wire-format types — minimal slice we use.
// ---------------------------------------------------------------------------

interface GoogleCalendarListEntry {
  id: string;
  summary: string;
  primary?: boolean;
  backgroundColor?: string;
  accessRole?: 'reader' | 'freeBusyReader' | 'writer' | 'owner';
}

interface GoogleEvent {
  id: string;
  status?: 'confirmed' | 'tentative' | 'cancelled';
  summary?: string;
  description?: string;
  start?: { date?: string; dateTime?: string; timeZone?: string };
  end?: { date?: string; dateTime?: string; timeZone?: string };
  attendees?: Array<{
    email: string;
    displayName?: string;
    responseStatus?: 'accepted' | 'declined' | 'tentative' | 'needsAction';
    optional?: boolean;
  }>;
  etag?: string;
  hangoutLink?: string;
  conferenceData?: {
    entryPoints?: Array<{ uri: string; entryPointType?: string }>;
  };
}

interface GoogleEventsList {
  items?: GoogleEvent[];
  nextSyncToken?: string;
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}
