/**
 * IMAP connector (generic).
 *
 * IMAP is a wire-protocol, not an HTTP API. The connector here is a
 * thin abstraction over an `ImapClient` interface that:
 *
 *   1. Opens a TLS connection to the IMAP server.
 *   2. Authenticates with the supplied credentials (password or
 *      XOAUTH2 SASL string).
 *   3. Selects a mailbox and fetches message metadata.
 *   4. Subscribes to IDLE for push notifications.
 *   5. Returns RFC 822 / parsed messages to the agent.
 *
 * The Phase 1 reference implementation does not bundle a real IMAP
 * client (out of scope for this issue). The connector accepts an
 * `ImapClient` factory so the gateway can wire a real implementation
 * (`imapflow` or `node-imap`) in production. Tests use a fake that
 * returns RFC 822 fixtures.
 *
 * Reference: RFC 3501 (IMAP4rev1), RFC 2177 (IDLE), RFC 4959
 * (SASL-IR / SASL XOAUTH2), RFC 2087 (QUOTA), RFC 5256 (SORT/THREAD).
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
  MailForwardResult,
  MailGetResult,
  MailListResult,
  MailReplyResult,
  MailSendResult,
} from '../../connector.js';
import { MessageSchema, type Message } from '../../models/schemas.js';
import { z } from 'zod';
import {
  MailForwardArgsSchema,
  MailGetArgsSchema,
  MailListArgsSchema,
  MailReplyArgsSchema,
  MailSendArgsSchema,
} from '../stub/email.js';

/**
 * The wire-protocol surface an IMAP client must implement. Concrete
 * clients (e.g. `imapflow`) wrap their own state. The interface is
 * the seam between FagaOS and a third-party client.
 */
export interface ImapClient {
  /** Open a connection and authenticate. */
  connect(): Promise<void>;
  /** Close the connection. */
  logout(): Promise<void>;
  /** List the names of all selectable mailboxes. */
  listMailboxes(): Promise<string[]>;
  /** Select a mailbox; returns the message count. */
  selectMailbox(name: string): Promise<{ exists: number }>;
  /** Fetch UIDs and headers for a range; the result is a list of `ImapMessage`. */
  fetchHeaders(args: { mailbox: string; range: string }): Promise<ImapMessage[]>;
  /** Fetch the full body for one UID. */
  fetchBody(args: { mailbox: string; uid: string }): Promise<ImapMessage>;
  /** Append a message to a mailbox (used for sends / forwards). */
  appendMessage(args: { mailbox: string; raw: string; flags?: string[] }): Promise<{ uid: string }>;
  /** Issue an IDLE and return when the server notifies a change. */
  idle(args: { mailbox: string; timeoutMs: number }): Promise<{ changed: boolean }>;
}

export interface ImapMessage {
  uid: string;
  mailbox: string;
  flags: string[];
  envelope: {
    messageId?: string;
    from?: { address: string; name?: string };
    to?: Array<{ address: string; name?: string }>;
    cc?: Array<{ address: string; name?: string }>;
    subject?: string;
    date?: string;
  };
  bodyText?: string;
  bodyHtml?: string;
  size: number;
}

export interface ImapConnectorOptions {
  /** Factory the gateway wires. Tests inject a fake. */
  clientFactory: (account: { id: string; handle: string; credentials: ImapCredentials }) => Promise<ImapClient>;
  /** Credential vault. The connector never holds the password. */
  credentialsFor: (accountId: string) => Promise<ImapCredentials>;
  /** Default mailbox to operate on. Default: `INBOX`. */
  defaultMailbox?: string;
}

export interface ImapCredentials {
  host: string;
  port: number;
  /** TLS: implicit on connect (993) or STARTTLS (143). */
  tls: 'tls' | 'starttls' | 'none';
  username: string;
  /**
   * Either a plaintext password (iCloud app-specific) or an XOAUTH2
   * SASL string. The connector never logs the value; tests inject
   * a deterministic string.
   */
  auth: { kind: 'password'; password: string } | { kind: 'xoauth2'; access_token: string };
}

