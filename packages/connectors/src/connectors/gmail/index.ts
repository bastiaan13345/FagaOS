/**
 * Gmail connector (read-only).
 *
 * Implements the operations Phase 1 cares about:
 *   - mail.list  → users.messages.list
 *   - mail.get   → users.messages.get
 *   - mail.send  → users.messages.send (skipped when read-only mode is on)
 *   - dm.conversations.list → not applicable (mail-shaped), returns
 *                              an empty list
 *
 * Auth: OAuth 2.0 with PKCE. The connector receives an access token
 * through a `GoogleTokenProvider` so it never holds the refresh token.
 *
 * Push: a `processPubSubMessage()` method decodes a Pub/Sub push
 * notification and returns a normalised "mail changed" event. The
 * gateway translates that to a `users.history.list` call and merges
 * deltas into the local cache.
 *
 * Tests inject a `fetch` implementation. Production uses
 * `globalThis.fetch`; the connector never reaches for a private HTTP
 * helper.
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
import { MessageSchema, type Message } from '../../models/schemas.js';
import { z } from 'zod';
import type { GoogleTokenProvider } from '../../oauth/google.js';
import { MailListArgsSchema, MailGetArgsSchema, MailSendArgsSchema, DmListArgsSchema } from '../stub/email.js';

const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1';

export interface GmailConnectorOptions {
  /**
   * Token provider. Must be wired by the gateway; the connector must
   * not be constructed without one.
   */
  tokens: GoogleTokenProvider;
  /** Override `fetch` for tests. */
  fetchImpl?: typeof fetch;
  /** Base URL for the Gmail API. Override only for tests. */
  api_base?: string;
  /** When `true`, `mail.send` and `sendMessage` throw `not_found`. */
  read_only?: boolean;
}

export const PubSubNotificationSchema = z.object({
  message: z.object({
    /** Pub/Sub `data` field, base64-encoded JSON. */
    data: z.string(),
    messageId: z.string(),
  }),
  subscription: z.string(),
});
export type PubSubNotification = z.infer<typeof PubSubNotificationSchema>;

export const GmailHistorySchema = z.object({
  emailAddress: z.string().email(),
  historyId: z.union([z.string(), z.number()]),
});
export type GmailHistory = z.infer<typeof GmailHistorySchema>;

export class GmailConnector implements Connector {
  readonly id: ConnectorId = 'gmail';
  readonly operations = [
    'mail.list',
    'mail.send',
    'mail.get',
    'dm.conversations.list',
    'dm.send',
  ] as const;

  private readonly tokens: GoogleTokenProvider;
  private readonly fetchImpl: typeof fetch;
  private readonly apiBase: string;
  private readonly readOnly: boolean;

  constructor(opts: GmailConnectorOptions) {
    this.tokens = opts.tokens;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.apiBase = opts.api_base ?? GMAIL_API;
    this.readOnly = opts.read_only ?? true;
  }

  async listMessages(
    request: ConnectorRequest,
    _audit: AuditLog,
  ): Promise<MailListResult> {
    const args = MailListArgsSchema.parse(request.args);
    const token = await this.tokens.accessToken({
      account_id: request.account.id,
      scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
    });
    const url = new URL(`${this.apiBase}/users/me/messages`);
    url.searchParams.set('q', args.query);
    url.searchParams.set('maxResults', String(args.limit));
    if (args.page_token) url.searchParams.set('pageToken', args.page_token);
    const list = await this.gmailGet<{ messages?: Array<{ id: string; threadId: string }>; nextPageToken?: string }>(
      url.toString(),
      token,
    );
    const messages: Message[] = [];
    for (const m of list.messages ?? []) {
      const full = await this.gmailGet<GmailMessage>(`${this.apiBase}/users/me/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`, token);
      messages.push(this.normaliseMessage(request.account.id, full));
    }
    return { messages, next_page_token: list.nextPageToken ?? null };
  }

  async getMessage(request: ConnectorRequest, _audit: AuditLog): Promise<MailGetResult> {
    const args = MailGetArgsSchema.parse(request.args);
    const token = await this.tokens.accessToken({
      account_id: request.account.id,
      scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
    });
    const full = await this.gmailGet<GmailMessage>(
      `${this.apiBase}/users/me/messages/${encodeURIComponent(args.message_id)}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`,
      token,
    );
    return { message: this.normaliseMessage(request.account.id, full) };
  }

