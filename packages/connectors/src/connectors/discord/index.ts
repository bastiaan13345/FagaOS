/**
 * Discord connector.
 *
 * Implements the messaging surface against the Discord HTTP API
 * (`https://discord.com/api/v10`). The connector targets direct
 * messages (DMs) and the channel surface via the bot token.
 *
 * Auth: a bot token. The gateway wires the credential vault; the
 * connector never holds the token. Scopes required: `bot`,
 * `messages.read`, `guilds` (for guild context), `dm_channels.read`
 * for the DM list.
 *
 * Webhook: Discord Interactions Endpoint URL is signed with
 * Ed25519. The gateway verifies the `X-Signature-Ed25519` header
 * against the application's public key. See
 * `webhooks/signatures.ts` for the verification primitive.
 *
 * Reference:
 *   https://discord.com/developers/docs/reference
 *   https://discord.com/developers/docs/interactions/webhooks
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

const DISCORD_API = 'https://discord.com/api/v10';

export interface DiscordTokenProvider {
  accessToken(args: { account_id: string }): Promise<string>;
}

export interface DiscordConnectorOptions {
  tokens: DiscordTokenProvider;
  fetchImpl?: typeof fetch;
  api_base?: string;
}

export const DiscordInteractionSchema = z.object({
  id: z.union([z.string(), z.number()]),
  application_id: z.union([z.string(), z.number()]),
  type: z.number().int(),
  version: z.number().int(),
  token: z.string().min(1),
  user: z.object({ id: z.union([z.string(), z.number()]), username: z.string(), discriminator: z.string().optional() }).optional(),
  channel_id: z.union([z.string(), z.number()]).optional(),
  data: z.unknown().optional(),
});
export type DiscordInteraction = z.infer<typeof DiscordInteractionSchema>;

export class DiscordConnector implements Connector {
  readonly id: ConnectorId = 'discord';
  readonly operations = ['dm.conversations.list', 'dm.send'] as const;

  private readonly tokens: DiscordTokenProvider;
  private readonly fetchImpl: typeof fetch;
  private readonly apiBase: string;

  constructor(opts: DiscordConnectorOptions) {
    this.tokens = opts.tokens;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.apiBase = opts.api_base ?? DISCORD_API;
  }

  private async call<T>(accountId: string, method: string, path: string, body?: unknown): Promise<T> {
    const token = await this.tokens.accessToken({ account_id: accountId });
    const init: RequestInit = {
      method,
      headers: { authorization: `Bot ${token}`, 'content-type': 'application/json' },
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    const res = await this.fetchImpl(`${this.apiBase}${path}`, init);
    if (res.status === 429) {
      const retry = Number(res.headers.get('retry-after') ?? '1');
      throw new ConnectorError('rate_limited', `discord throttled; retry after ${retry}s`);
    }
    if (res.status === 401 || res.status === 403) {
      throw new ConnectorError('unauthorized', `discord auth error: ${res.status}`);
    }
    if (!res.ok) {
      throw new ConnectorError('provider_error', `discord ${method} ${path} failed: ${res.status} ${res.statusText}`, await safeText(res));
    }
    return (await res.json()) as T;
  }

  async listConversations(
    request: ConnectorRequest,
    _audit: AuditLog,
  ): Promise<DmConversationsListResult> {
    DmListArgsSchema.parse(request.args);
    const channels = await this.call<Array<{ id: string; type: number; last_message_id?: string | null }>>(request.account.id, 'GET', '/users/@me/channels');
    const conversations: Conversation[] = channels.map((c) =>
      ConversationSchema.parse({
        id: c.id,
        account_id: request.account.id,
        channel: 'discord',
        participants: [{ address: c.id }],
        last_message_at: new Date().toISOString(),
        unread_count: 0,
        provider_ref: { provider: 'discord', native_id: c.id },
      }),
    );
    return { conversations, next_page_token: null };
  }

  async sendDm(request: ConnectorRequest, _audit: AuditLog): Promise<DmSendResult> {
    const args = DmSendArgsSchema.parse(request.args);
    const out = await this.call<{ id: string }>(request.account.id, 'POST', `/channels/${args.conversation_id}/messages`, { content: args.body });
    return { provider_message_id: `${out.id}-${createHash('sha256').update(`${request.account.id}|${args.conversation_id}|${args.body}`).digest('hex').slice(0, 8)}` };
  }

  processInteraction(interaction: unknown): DiscordInteraction {
    const parsed = DiscordInteractionSchema.safeParse(interaction);
    if (!parsed.success) {
      throw new ConnectorError('webhook_payload_invalid', 'discord interaction failed schema validation');
    }
    return parsed.data;
  }

  async listMessages(): Promise<MailListResult> {
    throw new ConnectorError('not_found', 'DiscordConnector does not implement mail operations');
  }
  async getMessage(): Promise<MailGetResult> {
    throw new ConnectorError('not_found', 'DiscordConnector does not implement mail operations');
  }
  async sendMessage(): Promise<MailSendResult> {
    throw new ConnectorError('not_found', 'DiscordConnector does not implement mail operations');
  }
  async replyMessage(): Promise<never> {
    throw new ConnectorError('not_found', 'DiscordConnector does not implement mail operations');
  }
  async forwardMessage(): Promise<never> {
    throw new ConnectorError('not_found', 'DiscordConnector does not implement mail operations');
  }
  async listCalendars(): Promise<CalendarsListResult> {
    throw new ConnectorError('not_found', 'DiscordConnector does not implement calendar operations');
  }
  async listEvents(): Promise<EventsListResult> {
    throw new ConnectorError('not_found', 'DiscordConnector does not implement calendar operations');
  }
  async getEvent(): Promise<EventGetResult> {
    throw new ConnectorError('not_found', 'DiscordConnector does not implement calendar operations');
  }
  async createEvent(): Promise<EventCreateResult> {
    throw new ConnectorError('not_found', 'DiscordConnector does not implement calendar operations');
  }
  async updateEvent(): Promise<EventUpdateResult> {
    throw new ConnectorError('not_found', 'DiscordConnector does not implement calendar operations');
  }
  async deleteEvent(): Promise<EventDeleteResult> {
    throw new ConnectorError('not_found', 'DiscordConnector does not implement calendar operations');
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}
