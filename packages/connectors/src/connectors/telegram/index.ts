/**
 * Telegram connector.
 *
 * Implements the messaging surface against the Telegram Bot API
 * (`https://api.telegram.org/bot<token>`). The connector is stateless
 * beyond the per-account bot token; the bot's "conversations" are
 * the chats it has been added to.
 *
 * Auth: a bot token issued by `@BotFather`. Stored in the
 * credential vault, surfaced to the connector through
 * `TelegramTokenProvider`.
 *
 * Webhook: set with `setWebhook` and authenticated with a
 * `secret_token` chosen at registration time. The gateway verifies
 * the `X-Telegram-Bot-Api-Secret-Token` header on every ingress.
 *
 * Reference:
 *   https://core.telegram.org/bots/api
 *   https://core.telegram.org/bots/webhooks
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

export interface TelegramTokenProvider {
  accessToken(args: { account_id: string }): Promise<string>;
}

export interface TelegramConnectorOptions {
  tokens: TelegramTokenProvider;
  fetchImpl?: typeof fetch;
}

export const TelegramUpdateSchema = z.object({
  update_id: z.number().int(),
  message: z.object({
    message_id: z.number().int(),
    date: z.number().int(),
    chat: z.object({ id: z.union([z.number().int(), z.string()]), type: z.string() }),
    from: z.object({ id: z.union([z.number().int(), z.string()]), first_name: z.string().optional(), username: z.string().optional() }).optional(),
    text: z.string().optional(),
  }).optional(),
  edited_message: z.unknown().optional(),
  callback_query: z.unknown().optional(),
});
export type TelegramUpdate = z.infer<typeof TelegramUpdateSchema>;

export class TelegramConnector implements Connector {
  readonly id: ConnectorId = 'telegram';
  readonly operations = ['dm.conversations.list', 'dm.send'] as const;

  private readonly tokens: TelegramTokenProvider;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: TelegramConnectorOptions) {
    this.tokens = opts.tokens;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  private async callApi<T>(accountId: string, method: string, body: Record<string, unknown>): Promise<T> {
    const token = await this.tokens.accessToken({ account_id: accountId });
    const res = await this.fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.status === 429) {
      const retry = Number(res.headers.get('retry-after') ?? '1');
      throw new ConnectorError('rate_limited', `telegram throttled; retry after ${retry}s`);
    }
    if (!res.ok) {
      throw new ConnectorError('provider_error', `telegram ${method} failed: ${res.status} ${res.statusText}`, await safeText(res));
    }
    const out = (await res.json()) as { ok: boolean; result: T; description?: string };
    if (!out.ok) {
      throw new ConnectorError('provider_error', `telegram ${method} returned error: ${out.description ?? 'unknown'}`);
    }
    return out.result;
  }

  async listConversations(
    request: ConnectorRequest,
    _audit: AuditLog,
  ): Promise<DmConversationsListResult> {
    DmListArgsSchema.parse(request.args);
    const updates = await this.callApi<Array<{ update_id: number; message?: { chat: { id: number | string; type: string } } }>>(request.account.id, 'getUpdates', { limit: 100, timeout: 0 });
    const seen = new Map<string, { id: string; type: string; lastSeen: number }>();
    for (const u of updates) {
      if (u.message) {
        seen.set(String(u.message.chat.id), { id: String(u.message.chat.id), type: u.message.chat.type, lastSeen: u.update_id });
      }
    }
    const conversations: Conversation[] = Array.from(seen.values()).map((c) =>
      ConversationSchema.parse({
        id: c.id,
        account_id: request.account.id,
        channel: 'telegram',
        participants: [{ address: c.id }],
        last_message_at: new Date().toISOString(),
        unread_count: 0,
        provider_ref: { provider: 'telegram', native_id: c.id },
      }),
    );
    return { conversations, next_page_token: null };
  }

  async sendDm(request: ConnectorRequest, _audit: AuditLog): Promise<DmSendResult> {
    const args = DmSendArgsSchema.parse(request.args);
    const out = await this.callApi<{ message_id: number }>(request.account.id, 'sendMessage', {
      chat_id: args.conversation_id,
      text: args.body,
      disable_web_page_preview: true,
    });
    return { provider_message_id: `telegram-${out.message_id}-${createHash('sha256').update(`${request.account.id}|${args.conversation_id}|${args.body}`).digest('hex').slice(0, 8)}` };
  }

  processUpdate(update: unknown): TelegramUpdate {
    const parsed = TelegramUpdateSchema.safeParse(update);
    if (!parsed.success) {
      throw new ConnectorError('webhook_payload_invalid', 'telegram update failed schema validation');
    }
    return parsed.data;
  }

  async listMessages(): Promise<MailListResult> {
    throw new ConnectorError('not_found', 'TelegramConnector does not implement mail operations');
  }
  async getMessage(): Promise<MailGetResult> {
    throw new ConnectorError('not_found', 'TelegramConnector does not implement mail operations');
  }
  async sendMessage(): Promise<MailSendResult> {
    throw new ConnectorError('not_found', 'TelegramConnector does not implement mail operations');
  }
  async replyMessage(): Promise<never> {
    throw new ConnectorError('not_found', 'TelegramConnector does not implement mail operations');
  }
  async forwardMessage(): Promise<never> {
    throw new ConnectorError('not_found', 'TelegramConnector does not implement mail operations');
  }
  async listCalendars(): Promise<CalendarsListResult> {
    throw new ConnectorError('not_found', 'TelegramConnector does not implement calendar operations');
  }
  async listEvents(): Promise<EventsListResult> {
    throw new ConnectorError('not_found', 'TelegramConnector does not implement calendar operations');
  }
  async getEvent(): Promise<EventGetResult> {
    throw new ConnectorError('not_found', 'TelegramConnector does not implement calendar operations');
  }
  async createEvent(): Promise<EventCreateResult> {
    throw new ConnectorError('not_found', 'TelegramConnector does not implement calendar operations');
  }
  async updateEvent(): Promise<EventUpdateResult> {
    throw new ConnectorError('not_found', 'TelegramConnector does not implement calendar operations');
  }
  async deleteEvent(): Promise<EventDeleteResult> {
    throw new ConnectorError('not_found', 'TelegramConnector does not implement calendar operations');
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}
