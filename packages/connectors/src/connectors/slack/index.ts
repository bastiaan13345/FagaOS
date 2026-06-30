/**
 * Slack connector.
 *
 * Implements the messaging surface against the Slack Web API
 * (`https://slack.com/api`). The connector targets direct messages
 * (DMs) and channels. Channel lists are exposed as
 * `Conversation` records; channel `id` doubles as the
 * `conversation_id` argument to `dm.send`.
 *
 * Auth: a bot user OAuth token (`xoxb-...`) with `chat:write`,
 * `im:history`, `im:read`, `channels:read`, `groups:read`,
 * `mpim:read`, and `users:read` scopes. The gateway wires the
 * credential vault; the connector never holds the token.
 *
 * Webhook: Slack Events API is signed with HMAC-SHA256 over the raw
 * body using the workspace's "Signing Secret". The gateway verifies
 * the `X-Slack-Signature` and `X-Slack-Request-Timestamp` headers
 * with `verifySlackSignature` in `webhooks/signatures.ts`.
 *
 * Reference:
 *   https://api.slack.com/web
 *   https://api.slack.com/events/url_verification
 *   https://api.slack.com/authentication/verifying-requests-from-slack
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

const SLACK_API = 'https://slack.com/api';

export interface SlackTokenProvider {
  accessToken(args: { account_id: string }): Promise<string>;
}

export interface SlackConnectorOptions {
  tokens: SlackTokenProvider;
  fetchImpl?: typeof fetch;
  api_base?: string;
}

export const SlackEventEnvelopeSchema = z.object({
  token: z.string().min(1),
  team_id: z.string().min(1),
  api_app_id: z.string().min(1),
  event: z.object({
    type: z.string().min(1),
    user: z.string().optional(),
    channel: z.string().optional(),
    text: z.string().optional(),
    ts: z.string().optional(),
  }),
  type: z.string().min(1),
  event_id: z.string().min(1),
  event_time: z.number().int(),
});
export type SlackEventEnvelope = z.infer<typeof SlackEventEnvelopeSchema>;

export class SlackConnector implements Connector {
  readonly id: ConnectorId = 'slack';
  readonly operations = ['dm.conversations.list', 'dm.send'] as const;

  private readonly tokens: SlackTokenProvider;
  private readonly fetchImpl: typeof fetch;
  private readonly apiBase: string;

  constructor(opts: SlackConnectorOptions) {
    this.tokens = opts.tokens;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.apiBase = opts.api_base ?? SLACK_API;
  }

  private async call<T>(accountId: string, method: string, body: Record<string, unknown>): Promise<T> {
    const token = await this.tokens.accessToken({ account_id: accountId });
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(body)) {
      if (v !== undefined && v !== null) params.set(k, String(v));
    }
    const res = await this.fetchImpl(`${this.apiBase}/${method}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    if (res.status === 429) {
      const retry = Number(res.headers.get('retry-after') ?? '1');
      throw new ConnectorError('rate_limited', `slack throttled; retry after ${retry}s`);
    }
    if (!res.ok) {
      throw new ConnectorError('provider_error', `slack ${method} failed: ${res.status} ${res.statusText}`, await safeText(res));
    }
    const out = (await res.json()) as { ok: boolean; error?: string; warning?: string } & T;
    if (!out.ok) {
      throw new ConnectorError('provider_error', `slack ${method} returned error: ${out.error ?? 'unknown'}`);
    }
    return out as T;
  }

  async listConversations(
    request: ConnectorRequest,
    _audit: AuditLog,
  ): Promise<DmConversationsListResult> {
    DmListArgsSchema.parse(request.args);
    const args = DmListArgsSchema.parse(request.args);
    void args;
    const res = await this.call<{ channels: Array<{ id: string; name?: string; is_im?: boolean; is_private?: boolean; last_read?: string }> }>(request.account.id, 'conversations.list', { types: 'public_channel,private_channel,im,mpim', limit: 100 });
    const conversations: Conversation[] = res.channels.map((c) =>
      ConversationSchema.parse({
        id: c.id,
        account_id: request.account.id,
        channel: 'slack',
        participants: [{ address: c.id, name: c.name }],
        last_message_at: c.last_read ? new Date(Number(c.last_read) * 1000).toISOString() : new Date().toISOString(),
        unread_count: 0,
        provider_ref: { provider: 'slack', native_id: c.id },
      }),
    );
    return { conversations, next_page_token: null };
  }

  async sendDm(request: ConnectorRequest, _audit: AuditLog): Promise<DmSendResult> {
    const args = DmSendArgsSchema.parse(request.args);
    const out = await this.call<{ ts: string; channel: string }>(request.account.id, 'chat.postMessage', { channel: args.conversation_id, text: args.body });
    return { provider_message_id: `${out.channel}:${out.ts}:${createHash('sha256').update(`${request.account.id}|${args.conversation_id}|${args.body}`).digest('hex').slice(0, 8)}` };
  }

  processEvent(envelope: unknown): SlackEventEnvelope {
    const parsed = SlackEventEnvelopeSchema.safeParse(envelope);
    if (!parsed.success) {
      throw new ConnectorError('webhook_payload_invalid', 'slack event failed schema validation');
    }
    return parsed.data;
  }

  async listMessages(): Promise<MailListResult> {
    throw new ConnectorError('not_found', 'SlackConnector does not implement mail operations');
  }
  async getMessage(): Promise<MailGetResult> {
    throw new ConnectorError('not_found', 'SlackConnector does not implement mail operations');
  }
  async sendMessage(): Promise<MailSendResult> {
    throw new ConnectorError('not_found', 'SlackConnector does not implement mail operations');
  }
  async replyMessage(): Promise<never> {
    throw new ConnectorError('not_found', 'SlackConnector does not implement mail operations');
  }
  async forwardMessage(): Promise<never> {
    throw new ConnectorError('not_found', 'SlackConnector does not implement mail operations');
  }
  async listCalendars(): Promise<CalendarsListResult> {
    throw new ConnectorError('not_found', 'SlackConnector does not implement calendar operations');
  }
  async listEvents(): Promise<EventsListResult> {
    throw new ConnectorError('not_found', 'SlackConnector does not implement calendar operations');
  }
  async getEvent(): Promise<EventGetResult> {
    throw new ConnectorError('not_found', 'SlackConnector does not implement calendar operations');
  }
  async createEvent(): Promise<EventCreateResult> {
    throw new ConnectorError('not_found', 'SlackConnector does not implement calendar operations');
  }
  async updateEvent(): Promise<EventUpdateResult> {
    throw new ConnectorError('not_found', 'SlackConnector does not implement calendar operations');
  }
  async deleteEvent(): Promise<EventDeleteResult> {
    throw new ConnectorError('not_found', 'SlackConnector does not implement calendar operations');
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}
