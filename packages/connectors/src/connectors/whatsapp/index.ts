/**
 * WhatsApp Cloud connector.
 *
 * Implements the messaging surface against the Meta WhatsApp Cloud
 * API (`https://graph.facebook.com/v20.0`). The connector is
 * shaped for the conversation-window model: outbound messages
 * must be either a free-form reply inside the 24h CSW or a
 * pre-approved template. The connector surfaces the window in the
 * `Conversation.window_open_until` field; the gateway refuses
 * `dm.send` outside the window.
 *
 * Auth: a system-user access token issued by the Meta Business
 * Suite. The connector receives it through `WhatsAppTokenProvider`
 * so the credential vault stays the source of truth.
 *
 * Webhook: HMAC-SHA256 over the raw body. The gateway verifies with
 * `verifyMetaSignature` in `webhooks/signatures.ts` before
 * dispatching the parsed payload to `processWebhookEntry`.
 *
 * Reference:
 *   https://developers.facebook.com/docs/whatsapp/cloud-api
 *   https://developers.facebook.com/docs/whatsapp/business-management-api/webhooks
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

export interface WhatsAppTokenProvider {
  accessToken(args: { account_id: string; phone_number_id: string }): Promise<string>;
}

export interface WhatsAppConnectorOptions {
  tokens: WhatsAppTokenProvider;
  /** Account's WhatsApp Business phone number id. */
  phone_number_id: string;
  fetchImpl?: typeof fetch;
  api_base?: string;
}

export const WhatsAppConversationSchema = z.object({
  id: z.string().min(1),
  phone_number: z.string().min(1),
  last_message_at: z.string().datetime(),
  unread_count: z.number().int().nonnegative(),
  window_open_until: z.string().datetime().optional(),
  preview: z.string().optional(),
});
export type WhatsAppConversation = z.infer<typeof WhatsAppConversationSchema>;

export const WhatsAppWebhookEntrySchema = z.object({
  id: z.string().min(1),
  changes: z.array(
    z.object({
      field: z.string(),
      value: z.object({
        messaging_product: z.literal('whatsapp'),
        metadata: z.object({ phone_number_id: z.string(), display_phone_number: z.string().optional() }),
        contacts: z.array(z.object({ wa_id: z.string(), profile: z.object({ name: z.string().optional() }).optional() })).optional(),
        messages: z.array(z.object({
          from: z.string(),
          id: z.string(),
          timestamp: z.string(),
          type: z.string(),
          text: z.object({ body: z.string() }).optional(),
        })).optional(),
      }),
    }),
  ),
});
export type WhatsAppWebhookEntry = z.infer<typeof WhatsAppWebhookEntrySchema>;

export class WhatsAppConnector implements Connector {
  readonly id: ConnectorId = 'whatsapp';
  readonly operations = ['dm.conversations.list', 'dm.send'] as const;

  private readonly tokens: WhatsAppTokenProvider;
  private readonly phoneNumberId: string;
  private readonly fetchImpl: typeof fetch;
  private readonly apiBase: string;

  constructor(opts: WhatsAppConnectorOptions) {
    this.tokens = opts.tokens;
    this.phoneNumberId = opts.phone_number_id;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.apiBase = opts.api_base ?? META_API;
  }

  async listConversations(
    request: ConnectorRequest,
    _audit: AuditLog,
  ): Promise<DmConversationsListResult> {
    const args = DmListArgsSchema.parse(request.args);
    void args;
    void request;
    // WhatsApp Cloud does not provide a native "list conversations"
    // endpoint; the agent normally reconciles from webhook events.
    // The connector returns an empty list; the gateway may surface
    // a hint to the agent that conversations are delivered via push.
    return { conversations: [], next_page_token: null };
  }

