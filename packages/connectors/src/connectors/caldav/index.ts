/**
 * CalDAV connector (generic).
 *
 * CalDAV is the IETF standard for calendar access; the connector here
 * targets the normalised calendar surface over CalDAV. It can talk to:
 *
 *   - iCloud (caldav.icloud.com) — `icloud-calendar` in FagaOS.
 *   - Fastmail, mailbox.org, self-hosted Radicale, Baïkal, etc.
 *   - Any RFC 4791 / RFC 7986 compliant server.
 *
 * The connector is intentionally wire-protocol-agnostic: the gateway
 * supplies a `request` function (typically a thin wrapper over
 * `node:https` or `node:http` for the production path). Tests inject
 * a fake that returns fixture XML.
 *
 * Auth: HTTP Basic over the supplied username/password (app-specific
 * for iCloud, plain for self-hosted). Bearer / OAuth2 is not a
 * common CalDAV pattern; the connector does not implement it.
 *
 * Reference:
 *   - RFC 4791 (CalDAV)
 *   - RFC 7986 (iCalendar)
 *   - RFC 6578 (Calendar Synchronization for WebDAV, used for sync
 *     collection / `sync-token` based incremental sync)
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
import { CalendarSchema, EventSchema, type Calendar, type Event } from '../../models/schemas.js';
import { z as _z } from 'zod';
void _z;
import {
  EventCreateArgsSchema,
  EventDeleteArgsSchema,
  EventUpdateArgsSchema,
  GcalEventGetArgsSchema,
  GcalEventsListArgsSchema,
} from '../google-calendar/index.js';

/** HTTP request shape. Tests inject a fake. */
export interface CalDavRequestFn {
  (input: {
    url: string;
    method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PROPFIND' | 'REPORT' | 'MKCALENDAR';
    headers?: Record<string, string>;
    body?: string;
  }): Promise<{ status: number; headers: Record<string, string>; body: string }>;
}

export interface CalDavCredentials {
  /** Principal URL returned by the discovery step. */
  principal_url: string;
  username: string;
  password: string;
}

export interface CalDavConnectorOptions {
  request: CalDavRequestFn;
  credentialsFor: (accountId: string) => Promise<CalDavCredentials>;
  defaultCalendarPath?: string;
}

export const CalDavEventsListArgsSchema = GcalEventsListArgsSchema;
export const CalDavEventGetArgsSchema = GcalEventGetArgsSchema;
export const CalDavEventCreateArgsSchema = EventCreateArgsSchema;
export const CalDavEventUpdateArgsSchema = EventUpdateArgsSchema;
export const CalDavEventDeleteArgsSchema = EventDeleteArgsSchema;

export class CalDavConnector implements Connector {
  readonly id: ConnectorId = 'caldav';
  readonly operations = [
    'calendar.calendars.list',
    'calendar.events.list',
    'calendar.events.get',
    'calendar.events.create',
    'calendar.events.update',
    'calendar.events.delete',
  ] as const;

  private readonly request: CalDavRequestFn;
  private readonly credentialsFor: (accountId: string) => Promise<CalDavCredentials>;
  private readonly defaultCalendarPath: string;

  constructor(opts: CalDavConnectorOptions) {
    this.request = opts.request;
    this.credentialsFor = opts.credentialsFor;
    this.defaultCalendarPath = opts.defaultCalendarPath ?? '/calendars/';
  }

