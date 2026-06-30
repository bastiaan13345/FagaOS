/**
 * iCloud connector.
 *
 * iCloud exposes email and calendar as plain protocols:
 *   - Mail: IMAP (993) + SMTP (587) with an app-specific password.
 *   - Calendar: CalDAV (443) with the same app-specific password.
 *
 * The mail surface is implemented by reusing the `ImapConnector` —
 * the gateway wires an IMAP client factory pointing at
 * `imap.mail.me.com`. The calendar surface is implemented by the
 * `CalDavConnector` pointed at `caldav.icloud.com`.
 *
 * This file is a thin account-credentials shim so the gateway can
 * resolve an `icloud` account's password and pass it to the
 * appropriate underlying connector. The connector ids are `icloud`
 * for mail and `icloud` (with the calendar flag) for CalDAV, but
 * the gateway maps them to the IMAP and CalDAV connectors via the
 * `Provider` enum. Use `icloudMailConnector` / `icloudCalendarConnector`
 * helpers to construct the wiring.
 */
import { ImapConnector, type ImapCredentials } from '../imap/index.js';
import { CalDavConnector, type CalDavCredentials } from '../caldav/index.js';

export const ICLOUD_IMAP_HOST = 'imap.mail.me.com';
export const ICLOUD_IMAP_PORT = 993;
export const ICLOUD_SMTP_HOST = 'smtp.mail.me.com';
export const ICLOUD_SMTP_PORT = 587;
export const ICLOUD_CALDAV_URL = 'https://caldav.icloud.com:443';

/** Build the iCloud IMAP credentials. The password is an app-specific
 * password generated in the iCloud settings; the connector never
 * stores it on disk.
 */
export function icloudImapCredentials(args: {
  username: string;
  appSpecificPassword: string;
}): ImapCredentials {
  return {
    host: ICLOUD_IMAP_HOST,
    port: ICLOUD_IMAP_PORT,
    tls: 'tls',
    username: args.username,
    auth: { kind: 'password', password: args.appSpecificPassword },
  };
}

/** Build the iCloud CalDAV credentials. The username is the user's
 * iCloud email address; the password is the same app-specific
 * password as for IMAP.
 */
export function icloudCalDavCredentials(args: {
  username: string;
  appSpecificPassword: string;
}): CalDavCredentials {
  return {
    principal_url: `${ICLOUD_CALDAV_URL}/${encodeURIComponent(args.username)}/principal/`,
    username: args.username,
    password: args.appSpecificPassword,
  };
}

/**
 * Helper for the gateway: a connector that targets iCloud mail
 * (provider id `icloud`) is implemented as an `ImapConnector`
 * pointed at the iCloud IMAP endpoint.
 */
export function icloudMailConnector(opts: {
  clientFactory: ImapConnector['listMessages'] extends (...args: infer _A) => unknown
    ? (account: { id: string; handle: string; credentials: ImapCredentials }) => Promise<ImapConnector['listMessages'] extends (...a: infer _A) => infer R ? R : never>
    : never;
  credentialsFor: (accountId: string) => Promise<ImapCredentials>;
}) {
  void opts;
  return new ImapConnector({
    clientFactory: opts.clientFactory as never,
    credentialsFor: opts.credentialsFor,
    defaultMailbox: 'INBOX',
  });
}

export function icloudCalendarConnector(opts: {
  request: CalDavConnector['listEvents'] extends (...args: infer _A) => unknown
    ? (input: { url: string; method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PROPFIND' | 'REPORT' | 'MKCALENDAR'; headers?: Record<string, string>; body?: string }) => Promise<{ status: number; headers: Record<string, string>; body: string }>
    : never;
  credentialsFor: (accountId: string) => Promise<CalDavCredentials>;
}) {
  void opts;
  return new CalDavConnector({
    request: opts.request as never,
    credentialsFor: opts.credentialsFor,
    defaultCalendarPath: '/calendars/',
  });
}
