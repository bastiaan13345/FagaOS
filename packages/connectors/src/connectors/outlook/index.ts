/**
 * Outlook (Microsoft Graph) mail connector.
 *
 * Implements the normalised mail surface against the Microsoft Graph
 * endpoint `https://graph.microsoft.com/v1.0`. Highlights:
 *
 *   - `mail.list` → `GET /me/messages` with OData `$filter` on
 *     `receivedDateTime ge {time_min}` and a `$select` for the
 *     headers we normalise.
 *   - `mail.get` → `GET /me/messages/{id}` with `$expand=attachments`
 *     so attachments surface in the normalised Message.
 *   - `mail.send` → `POST /me/sendMail` with a `Message` envelope.
 *     The envelope is built from the same `buildRawMessage` helper
 *     we use in Gmail, but base64-encoded as the Graph API expects.
 *   - `mail.reply` → `POST /me/messages/{id}/reply` or `replyAll`.
 *   - `mail.forward` → `POST /me/messages/{id}/forward`.
 *
 * Auth: the connector receives an access token through a
 * `GraphTokenProvider`. Production deployments require the scopes
 * enumerated in `oauth/microsoft_graph.ts`.
 *
 * Push: Graph webhooks are managed with a `subscription` resource
 * (`/subscriptions`). The connector exposes `processLifecycle` to
 * detect the `reauthorizationRequired` lifecycle event the gateway
 * must react to.
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
import type { GraphTokenProvider } from './token-provider.js';
import {
  MailListArgsSchema,
  MailGetArgsSchema,
  MailSendArgsSchema,
  MailReplyArgsSchema,
  MailForwardArgsSchema,
  DmListArgsSchema,
} from '../stub/email.js';

const GRAPH_API = 'https://graph.microsoft.com/v1.0';

export interface OutlookConnectorOptions {
  tokens: GraphTokenProvider;
  fetchImpl?: typeof fetch;
  api_base?: string;
  read_only?: boolean;
}

export const OutlookSubscriptionLifecycleSchema = z.object({
  lifecycleEvent: z.enum(['reauthorizationRequired', 'subscriptionRemoved', 'missed']),
  subscriptionId: z.string().min(1),
  resource: z.string().optional(),
  organizationId: z.string().optional(),
});
export type OutlookSubscriptionLifecycle = z.infer<typeof OutlookSubscriptionLifecycleSchema>;

export class OutlookConnector implements Connector {
  readonly id: ConnectorId = 'outlook';
  readonly operations = [
    'mail.list',
    'mail.get',
    'mail.send',
    'mail.reply',
    'mail.forward',
    'dm.conversations.list',
    'dm.send',
  ] as const;

  private readonly tokens: GraphTokenProvider;
  private readonly fetchImpl: typeof fetch;
  private readonly apiBase: string;
  private readonly readOnly: boolean;

  constructor(opts: OutlookConnectorOptions) {
    this.tokens = opts.tokens;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.apiBase = opts.api_base ?? GRAPH_API;
    this.readOnly = opts.read_only ?? true;
  }

  async listMessages(request: ConnectorRequest, _audit: AuditLog): Promise<MailListResult> {
    const args = MailListArgsSchema.parse(request.args);
    const token = await this.tokens.accessToken({
      account_id: request.account.id,
      scopes: ['Mail.Read'],
    });
    const url = new URL(`${this.apiBase}/me/messages`);
    if (args.query && args.query !== 'in:inbox') {
      url.searchParams.set('$search', `"${args.query}"`);
    } else {
      url.searchParams.set('$filter', 'isRead eq false');
    }
    url.searchParams.set('$top', String(Math.min(args.limit, 50)));
    if (args.page_token) url.searchParams.set('$skiptoken', args.page_token);
    const out = await this.graphGet<GraphListResponse<GraphMessage>>(url.toString(), token);
    const messages: Message[] = (out.value ?? []).map((m) => this.normaliseMessage(request.account.id, m));
    return { messages, next_page_token: out['@odata.nextLink'] ?? null };
  }

  async getMessage(request: ConnectorRequest, _audit: AuditLog): Promise<MailGetResult> {
    const args = MailGetArgsSchema.parse(request.args);
    const token = await this.tokens.accessToken({
      account_id: request.account.id,
      scopes: ['Mail.Read'],
    });
    const out = await this.graphGet<GraphMessage>(
      `${this.apiBase}/me/messages/${encodeURIComponent(args.message_id)}?$expand=attachments`,
      token,
    );
    return { message: this.normaliseMessage(request.account.id, out) };
  }

  async sendMessage(request: ConnectorRequest, _audit: AuditLog): Promise<MailSendResult> {
    if (this.readOnly) {
      throw new ConnectorError('forbidden', 'OutlookConnector is in read-only mode for this build');
    }
    const args = MailSendArgsSchema.parse(request.args);
    const token = await this.tokens.accessToken({
      account_id: request.account.id,
      scopes: ['Mail.Send'],
    });
    const payload = {
      message: {
        subject: args.subject,
        body: { contentType: 'Text', content: args.body },
        toRecipients: args.to.map((a) => ({ emailAddress: { address: a } })),
      },
      saveToSentItems: true,
    };
    const res = await this.fetchImpl(`${this.apiBase}/me/sendMail`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      throw new ConnectorError('provider_error', `graph sendMail failed: ${res.status} ${res.statusText}`, await safeText(res));
    }
    // Graph sendMail returns 202 with no body. Derive a deterministic
    // id from the request envelope for idempotency.
    const id = `outlook-msg-${createHash('sha256')
      .update(`${request.account.id}|${args.subject}|${args.body}|${args.to.join(',')}`)
      .digest('hex')
      .slice(0, 16)}`;
    return { provider_message_id: id, thread_id: args.thread_id };
  }

  async replyMessage(request: ConnectorRequest, _audit: AuditLog): Promise<MailReplyResult> {
    if (this.readOnly) {
      throw new ConnectorError('forbidden', 'OutlookConnector is in read-only mode for this build');
    }
    const args = MailReplyArgsSchema.parse(request.args);
    const token = await this.tokens.accessToken({
      account_id: request.account.id,
      scopes: ['Mail.ReadWrite'],
    });
    const path = args.reply_all ? 'replyAll' : 'reply';
    const res = await this.fetchImpl(`${this.apiBase}/me/messages/${encodeURIComponent(args.message_id)}/${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ comment: args.body }),
    });
    if (!res.ok) {
      throw new ConnectorError('provider_error', `graph ${path} failed: ${res.status} ${res.statusText}`, await safeText(res));
    }
    return { provider_message_id: `outlook-reply-${args.message_id}`, thread_id: `outlook-thread-${args.message_id}` };
  }

  async forwardMessage(request: ConnectorRequest, _audit: AuditLog): Promise<MailForwardResult> {
    if (this.readOnly) {
      throw new ConnectorError('forbidden', 'OutlookConnector is in read-only mode for this build');
    }
    const args = MailForwardArgsSchema.parse(request.args);
    const token = await this.tokens.accessToken({
      account_id: request.account.id,
      scopes: ['Mail.ReadWrite'],
    });
    const res = await this.fetchImpl(`${this.apiBase}/me/messages/${encodeURIComponent(args.message_id)}/forward`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        comment: args.body ?? '',
        toRecipients: args.to.map((a) => ({ emailAddress: { address: a } })),
      }),
    });
    if (!res.ok) {
      throw new ConnectorError('provider_error', `graph forward failed: ${res.status} ${res.statusText}`, await safeText(res));
    }
    return { provider_message_id: `outlook-fwd-${args.message_id}` };
  }

  async listConversations(
    request: ConnectorRequest,
    _audit: AuditLog,
  ): Promise<DmConversationsListResult> {
    DmListArgsSchema.parse(request.args);
    void request;
    return { conversations: [], next_page_token: null };
  }

  async sendDm(): Promise<DmSendResult> {
    throw new ConnectorError('not_found', 'Outlook is mail-shaped; use mail.send instead');
  }

  // Calendar operations are not implemented in this connector; they
  // live in the OutlookCalendarConnector.
  async listCalendars(): Promise<CalendarsListResult> {
    throw new ConnectorError('not_found', 'OutlookConnector does not implement calendar operations');
  }
  async listEvents(): Promise<EventsListResult> {
    throw new ConnectorError('not_found', 'OutlookConnector does not implement calendar operations');
  }
  async getEvent(): Promise<EventGetResult> {
    throw new ConnectorError('not_found', 'OutlookConnector does not implement calendar operations');
  }
  async createEvent(): Promise<EventCreateResult> {
    throw new ConnectorError('not_found', 'OutlookConnector does not implement calendar operations');
  }
  async updateEvent(): Promise<EventUpdateResult> {
    throw new ConnectorError('not_found', 'OutlookConnector does not implement calendar operations');
  }
  async deleteEvent(): Promise<EventDeleteResult> {
    throw new ConnectorError('not_found', 'OutlookConnector does not implement calendar operations');
  }

  /**
   * Decode a Graph subscription lifecycle notification. The connector
   * returns the parsed event; the gateway reacts by re-subscribing
   * (for `reauthorizationRequired`) or alerting the user (for
   * `subscriptionRemoved` / `missed`).
   */
  processLifecycle(notification: unknown): OutlookSubscriptionLifecycle {
    const parsed = OutlookSubscriptionLifecycleSchema.safeParse(notification);
    if (!parsed.success) {
      throw new ConnectorError('webhook_payload_invalid', 'graph subscription lifecycle failed schema validation');
    }
    return parsed.data;
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private async graphGet<T>(url: string, token: string): Promise<T> {
    const res = await this.fetchImpl(url, { headers: { authorization: `Bearer ${token}` } });
    if (res.status === 404) throw new ConnectorError('not_found', `graph 404: ${url}`);
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

  private normaliseMessage(account_id: string, raw: GraphMessage): Message {
    const from = raw.from?.emailAddress
      ? { address: raw.from.emailAddress.address, name: raw.from.emailAddress.name }
      : { address: 'unknown@invalid' };
    const to = (raw.toRecipients ?? []).map((r) => ({
      address: r.emailAddress.address,
      name: r.emailAddress.name,
    }));
    const cc = (raw.ccRecipients ?? []).map((r) => ({
      address: r.emailAddress.address,
      name: r.emailAddress.name,
    }));
    return MessageSchema.parse({
      id: raw.id,
      account_id,
      thread_id: raw.conversationId ?? null,
      direction: 'in',
      from,
      to,
      cc,
      subject: raw.subject,
      preview: (raw.bodyPreview ?? '').slice(0, 280),
      body_text: raw.body?.contentType === 'text' ? raw.body.content : (raw.bodyPreview ?? ''),
      body_html: raw.body?.contentType === 'html' ? raw.body.content : undefined,
      attachments: (raw.attachments ?? []).map((a) => ({
        id: a.id,
        filename: a.name ?? 'attachment',
        mime_type: a.contentType ?? 'application/octet-stream',
        size_bytes: a.size ?? 0,
        disposition: a.isInline ? 'inline' : 'attachment',
      })),
      labels: [],
      folder: raw.parentFolderId,
      status_flags: { read: raw.isRead ?? false, starred: raw.flag?.flagStatus === 'flagged' },
      received_at: raw.receivedDateTime ?? raw.sentDateTime ?? new Date().toISOString(),
      sent_at: raw.sentDateTime ?? undefined,
      provider_ref: { provider: 'outlook', native_id: raw.id, etag: raw['@odata.etag'] },
    });
  }
}

import { createHash } from 'node:crypto';

interface GraphListResponse<T> {
  value?: T[];
  '@odata.nextLink'?: string;
}

interface GraphMessage {
  id: string;
  conversationId?: string;
  subject?: string;
  bodyPreview?: string;
  receivedDateTime?: string;
  sentDateTime?: string;
  isRead?: boolean;
  parentFolderId?: string;
  from?: { emailAddress: { address: string; name?: string } };
  toRecipients?: Array<{ emailAddress: { address: string; name?: string } }>;
  ccRecipients?: Array<{ emailAddress: { address: string; name?: string } }>;
  body?: { contentType: 'text' | 'html'; content: string };
  attachments?: Array<{
    id: string;
    name?: string;
    contentType?: string;
    size?: number;
    isInline?: boolean;
  }>;
  flag?: { flagStatus?: string };
  '@odata.etag'?: string;
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}