  async listCalendars(request: ConnectorRequest, _audit: AuditLog): Promise<CalendarsListResult> {
    const creds = await this.credentialsFor(request.account.id);
    const res = await this.request({
      url: creds.principal_url,
      method: 'PROPFIND',
      headers: { depth: '1', 'content-type': 'application/xml' },
      body: PROP_CALENDAR_HOME,
    });
    if (res.status === 401 || res.status === 403) {
      throw new ConnectorError('unauthorized', `caldav auth failed: ${res.status}`);
    }
    if (!isOkStatus(res.status)) {
      throw new ConnectorError('provider_error', `caldav error: ${res.status}`);
    }
    const hrefs = extractHrefs(res.body, '');
    const calendars: Calendar[] = [];
    for (const href of hrefs) {
      const detail = await this.request({
        url: absoluteUrl(creds.principal_url, href),
        method: 'PROPFIND',
        headers: { depth: '0', 'content-type': 'application/xml' },
        body: PROP_CALENDAR_PROPS,
      });
      const name = extractDisplayName(detail.body) ?? href;
      const color = extractCalendarColor(detail.body);
      calendars.push(
        CalendarSchema.parse({
          id: href,
          account_id: request.account.id,
          name,
          primary: href.endsWith(this.defaultCalendarPath),
          color,
          read_only: false,
          provider_ref: { provider: 'caldav', native_id: href },
        }),
      );
    }
    return { calendars };
  }

  async listEvents(request: ConnectorRequest, _audit: AuditLog): Promise<EventsListResult> {
    const args = CalDavEventsListArgsSchema.parse(request.args);
    const creds = await this.credentialsFor(request.account.id);
    const calendar_href = args.calendar_id ?? this.defaultCalendarPath;
    const body = args.sync_token
      ? SYNC_QUERY_BODY(args.sync_token)
      : CALENDAR_QUERY_BODY(args.time_min, args.time_max, args.limit);
    const res = await this.request({
      url: absoluteUrl(creds.principal_url, calendar_href),
      method: 'REPORT',
      headers: { depth: '1', 'content-type': 'application/xml' },
      body,
    });
    if (res.status === 410) {
      throw new ConnectorError('reauth_required', 'caldav sync token expired; full re-sync required');
    }
    if (res.status === 401 || res.status === 403) {
      throw new ConnectorError('unauthorized', `caldav auth failed: ${res.status}`);
    }
    if (!isOkStatus(res.status)) {
      throw new ConnectorError('provider_error', `caldav REPORT failed: ${res.status}`);
    }
    const events = extractICalendars(res.body).map((raw) => this.parseIcal(raw, request.account.id, calendar_href));
    const next = extractSyncToken(res.body);
    return { events, next_sync_token: next };
  }

  async getEvent(request: ConnectorRequest, _audit: AuditLog): Promise<EventGetResult> {
    const args = CalDavEventGetArgsSchema.parse(request.args);
    const creds = await this.credentialsFor(request.account.id);
    const url = absoluteUrl(creds.principal_url, `${args.calendar_id ?? this.defaultCalendarPath}${args.event_id}.ics`);
    const res = await this.request({
      url,
      method: 'GET',
      headers: { accept: 'text/calendar' },
    });
    if (res.status === 404) throw new ConnectorError('not_found', `caldav event not found: ${args.event_id}`);
    if (res.status === 401 || res.status === 403) {
      throw new ConnectorError('unauthorized', `caldav auth failed: ${res.status}`);
    }
    if (!isOkStatus(res.status)) {
      throw new ConnectorError('provider_error', `caldav GET failed: ${res.status}`);
    }
    return { event: this.parseIcal(res.body, request.account.id, args.calendar_id ?? this.defaultCalendarPath) };
  }

  async createEvent(request: ConnectorRequest, _audit: AuditLog): Promise<EventCreateResult> {
    const args = CalDavEventCreateArgsSchema.parse(request.args);
    const creds = await this.credentialsFor(request.account.id);
    const calendar_href = args.calendar_id ?? this.defaultCalendarPath;
    const uid = `fagaos-${Date.now()}-${Math.random().toString(36).slice(2)}@fagaos.local`;
    const body = buildIcal({
      uid,
      title: args.title,
      description: args.description ?? undefined,
      start: args.start,
      end: args.end,
      allDay: args.all_day ?? false,
      attendees: (args.attendees ?? []).map((a: { address: string; name?: string | undefined; optional?: boolean | undefined }) => ({ address: a.address, name: a.name ?? undefined, optional: a.optional ?? false })),
    });
    const url = absoluteUrl(creds.principal_url, `${calendar_href}${uid}.ics`);
    const res = await this.request({
      url,
      method: 'PUT',
      headers: { 'content-type': 'text/calendar; charset=utf-8', 'if-none-match': '*' },
      body,
    });
    if (res.status === 401 || res.status === 403) {
      throw new ConnectorError('unauthorized', `caldav auth failed: ${res.status}`);
    }
    if (res.status === 412) {
      throw new ConnectorError('idempotency_conflict', 'caldav event already exists');
    }
    if (!isOkStatus(res.status)) {
      throw new ConnectorError('provider_error', `caldav PUT failed: ${res.status}`);
    }
    const event = this.parseIcal(body, request.account.id, calendar_href);
    return { event };
  }