export const ImapListArgsSchema = MailListArgsSchema;
export const ImapGetArgsSchema = MailGetArgsSchema;
export const ImapSendArgsSchema = MailSendArgsSchema;
export const ImapReplyArgsSchema = MailReplyArgsSchema.extend({
  message_id: z.string().min(1),
  body: z.string().min(1),
  reply_all: z.boolean().default(false),
});
export const ImapForwardArgsSchema = MailForwardArgsSchema;

export class ImapConnector implements Connector {
  readonly id: ConnectorId = 'imap';
  readonly operations = [
    'mail.list',
    'mail.get',
    'mail.send',
    'mail.reply',
    'mail.forward',
    'dm.conversations.list',
    'dm.send',
  ] as const;

  private readonly clientFactory: ImapConnectorOptions['clientFactory'];
  private readonly credentialsFor: ImapConnectorOptions['credentialsFor'];
  private readonly defaultMailbox: string;

  constructor(opts: ImapConnectorOptions) {
    this.clientFactory = opts.clientFactory;
    this.credentialsFor = opts.credentialsFor;
    this.defaultMailbox = opts.defaultMailbox ?? 'INBOX';
  }

  private async withClient<T>(account: { id: string; handle: string }, fn: (client: ImapClient) => Promise<T>): Promise<T> {
    const credentials = await this.credentialsFor(account.id);
    const client = await this.clientFactory({ id: account.id, handle: account.handle, credentials });
    try {
      await client.connect();
      return await fn(client);
    } finally {
      await client.logout().catch(() => undefined);
    }
  }

  async listMessages(request: ConnectorRequest, _audit: AuditLog): Promise<MailListResult> {
    const args = ImapListArgsSchema.parse(request.args);
    return this.withClient(request.account, async (client) => {
      await client.selectMailbox(this.defaultMailbox);
      const messages = await client.fetchHeaders({ mailbox: this.defaultMailbox, range: `1:${args.limit}` });
      return { messages: messages.map((m) => normaliseImapMessage(request.account.id, m)), next_page_token: null };
    });
  }

  async getMessage(request: ConnectorRequest, _audit: AuditLog): Promise<MailGetResult> {
    const args = ImapGetArgsSchema.parse(request.args);
    return this.withClient(request.account, async (client) => {
      const raw = await client.fetchBody({ mailbox: this.defaultMailbox, uid: args.message_id });
      return { message: normaliseImapMessage(request.account.id, raw) };
    });
  }

  async sendMessage(request: ConnectorRequest, _audit: AuditLog): Promise<MailSendResult> {
    const args = ImapSendArgsSchema.parse(request.args);
    return this.withClient(request.account, async (client) => {
      const raw = buildImapRawMessage({
        from: request.account.handle,
        to: args.to,
        subject: args.subject,
        body: args.body,
      });
      const out = await client.appendMessage({ mailbox: 'Sent', raw, flags: ['\\Seen'] });
      return { provider_message_id: out.uid, thread_id: args.thread_id };
    });
  }

  async replyMessage(request: ConnectorRequest, _audit: AuditLog): Promise<MailReplyResult> {
    const args = ImapReplyArgsSchema.parse(request.args);
    return this.withClient(request.account, async (client) => {
      const original = await client.fetchBody({ mailbox: this.defaultMailbox, uid: args.message_id });
      const replyTo = original.envelope.from?.address ?? '';
      const subjectHeader = original.envelope.subject ?? '';
      const subject = subjectHeader.toLowerCase().startsWith('re:')
        ? subjectHeader
        : `Re: ${subjectHeader}`;
      const raw = buildImapRawMessage({
        from: request.account.handle,
        to: [replyTo],
        subject,
        body: args.body,
        extraHeaders: [
          ...(original.envelope.messageId ? [`In-Reply-To: ${original.envelope.messageId}`] : []),
        ],
      });
      const out = await client.appendMessage({ mailbox: 'Sent', raw, flags: ['\\Seen', '\\Answered'] });
      return { provider_message_id: out.uid, thread_id: original.envelope.messageId ?? args.message_id };
    });
  }

