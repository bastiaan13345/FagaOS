/**
 * Stub email connector. Returns deterministic fixtures derived from
 * the account id so the same account always returns the same data and
 * a freshly-minted account always returns the same shape.
 *
 * This connector never touches the network. It is the default Phase 1
 * connector and is also used by every test that does not need real
 * provider behaviour.
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
  EventGetResult,
  EventsListResult,
  MailGetResult,
  MailListResult,
  MailSendResult,
} from '../../connector.js';
import {
  AttachmentSchema,
  ConversationSchema,
  EventSchema,
  MessageSchema,
  type Account,
  type Calendar,
  type Conversation,
  type Event,
  type Message,
} from '../../models/schemas.js';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Argument schemas — one per operation. Connectors accept the parsed
// shape; the gateway validates before calling.
// ---------------------------------------------------------------------------

export const MailListArgsSchema = z.object({
  query: z.string().default('in:inbox'),
  limit: z.number().int().positive().max(100).default(20),
  page_token: z.string().nullable().default(null),
});
export type MailListArgs = z.infer<typeof MailListArgsSchema>;

export const MailGetArgsSchema = z.object({
  message_id: z.string().min(1),
});
export type MailGetArgs = z.infer<typeof MailGetArgsSchema>;

export const MailSendArgsSchema = z.object({
  to: z.array(z.string().email()).min(1),
  subject: z.string().min(1),
  body: z.string().min(1),
  thread_id: z.string().nullable().default(null),
});
export type MailSendArgs = z.infer<typeof MailSendArgsSchema>;

export const DmListArgsSchema = z.object({
  channel: z.enum(['sms', 'whatsapp', 'instagram', 'telegram', 'discord', 'slack']).default('sms'),
  limit: z.number().int().positive().max(100).default(20),
});
export type DmListArgs = z.infer<typeof DmListArgsSchema>;

export const DmSendArgsSchema = z.object({
  conversation_id: z.string().min(1),
  body: z.string().min(1),
});
export type DmSendArgs = z.infer<typeof DmSendArgsSchema>;

// ---------------------------------------------------------------------------
// Connector
// ---------------------------------------------------------------------------

const STUB_ID: ConnectorId = 'gmail';

export class StubEmailConnector implements Connector {
  readonly id: ConnectorId = STUB_ID;
  readonly operations = [
    'mail.list',
    'mail.get',
    'mail.send',
    'dm.conversations.list',
    'dm.send',
  ] as const;

  async listMessages(
    request: ConnectorRequest<MailListArgs>,
    _audit: AuditLog,
  ): Promise<MailListResult> {
    const args = MailListArgsSchema.parse(request.args);
    const messages = Array.from({ length: Math.min(args.limit, 5) }, (_, i) =>
      this.fakeMessage(request.account, i),
    );
    return { messages, next_page_token: null };
  }

  async getMessage(
    request: ConnectorRequest<MailGetArgs>,
    _audit: AuditLog,
  ): Promise<MailGetResult> {
    const args = MailGetArgsSchema.parse(request.args);
    // Derive an index from the message_id so the same id always
    // returns the same fixture.
    const idx = stableIndex(args.message_id, 0, 4);
    return { message: this.fakeMessage(request.account, idx) };
  }

  async sendMessage(
    request: ConnectorRequest<MailSendArgs>,
    _audit: AuditLog,
  ): Promise<MailSendResult> {
    const args = MailSendArgsSchema.parse(request.args);
    const id = createHash('sha256')
      .update(`stub|${request.account.id}|${args.subject}|${args.body}`)
      .digest('hex')
      .slice(0, 16);
    return { provider_message_id: `stub-msg-${id}`, thread_id: args.thread_id };
  }

  async listConversations(
    request: ConnectorRequest<DmListArgs>,
    _audit: AuditLog,
  ): Promise<DmConversationsListResult> {
    const args = DmListArgsSchema.parse(request.args);
    const conversations: Conversation[] = Array.from(
      { length: Math.min(args.limit, 3) },
      (_, i) => this.fakeConversation(request.account, args.channel, i),
    );
    return { conversations, next_page_token: null };
  }

  async sendDm(
    request: ConnectorRequest<DmSendArgs>,
    _audit: AuditLog,
  ): Promise<DmSendResult> {
    const args = DmSendArgsSchema.parse(request.args);
    const id = createHash('sha256')
      .update(`stub-dm|${request.account.id}|${args.conversation_id}|${args.body}`)
      .digest('hex')
      .slice(0, 16);
    return { provider_message_id: `stub-dm-${id}` };
  }

  // Methods that don't apply to email: throw `not_found` so callers
  // get a clear error rather than a silent no-op.
  async listCalendars(): Promise<CalendarsListResult> {
    throw new ConnectorError('not_found', 'StubEmailConnector does not implement calendar operations');
  }
  async listEvents(): Promise<EventsListResult> {
    throw new ConnectorError('not_found', 'StubEmailConnector does not implement calendar operations');
  }
  async getEvent(): Promise<EventGetResult> {
    throw new ConnectorError('not_found', 'StubEmailConnector does not implement calendar operations');
  }

  // -------------------------------------------------------------------------
  // Fixture helpers
  // -------------------------------------------------------------------------

  private fakeMessage(account: Account, index: number): Message {
    const id = `stub-msg-${account.id}-${index}`;
    return MessageSchema.parse({
      id,
      account_id: account.id,
      thread_id: `stub-thread-${account.id}-${index}`,
      direction: index % 2 === 0 ? 'in' : 'out',
      from: {
        address: index % 2 === 0 ? `sender${index}@example.com` : account.handle,
        name: index % 2 === 0 ? `Sender ${index}` : undefined,
      },
      to: [{ address: account.handle }],
      subject: `[stub] Sample email ${index} for ${account.handle}`,
      preview: `This is stub message ${index}.`,
      body_text: `Hello from the stub connector. Account ${account.id}, message ${index}.`,
      attachments: index === 0 ? [] : [],
      labels: ['INBOX', ...(index % 2 === 0 ? ['UNREAD'] : [])],
      status_flags: { read: index % 2 !== 0 },
      received_at: new Date(2024, 0, 1, 12, index).toISOString(),
      provider_ref: { provider: account.provider, native_id: id },
    });
  }

  private fakeConversation(account: Account, channel: DmListArgs['channel'], index: number): Conversation {
    const id = `stub-conv-${account.id}-${channel}-${index}`;
    return ConversationSchema.parse({
      id,
      account_id: account.id,
      channel,
      participants: [{ address: account.handle }, { address: `peer${index}@example.com`, name: `Peer ${index}` }],
      last_message_at: new Date(2024, 0, 2, 9, index).toISOString(),
      unread_count: index % 2 === 0 ? 1 : 0,
      preview: `Stub conversation ${index}.`,
      provider_ref: { provider: account.provider, native_id: id },
    });
  }
}

/** Stub event fixture helper shared by the calendar stub. */
export function fakeCalendar(account: Account): Calendar {
  return {
    id: `stub-cal-${account.id}`,
    account_id: account.id,
    name: 'Stub Calendar',
    primary: true,
    read_only: false,
    provider_ref: { provider: account.provider, native_id: 'primary' },
  };
}

export function fakeEvent(account: Account, calendar: Calendar, index: number): Event {
  const id = `stub-event-${account.id}-${index}`;
  return EventSchema.parse({
    id,
    account_id: account.id,
    calendar_id: calendar.id,
    title: `Stub event ${index}`,
    description: `Generated by StubCalendarConnector for account ${account.id}.`,
    start: { tz: 'UTC', at: new Date(2024, 0, 3, 10, index).toISOString() },
    end: { tz: 'UTC', at: new Date(2024, 0, 3, 11, index).toISOString() },
    all_day: false,
    attendees: [{ contact: { address: account.handle }, status: 'accepted', optional: false }],
    status: 'confirmed',
    provider_ref: { provider: account.provider, native_id: id },
  });
}

/** Hash a string into a stable index in `[lo, hi]`. */
function stableIndex(input: string, lo: number, hi: number): number {
  const h = createHash('sha256').update(input).digest();
  const v = h.readUInt32BE(0);
  return lo + (v % (hi - lo + 1));
}

// Re-export AttachmentSchema for tests that want to construct fixtures.
export { AttachmentSchema };