  async updateEvent(request: ConnectorRequest, _audit: AuditLog): Promise<EventUpdateResult> {
    const args = CalDavEventUpdateArgsSchema.parse(request.args);
    const creds = await this.credentialsFor(request.account.id);
    const calendar_href = args.calendar_id ?? this.defaultCalendarPath;
    // Fetch the current event to know its UID and to apply the patch
    // fields the caller did not supply.
    const getRes = await this.request({
      url: absoluteUrl(creds.principal_url, `${calendar_href}${args.event_id}.ics`),
      method: 'GET',
      headers: { accept: 'text/calendar' },
    });
    if (getRes.status === 404) throw new ConnectorError('not_found', `caldav event not found: ${args.event_id}`);
    if (getRes.status === 401 || getRes.status === 403) {
      throw new ConnectorError('unauthorized', `caldav auth failed: ${getRes.status}`);
    }
    if (!isOkStatus(getRes.status)) {
      throw new ConnectorError('provider_error', `caldav GET failed: ${getRes.status}`);
    }
    const current = this.parseIcal(getRes.body, request.account.id, calendar_href);
    const uid = current.id;
    const body = buildIcal({
      uid,
      title: args.title ?? current.title,
      description: args.description ?? current.description,
      start: args.start ?? current.start,
      end: args.end ?? current.end,
      allDay: args.all_day ?? current.all_day,
      attendees: (args.attendees ?? current.attendees.map((a) => ({ address: a.contact.address, name: a.contact.name, optional: a.optional }))).map((a: { address: string; name?: string | undefined; optional?: boolean | undefined }) => ({ address: a.address, name: a.name ?? undefined, optional: a.optional ?? false })),
    });
    const url = absoluteUrl(creds.principal_url, `${calendar_href}${uid}.ics`);
    const res = await this.request({
      url,
      method: 'PUT',
      headers: { 'content-type': 'text/calendar; charset=utf-8', 'if-match': args.etag },
      body,
    });
    if (res.status === 412) {
      throw new ConnectorError('idempotency_conflict', 'caldav etag mismatch');
    }
    if (!isOkStatus(res.status)) {
      throw new ConnectorError('provider_error', `caldav PUT failed: ${res.status}`);
    }
    return { event: this.parseIcal(body, request.account.id, calendar_href) };
  }

  async deleteEvent(request: ConnectorRequest, _audit: AuditLog): Promise<EventDeleteResult> {
    const args = CalDavEventDeleteArgsSchema.parse(request.args);
    const creds = await this.credentialsFor(request.account.id);
    const url = absoluteUrl(creds.principal_url, `${args.calendar_id ?? this.defaultCalendarPath}${args.event_id}.ics`);
    const res = await this.request({ url, method: 'DELETE' });
    if (res.status === 404) return;
    if (!isOkStatus(res.status)) {
      throw new ConnectorError('provider_error', `caldav DELETE failed: ${res.status}`);
    }
  }

  async listMessages(): Promise<MailListResult> {
    throw new ConnectorError('not_found', 'CalDavConnector does not implement mail operations');
  }
  async getMessage(): Promise<MailGetResult> {
    throw new ConnectorError('not_found', 'CalDavConnector does not implement mail operations');
  }
  async sendMessage(): Promise<MailSendResult> {
    throw new ConnectorError('not_found', 'CalDavConnector does not implement mail operations');
  }
  async replyMessage(): Promise<never> {
    throw new ConnectorError('not_found', 'CalDavConnector does not implement mail operations');
  }
  async forwardMessage(): Promise<never> {
    throw new ConnectorError('not_found', 'CalDavConnector does not implement mail operations');
  }
  async listConversations(): Promise<DmConversationsListResult> {
    throw new ConnectorError('not_found', 'CalDavConnector does not implement messaging operations');
  }
  async sendDm(): Promise<DmSendResult> {
    throw new ConnectorError('not_found', 'CalDavConnector does not implement messaging operations');
  }