  async sendMessage(request: ConnectorRequest, _audit: AuditLog): Promise<MailSendResult> {
    if (this.readOnly) {
      throw new ConnectorError('forbidden', 'GmailConnector is in read-only mode for this build');
    }
    const args = MailSendArgsSchema.parse(request.args);
    const token = await this.tokens.accessToken({
      account_id: request.account.id,
      scopes: ['https://www.googleapis.com/auth/gmail.send'],
    });
    const raw = buildRawMessage({
      from: request.account.handle,
      to: args.to,
      subject: args.subject,
      body: args.body,
    });
    const body = new URLSearchParams({ raw });
    const res = await this.fetchImpl(`${this.apiBase}/users/me/messages/send`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    });
    if (!res.ok) {
      throw new ConnectorError('provider_error', `gmail send failed: ${res.status} ${res.statusText}`, await safeText(res));
    }
    const out = (await res.json()) as { id: string; threadId: string };
    return { provider_message_id: out.id, thread_id: out.threadId };
  }

  async listConversations(
    request: ConnectorRequest,
    _audit: AuditLog,
  ): Promise<DmConversationsListResult> {
    // Gmail is mail-shaped; there are no DM conversations to surface.
    // Parse args for parity with the stub, then return an empty list.
    DmListArgsSchema.parse(request.args);
    void request;
    return { conversations: [], next_page_token: null };
  }

  async sendDm(): Promise<DmSendResult> {
    throw new ConnectorError('not_found', 'Gmail is mail-shaped; use mail.send instead');
  }

  async listCalendars(): Promise<CalendarsListResult> {
    throw new ConnectorError('not_found', 'GmailConnector does not implement calendar operations');
  }
  async listEvents(): Promise<EventsListResult> {
    throw new ConnectorError('not_found', 'GmailConnector does not implement calendar operations');
  }
  async getEvent(): Promise<EventGetResult> {
    throw new ConnectorError('not_found', 'GmailConnector does not implement calendar operations');
  }

  // -------------------------------------------------------------------------
  // Push / history — backstop
  // -------------------------------------------------------------------------

  /**
   * Decode a Pub/Sub push notification. The `data` field is
   * base64url-encoded JSON; the connector returns the parsed
   * `GmailHistory` so the gateway can drive a `users.history.list`
   * backfill. Throws `webhook_payload_invalid` on parse failure.
   */
  processPubSubMessage(notification: unknown): GmailHistory {
    const parsed = PubSubNotificationSchema.safeParse(notification);
    if (!parsed.success) {
      throw new ConnectorError('webhook_payload_invalid', 'Pub/Sub notification failed schema validation');
    }
    let decoded: string;
    try {
      decoded = Buffer.from(parsed.data.message.data, 'base64').toString('utf8');
    } catch {
      throw new ConnectorError('webhook_payload_invalid', 'Pub/Sub message data is not valid base64');
    }
    let body: unknown;
    try {
      body = JSON.parse(decoded);
    } catch {
      throw new ConnectorError('webhook_payload_invalid', 'Pub/Sub message data is not valid JSON');
    }
    const hist = GmailHistorySchema.safeParse(body);
    if (!hist.success) {
      throw new ConnectorError('webhook_payload_invalid', 'Pub/Sub message body is not a Gmail history notification');
    }
    return hist.data;
  }

  /**
   * `users.history.list` backfill. The caller supplies the
   * `startHistoryId` it stored when the last sync completed; the
   * connector returns the latest `historyId` and the union of
   * `messagesAdded`/`messagesDeleted` ids. The gateway is responsible
   * for fetching the actual message bodies in a follow-up call.
   */
  async listHistory(
    account_id: string,
    start_history_id: string,
  ): Promise<{ history_id: string; added: string[]; deleted: string[] }> {
    const token = await this.tokens.accessToken({
      account_id,
      scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
    });
    const url = new URL(`${this.apiBase}/users/me/history`);
    url.searchParams.set('startHistoryId', start_history_id);
    url.searchParams.set('historyTypes', 'messageAdded');
    url.searchParams.set('historyTypes', 'messageDeleted');
    const out = await this.gmailGet<{
      history?: Array<{
        id: string;
        messagesAdded?: Array<{ message: { id: string } }>;
        messagesDeleted?: Array<{ message: { id: string } }>;
      }>;
    }>(url.toString(), token);
    const added: string[] = [];
    const deleted: string[] = [];
    let latest = start_history_id;
    for (const h of out.history ?? []) {
      if (Number(h.id) > Number(latest)) latest = h.id;
      for (const m of h.messagesAdded ?? []) added.push(m.message.id);
      for (const m of h.messagesDeleted ?? []) deleted.push(m.message.id);
    }
    return { history_id: latest, added, deleted };
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  private async gmailGet<T>(url: string, token: string): Promise<T> {
    const res = await this.fetchImpl(url, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (res.status === 404) {
      throw new ConnectorError('not_found', `gmail api 404: ${url}`);
    }
    if (res.status === 401 || res.status === 403) {
      throw new ConnectorError('unauthorized', `gmail api auth error: ${res.status}`);
    }
    if (!res.ok) {
      throw new ConnectorError('provider_error', `gmail api error ${res.status} ${res.statusText}`, await safeText(res));
    }
    return (await res.json()) as T;
  }

  private normaliseMessage(account_id: string, raw: GmailMessage): Message {
    const headers = Object.fromEntries(
      (raw.payload?.headers ?? []).map((h) => [h.name.toLowerCase(), h.value]),
    );
    const from = parseAddress(headers['from'] ?? '');
    const to = parseAddressList(headers['to'] ?? '');
    const bodyText = decodeBody(raw.payload);
    const preview = (bodyText ?? '').slice(0, 280);
    return MessageSchema.parse({
      id: raw.id,
      account_id,
      thread_id: raw.threadId ?? null,
      direction: 'in',
      from,
      to,
      cc: parseAddressList(headers['cc'] ?? ''),
      subject: headers['subject'],
      preview,
      body_text: bodyText,
      body_html: undefined,
      attachments: [],
      labels: raw.labelIds ?? [],
      folder: undefined,
      status_flags: { read: !(raw.labelIds ?? []).includes('UNREAD') },
      received_at: headers['date'] ? new Date(headers['date']).toISOString() : new Date(Number(raw.internalDate ?? Date.now())).toISOString(),
      provider_ref: { provider: 'gmail', native_id: raw.id },
    });
  }
}

// ---------------------------------------------------------------------------
// Gmail wire-format helpers
// ---------------------------------------------------------------------------

interface GmailMessagePart {
  mimeType?: string;
  body?: { data?: string };
  parts?: GmailMessagePart[];
}

interface GmailMessage {
  id: string;
  threadId?: string;
  labelIds?: string[];
  internalDate?: string;
  payload?: {
    headers?: Array<{ name: string; value: string }>;
    body?: { data?: string };
    parts?: GmailMessagePart[];
  };
}

function parseAddress(input: string): { address: string; name?: string } {
  const trimmed = input.trim();
  if (!trimmed) return { address: 'unknown@invalid' };
  const match = /^(.*?)\s*<([^>]+)>\s*$/.exec(trimmed);
  if (match) {
    const name = match[1]?.replace(/^"|"$/g, '').trim();
    return name ? { address: match[2]!, name } : { address: match[2]! };
  }
  return { address: trimmed };
}

function parseAddressList(input: string): Array<{ address: string; name?: string }> {
  return input
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(parseAddress);
}

function decodeBody(
  payload: { body?: { data?: string }; parts?: GmailMessagePart[] } | null | undefined,
): string {
  if (!payload) return '';
  if (payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64').toString('utf8');
  }
  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body?.data) {
        return Buffer.from(part.body.data, 'base64').toString('utf8');
      }
      if (part.parts) {
        const sub: { body?: { data?: string }; parts?: GmailMessagePart[] } = { parts: part.parts };
        if (part.body) sub.body = part.body;
        const nested = decodeBody(sub);
        if (nested) return nested;
      }
    }
  }
  return '';
}

function buildRawMessage(input: {
  from: string;
  to: string[];
  subject: string;
  body: string;
}): string {
  const headers = [
    `From: ${input.from}`,
    `To: ${input.to.join(', ')}`,
    `Subject: ${input.subject}`,
    `Content-Type: text/plain; charset="UTF-8"`,
    '',
    input.body,
  ].join('\r\n');
  return Buffer.from(headers)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}
