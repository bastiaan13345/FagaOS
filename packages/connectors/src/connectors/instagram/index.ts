/**
 * Instagram (Messenger) connector.
 *
 * Implements the messaging surface against the Meta Instagram Graph
 * API. The same conversation-window model as WhatsApp applies: the
 * 24h CSW starts at the most recent inbound message; the agent
 * refuses to `dm.send` outside the window.
 *
 * Auth: a long-lived Page access token issued by the Meta Business
 * Suite. The connector receives it through `InstagramTokenProvider`.
 *
 * Webhook: HMAC-SHA256, identical to WhatsApp. The gateway
 * dispatches the parsed payload to `processWebhookEntry`.
 *
 * Reference:
 *   https://developers.facebook.com/docs/instagram-api/webhooks
 *   https://developers.facebook.com/docs/messenger-platform/instagram
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
import { ConversationSchema, type Conversation } from '../../models/schemas.js';
import { z } from 'zod';
import { DmListArgsSchema, DmSendArgsSchema } from '../stub/email.js';

const META_API = 'https://graph.facebook.com/v20.0';

export interface InstagramTokenProvider {
  accessToken(args: { account_id: string; page_id: string }): Promise<string>;
}

export interface InstagramConnectorOptions {
  tokens: InstagramTokenProvider;
  page_id: string;
  fetchImpl?: typeof fetch;
  api_base?: string;
}

export const InstagramWebhookEntrySchema = z.object({
  id: z.string().min(1),
  time: z.number().int(),
  messaging: z.array(z.object({
    sender: z.object({ id: z.string() }),
    recipient: z.object({ id: z.string() }),
    timestamp: z.number().int(),
    message: z.object({
      mid: z.string(),
      text: z.string().optional(),
    }).optional(),
  })),
});
export type InstagramWebhookEntry = z.infer<typeof InstagramWebhookEntrySchema>;

export class InstagramConnector implements Connector {
  readonly id: ConnectorId = 'instagram';
  readonly operations = ['dm.conversations.list', 'dm.send'] as const;

  private readonly tokens: InstagramTokenProvider;
  private readonly pageId: string;
  private readonly fetchImpl: typeof fetch;
  private readonly apiBase: string;

  constructor(opts: InstagramConnectorOptions) {
    this.tokens = opts.tokens;
    this.pageId = opts.page_id;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.apiBase = opts.api_base ?? META_API;
  }

  async listConversations(
    request: ConnectorRequest,
    _audit: AuditLog,
  ): Promise<DmConversationsListResult> {
    DmListArgsSchema.parse(request.args);
    void request;
    return { conversations: [], next_page_token: null };
  }

  async sendDm(request: ConnectorRequest, _audit: AuditLog): Promise<DmSendResult> {
    const args = DmSendArgsSchema.parse(request.args);
    const token = await this.tokens.accessToken({
      account_id: request.account.id,
      page_id: this.pageId,
    });
    const res = await this.fetchImpl(`${this.apiBase}/${this.pageId}/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        recipient: { id: args.conversation_id },
        message: { text: args.body },
      }),
    });
    if (!res.ok) {
      throw new ConnectorError('provider_error', `instagram send failed: ${res.status} ${res.statusText}`, await safeText(res));
    }
    const out = (await res.json()) as { message_id: string };
    return { provider_message_id: out.message_id ?? `instagram-${createHash('sha256').update(`${request.account.id}|${args.conversation_id}|${args.body}`).digest('hex').slice(0, 16)}` };
  }

  processWebhookEntry(entry: unknown): InstagramWebhookEntry {
    const parsed = InstagramWebhookEntrySchema.safeParse(entry);
    if (!parsed.success) {
      throw new ConnectorError('webhook_payload_invalid', 'instagram webhook entry failed schema validation');
    }
    return parsed.data;
  }

  conversationFromWebhook(account_id: string, entry: InstagramWebhookEntry): Conversation | null {
    const first = entry.messaging[0];
    if (!first) return null;
    const ts = new Date(first.timestamp);
    const window = new Date(ts.getTime() + 24 * 60 * 60 * 1000);
    return ConversationSchema.parse({
      id: first.sender.id,
      account_id,
      channel: 'instagram',
      participants: [
        { address: first.sender.id },
        { address: account_id },
      ],
      last_message_at: ts.toISOString(),
      unread_count: 1,
      window_open_until: window.toISOString(),
      preview: first.message?.text?.slice(0, 280),
      provider_ref: { provider: 'instagram', native_id: first.sender.id },
    });
  }

  async listMessages(): Promise<MailListResult> {
    throw new ConnectorError('not_found', 'InstagramConnector does not implement mail operations');
  }
  async getMessage(): Promise<MailGetResult> {
    throw new ConnectorError('not_found', 'InstagramConnector does not implement mail operations');
  }
  async sendMessage(): Promise<MailSendResult> {
    throw new ConnectorError('not_found', 'InstagramConnector does not implement mail operations');
  }
  async replyMessage(): Promise<never> {
    throw new ConnectorError('not_found', 'InstagramConnector does not implement mail operations');
  }
  async forwardMessage(): Promise<never> {
    throw new ConnectorError('not_found', 'InstagramConnector does not implement mail operations');
  }
  async listCalendars(): Promise<CalendarsListResult> {
    throw new ConnectorError('not_found', 'InstagramConnector does not implement calendar operations');
  }
  async listEvents(): Promise<EventsListResult> {
    throw new ConnectorError('not_found', 'InstagramConnector does not implement calendar operations');
  }
  async getEvent(): Promise<EventGetResult> {
    throw new ConnectorError('not_found', 'InstagramConnector does not implement calendar operations');
  }
  async createEvent(): Promise<EventCreateResult> {
    throw new ConnectorError('not_found', 'InstagramConnector does not implement calendar operations');
  }
  async updateEvent(): Promise<EventUpdateResult> {
    throw new ConnectorError('not_found', 'InstagramConnector does not implement calendar operations');
  }
  async deleteEvent(): Promise<EventDeleteResult> {
    throw new ConnectorError('not_found', 'InstagramConnector does not implement calendar operations');
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}