  // -------------------------------------------------------------------------
  // iCalendar helpers
  // -------------------------------------------------------------------------

  private parseIcal(raw: string, account_id: string, calendar_id: string): Event {
    const props: Record<string, string> = {};
    const attendees: Event['attendees'] = [];
    let inVevent = false;
    for (const line of raw.split(/\r?\n/)) {
      if (line === 'BEGIN:VEVENT') {
        inVevent = true;
        continue;
      }
      if (line === 'END:VEVENT') {
        inVevent = false;
        continue;
      }
      if (!inVevent) continue;
      const m = /^([A-Z][A-Z0-9-;]+):(.*)$/.exec(line);
      if (!m) continue;
      const key = m[1]!;
      const value = m[2] ?? '';
      if (key === 'ATTENDEE') {
        const addr = /^mailto:(.+)$/i.exec(value.trim())?.[1] ?? value;
        attendees.push({ contact: { address: addr }, status: 'needsAction', optional: false });
      } else {
        props[key] = value;
      }
    }
    const allDay = !!props['DTSTART'] && /^\d{8}$/.test(props['DTSTART']);
    const start = allDay
      ? { tz: 'UTC', at: `${props['DTSTART']}T00:00:00.000Z` }
      : { tz: props['DTSTART']?.includes('TZID=') ? extractTzid(props['DTSTART']) : 'UTC', at: parseIcalDate(props['DTSTART'] ?? '') };
    const end = allDay
      ? { tz: 'UTC', at: `${props['DTEND']}T00:00:00.000Z` }
      : { tz: props['DTEND']?.includes('TZID=') ? extractTzid(props['DTEND']) : 'UTC', at: parseIcalDate(props['DTEND'] ?? '') };
    return EventSchema.parse({
      id: props['UID'] ?? '',
      account_id,
      calendar_id,
      title: props['SUMMARY'] ?? '(no title)',
      description: props['DESCRIPTION'],
      start,
      end,
      all_day: allDay,
      attendees,
      status: props['STATUS'] === 'CANCELLED' ? 'cancelled' : 'confirmed',
      provider_ref: { provider: 'caldav', native_id: props['UID'] ?? '' },
    });
  }
}

// ---------------------------------------------------------------------------
// Wire-format helpers
// ---------------------------------------------------------------------------

function isOkStatus(status: number): boolean {
  return status >= 200 && status < 300;
}

const PROP_CALENDAR_HOME = `<?xml version="1.0"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop><c:calendar-home-set/></d:prop>
</d:propfind>`;

const PROP_CALENDAR_PROPS = `<?xml version="1.0"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:ic="http://apple.com/ns/ical/">
  <d:prop>
    <d:displayname/>
    <ic:calendar-color/>
    <d:resourcetype/>
  </d:prop>
</d:propfind>`;

function CALENDAR_QUERY_BODY(time_min?: string, time_max?: string, limit?: number): string {
  const range = time_min || time_max
    ? `<c:time-range start="${time_min ?? '19700101T000000Z'}" end="${time_max ?? '29991231T235959Z'}"/>`
    : '';
  return `<?xml version="1.0"?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop><d:getetag/><c:calendar-data/></d:prop>
  <c:filter>
    <c:comp-filter name="VCALENDAR">
      <c:comp-filter name="VEVENT">
        ${range}
      </c:comp-filter>
    </c:comp-filter>
  </c:filter>
  ${limit ? `<c:limit><c:nresults>${limit}</c:nresults></c:limit>` : ''}
</c:calendar-query>`;
}