  async forwardMessage(request: ConnectorRequest, _audit: AuditLog): Promise<MailForwardResult> {
    const args = ImapForwardArgsSchema.parse(request.args);
    return this.withClient(request.account, async (client) => {
      const original = await client.fetchBody({ mailbox: this.defaultMailbox, uid: args.message_id });
      const subjectHeader = original.envelope.subject ?? '';
      const subject = subjectHeader.toLowerCase().startsWith('fwd:')
        ? subjectHeader
        : `Fwd: ${subjectHeader}`;
      const raw = buildImapRawMessage({
        from: request.account.handle,
        to: args.to,
        subject,
        body: [
          args.body ?? '',
          '',
          '---------- Forwarded message ----------',
          `From: ${original.envelope.from?.address ?? ''}`,
          `Date: ${original.envelope.date ?? ''}`,
          `Subject: ${original.envelope.subject ?? ''}`,
          '',
          original.bodyText ?? '',
        ].join('\n'),
      });
      const out = await client.appendMessage({ mailbox: 'Sent', raw, flags: ['\\Seen'] });
      return { provider_message_id: out.uid };
    });
  }

  async listConversations(
    request: ConnectorRequest,
    _audit: AuditLog,
  ): Promise<DmConversationsListResult> {
    void request;
    return { conversations: [], next_page_token: null };
  }

  async sendDm(): Promise<DmSendResult> {
    throw new ConnectorError('not_found', 'IMAP is mail-shaped; use mail.send instead');
  }

  async listCalendars(): Promise<CalendarsListResult> {
    throw new ConnectorError('not_found', 'ImapConnector does not implement calendar operations');
  }
  async listEvents(): Promise<EventsListResult> {
    throw new ConnectorError('not_found', 'ImapConnector does not implement calendar operations');
  }
  async getEvent(): Promise<EventGetResult> {
    throw new ConnectorError('not_found', 'ImapConnector does not implement calendar operations');
  }
  async createEvent(): Promise<EventCreateResult> {
    throw new ConnectorError('not_found', 'ImapConnector does not implement calendar operations');
  }
  async updateEvent(): Promise<EventUpdateResult> {
    throw new ConnectorError('not_found', 'ImapConnector does not implement calendar operations');
  }
  async deleteEvent(): Promise<EventDeleteResult> {
    throw new ConnectorError('not_found', 'ImapConnector does not implement calendar operations');
  }
}

function normaliseImapMessage(account_id: string, raw: ImapMessage): Message {
  return MessageSchema.parse({
    id: raw.uid,
    account_id,
    thread_id: raw.envelope.messageId ?? null,
    direction: 'in',
    from: raw.envelope.from ?? { address: 'unknown@invalid' },
    to: raw.envelope.to ?? [],
    cc: raw.envelope.cc ?? [],
    subject: raw.envelope.subject,
    preview: (raw.bodyText ?? '').slice(0, 280),
    body_text: raw.bodyText ?? '',
    body_html: raw.bodyHtml,
    attachments: [],
    labels: raw.flags,
    folder: raw.mailbox,
    status_flags: { read: raw.flags.includes('\\Seen') },
    received_at: raw.envelope.date ? new Date(raw.envelope.date).toISOString() : new Date().toISOString(),
    provider_ref: { provider: 'imap', native_id: raw.uid },
  });
}

function buildImapRawMessage(input: {
  from: string;
  to: string[];
  subject: string;
  body: string;
  extraHeaders?: string[];
}): string {
  const headers = [
    `From: ${input.from}`,
    `To: ${input.to.join(', ')}`,
    `Subject: ${input.subject}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${Math.random().toString(36).slice(2)}@fagaos.local>`,
    `Content-Type: text/plain; charset="UTF-8"`,
    ...(input.extraHeaders ?? []),
    '',
    input.body,
  ].join('\r\n');
  return headers;
}