  async sendDm(request: ConnectorRequest, _audit: AuditLog): Promise<DmSendResult> {
    const args = DmSendArgsSchema.parse(request.args);
    const token = await this.tokens.accessToken({
      account_id: request.account.id,
      phone_number_id: this.phoneNumberId,
    });
    // The conversation_id is the recipient's E.164 phone number
    // (e.g. `+15558675309`). The connector normalises it before
    // posting.
    const res = await this.fetchImpl(`${this.apiBase}/${this.phoneNumberId}/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: args.conversation_id.replace(/[^\d+]/g, ''),
        type: 'text',
        text: { body: args.body, preview_url: false },
      }),
    });
    if (!res.ok) {
      throw new ConnectorError('provider_error', `whatsapp send failed: ${res.status} ${res.statusText}`, await safeText(res));
    }
    const out = (await res.json()) as { messages: Array<{ id: string }> };
    return { provider_message_id: out.messages[0]?.id ?? `whatsapp-${createHash('sha256').update(`${request.account.id}|${args.conversation_id}|${args.body}`).digest('hex').slice(0, 16)}` };
  }

  /** Decode a Meta webhook entry; the gateway routes to a `whatsapp`
   * typed conversation update. */
  processWebhookEntry(entry: unknown): WhatsAppWebhookEntry {
    const parsed = WhatsAppWebhookEntrySchema.safeParse(entry);
    if (!parsed.success) {
      throw new ConnectorError('webhook_payload_invalid', 'whatsapp webhook entry failed schema validation');
    }
    return parsed.data;
  }

  /**
   * Build a normalised Conversation object from a webhook entry. The
   * 24h CSW is computed from the most recent inbound message
   * timestamp; outbound messages inside the window are free-form,
   * outside the window require a pre-approved template.
   */
  conversationFromWebhook(account_id: string, entry: WhatsAppWebhookEntry): Conversation | null {
    const contact = entry.changes[0]?.value.contacts?.[0];
    const inbound = entry.changes[0]?.value.messages?.[0];
    if (!contact || !inbound) return null;
    const ts = new Date(Number(inbound.timestamp) * 1000);
    const window = new Date(ts.getTime() + 24 * 60 * 60 * 1000);
    return ConversationSchema.parse({
      id: contact.wa_id,
      account_id,
      channel: 'whatsapp',
      participants: [
        { address: contact.wa_id, name: contact.profile?.name },
        { address: account_id },
      ],
      last_message_at: ts.toISOString(),
      unread_count: 1,
      window_open_until: window.toISOString(),
      preview: inbound.text?.body?.slice(0, 280),
      provider_ref: { provider: 'whatsapp', native_id: contact.wa_id },
    });
  }

  async listMessages(): Promise<MailListResult> {
    throw new ConnectorError('not_found', 'WhatsAppConnector does not implement mail operations');
  }
  async getMessage(): Promise<MailGetResult> {
    throw new ConnectorError('not_found', 'WhatsAppConnector does not implement mail operations');
  }
  async sendMessage(): Promise<MailSendResult> {
    throw new ConnectorError('not_found', 'WhatsAppConnector does not implement mail operations');
  }
  async replyMessage(): Promise<never> {
    throw new ConnectorError('not_found', 'WhatsAppConnector does not implement mail operations');
  }
  async forwardMessage(): Promise<never> {
    throw new ConnectorError('not_found', 'WhatsAppConnector does not implement mail operations');
  }
  async listCalendars(): Promise<CalendarsListResult> {
    throw new ConnectorError('not_found', 'WhatsAppConnector does not implement calendar operations');
  }
  async listEvents(): Promise<EventsListResult> {
    throw new ConnectorError('not_found', 'WhatsAppConnector does not implement calendar operations');
  }
  async getEvent(): Promise<EventGetResult> {
    throw new ConnectorError('not_found', 'WhatsAppConnector does not implement calendar operations');
  }
  async createEvent(): Promise<EventCreateResult> {
    throw new ConnectorError('not_found', 'WhatsAppConnector does not implement calendar operations');
  }
  async updateEvent(): Promise<EventUpdateResult> {
    throw new ConnectorError('not_found', 'WhatsAppConnector does not implement calendar operations');
  }
  async deleteEvent(): Promise<EventDeleteResult> {
    throw new ConnectorError('not_found', 'WhatsAppConnector does not implement calendar operations');
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}