function SYNC_QUERY_BODY(token: string): string {
  return `<?xml version="1.0"?>
<d:sync-collection xmlns:d="DAV:">
  <d:sync-token>${escapeXml(token)}</d:sync-token>
  <d:prop><d:getetag/><c:calendar-data xmlns:c="urn:ietf:params:xml:ns:caldav"/></d:prop>
</d:sync-collection>`;
}

function buildIcal(input: {
  uid: string;
  title: string;
  description?: string | undefined;
  start: { tz: string; at: string };
  end: { tz: string; at: string };
  allDay?: boolean | undefined;
  attendees?: Array<{ address: string; name?: string | undefined; optional?: boolean | undefined }> | undefined;
}): string {
  const dt = (s: { tz: string; at: string }) => input.allDay
    ? `DTSTART;VALUE=DATE:${s.at.slice(0, 10).replace(/-/g, '')}`
    : `DTSTART;TZID=${s.tz}:${s.at.replace(/[-:]/g, '').slice(0, 15)}`;
  const dtEnd = (s: { tz: string; at: string }) => input.allDay
    ? `DTEND;VALUE=DATE:${s.at.slice(0, 10).replace(/-/g, '')}`
    : `DTEND;TZID=${s.tz}:${s.at.replace(/[-:]/g, '').slice(0, 15)}`;
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//FagaOS//CalDAV Connector//EN',
    'BEGIN:VEVENT',
    `UID:${input.uid}`,
    dt(input.start),
    dtEnd(input.end),
    `SUMMARY:${escapeIcs(input.title)}`,
    input.description ? `DESCRIPTION:${escapeIcs(input.description)}` : '',
    ...(input.attendees ?? []).map((a) => `ATTENDEE;CN=${escapeIcs(a.name ?? a.address)};${a.optional ? 'ROLE=OPT-PARTICIPANT' : 'ROLE=REQ-PARTICIPANT'}:mailto:${a.address}`),
    'END:VEVENT',
    'END:VCALENDAR',
  ].filter(Boolean);
  return lines.join('\r\n');
}

function escapeIcs(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function absoluteUrl(base: string, href: string): string {
  if (/^https?:\/\//i.test(href)) return href;
  return new URL(href, base).toString();
}

function extractHrefs(xml: string, _resourcetypeMarker: string): string[] {
  const hrefs: string[] = [];
  const re = /<d:href>([^<]+)<\/d:href>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) hrefs.push(m[1]!);
  return hrefs;
}

function extractDisplayName(xml: string): string | null {
  const m = /<d:displayname>([^<]+)<\/d:displayname>/.exec(xml);
  return m ? m[1]! : null;
}

function extractCalendarColor(xml: string): string | undefined {
  const m = /<ic:calendar-color[^>]*>([^<]+)<\/ic:calendar-color>/.exec(xml);
  if (!m) return undefined;
  const v = m[1]!;
  if (/^#[0-9a-f]{6}$/i.test(v)) return v;
  return undefined;
}

function extractICalendars(xml: string): string[] {
  const out: string[] = [];
  const re = /<c:calendar-data[^>]*>([\s\S]*?)<\/c:calendar-data>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    out.push(decodeXml(m[1]!));
  }
  return out;
}

function decodeXml(s: string): string {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
}

function extractSyncToken(xml: string): string | null {
  const m = /<d:sync-token>([^<]+)<\/d:sync-token>/.exec(xml);
  return m ? m[1]! : null;
}

function extractTzid(s: string): string {
  const m = /TZID=([^:]+):/.exec(s);
  return m ? m[1]! : 'UTC';
}

function parseIcalDate(s: string): string {
  // Strip TZID prefix; the remainder is YYYYMMDDTHHMMSSZ (UTC) or
  // YYYYMMDDTHHMMSS (floating). We return ISO 8601.
  const stripped = s.replace(/^TZID=[^:]+:/, '');
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(stripped);
  if (!m) return new Date(stripped).toISOString();
  const [, y, mo, d, h, mi, sec, z] = m;
  return `${y}-${mo}-${d}T${h}:${mi}:${sec}${z ? 'Z' : '+00:00'}`;
}
