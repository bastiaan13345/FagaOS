/**
 * @fagaos/ui-read-model
 *
 * Shared typed boundary for user-facing work surfaces. This package turns
 * normalized connector entities, control-plane sessions, approval intents,
 * and audit entries into UI-ready read models. Provider and desktop runtime
 * behavior stays behind `UiReadModelAdapter`; tests and Phase 1 UI can use
 * mocks until production connectors/runtimes land.
 */
import { randomUUID } from 'node:crypto';
import type {
  Account,
  AccountCapability,
  Calendar,
  Conversation,
  Event,
  Message,
  Provider,
} from '@fagaos/connectors';
import type { AuditEntry, AuditVerifyResult } from '@fagaos/audit-log';
import type { Session, SessionState } from '@fagaos/control-plane';

export type UiActor = { id: string; type: 'user' | 'agent' | 'system' };

export type ApprovalAction =
  | 'mail.send'
  | 'dm.send'
  | 'calendar.create_event'
  | 'calendar.update_event'
  | 'desktop.takeover_session'
  | 'desktop.terminate_session';

export interface ApprovalIntentInput {
  action: ApprovalAction;
  accountId: string | null;
  resourceId: string;
  payload: Record<string, unknown>;
  requestedBy: UiActor;
}

export interface ApprovalIntent extends ApprovalIntentInput {
  id: string;
  status: 'pending';
  createdAt: string;
}

export interface UiReadModelAdapter {
  listAccounts(): Promise<Account[]>;
  listMessages(filter?: { accountIds?: string[] }): Promise<Message[]>;
  listConversations(filter?: { accountIds?: string[] }): Promise<Conversation[]>;
  listCalendars(filter?: { accountIds?: string[] }): Promise<Calendar[]>;
  listEvents(filter?: {
    accountIds?: string[] | undefined;
    calendarIds?: string[] | undefined;
    timeMin?: string | undefined;
    timeMax?: string | undefined;
  }): Promise<Event[]>;
  listFreeBusy(filter?: {
    accountIds?: string[] | undefined;
    calendarIds?: string[] | undefined;
    timeMin?: string | undefined;
    timeMax?: string | undefined;
  }): Promise<FreeBusyBlock[]>;
  listSessions(): Promise<Session[]>;
  terminateSession(sessionId: string, reason: string): Promise<SessionTerminationResult>;
  listAuditEntries(): Promise<AuditEntry[]>;
  verifyAuditChain(): Promise<AuditVerifyResult>;
  getReauthReason(accountId: string): Promise<string | null>;
}

export interface AccountSummary {
  id: string;
  provider: Provider;
  handle: string;
  status: Account['status'];
  capabilities: Account['capabilities'];
}

export interface ReauthBanner {
  kind: 'reauth_required';
  accountId: string;
  provider: Provider;
  message: string;
}

export interface UiAffordance {
  enabled: boolean;
  reason?: 'approval_required' | 'reauth_required' | 'read_only' | 'terminal_session';
  approvalIntent?: ApprovalIntent;
}

export interface InboxThreadView {
  id: string;
  accountId: string;
  subject: string;
  preview: string;
  participants: string[];
  unread: boolean;
  lastActivityAt: string;
  messages: Message[];
  affordances: {
    reply: UiAffordance;
    draft: UiAffordance;
  };
}

export interface ConversationThreadView {
  id: string;
  accountId: string;
  channel: Conversation['channel'];
  participants: string[];
  preview: string;
  unreadCount: number;
  lastActivityAt: string;
  windowOpenUntil: string | null;
  affordances: {
    reply: UiAffordance;
    draft: UiAffordance;
  };
}

export interface InboxView {
  accounts: AccountSummary[];
  banners: ReauthBanner[];
  threads: InboxThreadView[];
  conversations: ConversationThreadView[];
}

export interface BuildInboxOptions {
  accountIds?: string[];
}

export interface CalendarViewItem {
  id: string;
  accountId: string;
  name: string;
  primary: boolean;
  color: string | null;
  readOnly: boolean;
}

export interface EventViewItem {
  id: string;
  accountId: string;
  calendarId: string;
  title: string;
  start: Event['start'];
  end: Event['end'];
  attendeeCount: number;
  status: Event['status'];
  affordances: {
    update: UiAffordance;
  };
}

export interface FreeBusyBlock {
  calendarId: string;
  start: string;
  end: string;
  status: 'free' | 'busy' | 'tentative' | 'out_of_office';
}

export interface ProposedCalendarAction {
  id: string;
  action: Extract<ApprovalAction, 'calendar.create_event' | 'calendar.update_event'>;
  accountId: string;
  calendarId?: string;
  status: 'approval_required';
  approvalIntent: ApprovalIntent;
}

export interface CalendarView {
  accounts: AccountSummary[];
  banners: ReauthBanner[];
  calendars: CalendarViewItem[];
  events: EventViewItem[];
  freeBusy: FreeBusyBlock[];
  proposedActions: ProposedCalendarAction[];
}

export interface BuildCalendarOptions {
  accountIds?: string[];
  calendarIds?: string[];
  timeMin?: string;
  timeMax?: string;
}

export type TakeoverState = 'none' | 'requested' | 'active' | 'denied';

export interface DesktopSessionView {
  id: string;
  state: SessionState;
  agentId: string;
  currentUrl: string | null;
  currentApp: string | null;
  lastScreenshotPngBase64: string | null;
  boundaries: {
    network: string | null;
    file: string | null;
  };
  takeoverState: TakeoverState;
  fileDropEnabled: boolean;
  controls: {
    takeover: UiAffordance;
    terminate: UiAffordance;
  };
}

export interface DesktopSessionsView {
  sessions: DesktopSessionView[];
}

export interface SessionTerminationResult {
  ok: true;
  sessionId: string;
  state: Extract<SessionState, 'killed'>;
}

export type AuditSeverity = 'debug' | 'info' | 'warning' | 'error' | 'critical';
export type VerificationStatus = 'verified' | 'unverified' | 'broken' | 'unknown';

export interface AuditFilter {
  actorId?: string;
  actorType?: AuditEntry['actor']['type'];
  action?: string;
  resourceKind?: string;
  resourceId?: string;
  sessionId?: string;
  taskId?: string;
  accountId?: string;
  approvalId?: string;
  severity?: AuditSeverity;
  verificationStatus?: VerificationStatus;
  search?: string;
}

export interface AuditViewEntry {
  id: string;
  seq: number;
  ts: string;
  actor: AuditEntry['actor'];
  action: string;
  resource: AuditEntry['resource'];
  sessionId: string | null;
  taskId: string | null;
  accountId: string | null;
  approvalId: string | null;
  severity: AuditSeverity;
  verificationStatus: VerificationStatus;
  hash: string;
}

export interface AuditView {
  entries: AuditViewEntry[];
  verification: AuditVerifyResult;
}

export interface MockUiReadModelSeed {
  accounts?: Account[];
  messages?: Message[];
  conversations?: Conversation[];
  calendars?: Calendar[];
  events?: Event[];
  freeBusy?: FreeBusyBlock[];
  sessions?: Session[];
  auditEntries?: AuditEntry[];
  auditVerification?: AuditVerifyResult;
  reauthReasons?: Record<string, string>;
}

export function createApprovalIntent(input: ApprovalIntentInput): ApprovalIntent {
  return {
    id: `approval_${randomUUID()}`,
    status: 'pending',
    createdAt: new Date().toISOString(),
    ...input,
  };
}

export async function buildInboxView(
  adapter: UiReadModelAdapter,
  options: BuildInboxOptions = {},
): Promise<InboxView> {
  const accounts = await adapter.listAccounts();
  const selected = selectAccounts(accounts, options.accountIds);
  const selectedIds = selected.map((a) => a.id);
  const [messages, conversations] = await Promise.all([
    adapter.listMessages({ accountIds: selectedIds }),
    adapter.listConversations({ accountIds: selectedIds }),
  ]);
  const banners = await reauthBanners(adapter, selected);

  return {
    accounts: selected.map(accountSummary),
    banners,
    threads: groupMessagesIntoThreads(messages, selected),
    conversations: groupConversationsIntoThreads(conversations, selected),
  };
}

export async function buildCalendarView(
  adapter: UiReadModelAdapter,
  options: BuildCalendarOptions = {},
): Promise<CalendarView> {
  const accounts = selectAccounts(await adapter.listAccounts(), options.accountIds);
  const accountIds = accounts.map((a) => a.id);
  const calendars = await adapter.listCalendars({
    accountIds,
  });
  const calendarIds = options.calendarIds ?? calendars.map((c) => c.id);
  const events = await adapter.listEvents({
    accountIds,
    calendarIds,
    timeMin: options.timeMin,
    timeMax: options.timeMax,
  });
  const freeBusy = await adapter.listFreeBusy({
    accountIds,
    calendarIds,
    timeMin: options.timeMin,
    timeMax: options.timeMax,
  });
  const banners = await reauthBanners(adapter, accounts);

  return {
    accounts: accounts.map(accountSummary),
    banners,
    calendars: calendars
      .filter((c) => calendarIds.includes(c.id))
      .map((c) => ({
        id: c.id,
        accountId: c.account_id,
        name: c.name,
        primary: c.primary,
        color: c.color ?? null,
        readOnly: c.read_only,
      })),
    events: events.map((event) => eventView(event, accounts, calendars)),
    freeBusy,
    proposedActions: buildCalendarActions(accounts, calendars),
  };
}

export async function buildDesktopSessionsView(
  adapter: UiReadModelAdapter,
): Promise<DesktopSessionsView> {
  const sessions = await adapter.listSessions();
  return {
    sessions: sessions.map(desktopSessionView),
  };
}

export function terminateDesktopSession(
  adapter: UiReadModelAdapter,
  sessionId: string,
  reason: string,
): Promise<SessionTerminationResult> {
  return adapter.terminateSession(sessionId, reason);
}

export function filterAuditEntries(
  entries: AuditEntry[],
  filter: AuditFilter = {},
): AuditEntry[] {
  return entries.filter((entry) => auditEntryMatches(entry, filter));
}

export async function buildAuditView(
  adapter: UiReadModelAdapter,
  filter: AuditFilter = {},
): Promise<AuditView> {
  const [entries, verification] = await Promise.all([
    adapter.listAuditEntries(),
    adapter.verifyAuditChain(),
  ]);
  return {
    entries: filterAuditEntries(entries, filter).map(auditViewEntry),
    verification,
  };
}

export function makeMockUiReadModelAdapter(seed: MockUiReadModelSeed = {}): UiReadModelAdapter {
  const accounts = [...(seed.accounts ?? [])];
  const messages = [...(seed.messages ?? [])];
  const conversations = [...(seed.conversations ?? [])];
  const calendars = [...(seed.calendars ?? [])];
  const events = [...(seed.events ?? [])];
  const freeBusy = [...(seed.freeBusy ?? [])];
  const sessions = [...(seed.sessions ?? [])];
  const auditEntries = [...(seed.auditEntries ?? [])];
  const auditVerification =
    seed.auditVerification ?? { ok: true, inspected: auditEntries.length, brokenAtSeq: null, reason: null };
  const reauthReasons = { ...(seed.reauthReasons ?? {}) };

  return {
    async listAccounts() {
      return accounts.map(copy);
    },
    async listMessages(filter = {}) {
      const accountIds = filter.accountIds;
      return messages.filter((m) => !accountIds || accountIds.includes(m.account_id)).map(copy);
    },
    async listConversations(filter = {}) {
      const accountIds = filter.accountIds;
      return conversations
        .filter((c) => !accountIds || accountIds.includes(c.account_id))
        .map(copy);
    },
    async listCalendars(filter = {}) {
      const accountIds = filter.accountIds;
      return calendars.filter((c) => !accountIds || accountIds.includes(c.account_id)).map(copy);
    },
    async listEvents(filter = {}) {
      return events
        .filter((event) => !filter.accountIds || filter.accountIds.includes(event.account_id))
        .filter((event) => !filter.calendarIds || filter.calendarIds.includes(event.calendar_id))
        .filter((event) => !filter.timeMin || event.end.at >= filter.timeMin)
        .filter((event) => !filter.timeMax || event.start.at <= filter.timeMax)
        .map(copy);
    },
    async listFreeBusy(filter = {}) {
      return freeBusy
        .filter((block) => !filter.calendarIds || filter.calendarIds.includes(block.calendarId))
        .filter((block) => !filter.timeMin || block.end >= filter.timeMin)
        .filter((block) => !filter.timeMax || block.start <= filter.timeMax)
        .map(copy);
    },
    async listSessions() {
      return sessions.map(copy);
    },
    async terminateSession(sessionId, reason) {
      const session = sessions.find((s) => s.id === sessionId);
      if (!session) {
        throw new Error(`session "${sessionId}" not found`);
      }
      session.state = 'killed';
      session.terminalReason = reason;
      session.updatedAt = new Date().toISOString();
      return { ok: true, sessionId, state: 'killed' };
    },
    async listAuditEntries() {
      return auditEntries.map(copy);
    },
    async verifyAuditChain() {
      return copy(auditVerification);
    },
    async getReauthReason(accountId) {
      return reauthReasons[accountId] ?? null;
    },
  };
}

function selectAccounts(accounts: Account[], accountIds?: string[]): Account[] {
  return accountIds ? accounts.filter((a) => accountIds.includes(a.id)) : accounts;
}

function accountSummary(account: Account): AccountSummary {
  return {
    id: account.id,
    provider: account.provider,
    handle: account.handle,
    status: account.status,
    capabilities: [...account.capabilities],
  };
}

async function reauthBanners(
  adapter: UiReadModelAdapter,
  accounts: Account[],
): Promise<ReauthBanner[]> {
  const banners: ReauthBanner[] = [];
  for (const account of accounts) {
    if (account.status === 'reauth_required') {
      banners.push({
        kind: 'reauth_required',
        accountId: account.id,
        provider: account.provider,
        message: (await adapter.getReauthReason(account.id)) ?? 'Re-authorisation required',
      });
    }
  }
  return banners;
}

function groupMessagesIntoThreads(messages: Message[], accounts: Account[]): InboxThreadView[] {
  const accountById = new Map(accounts.map((account) => [account.id, account]));
  const byThread = new Map<string, Message[]>();
  for (const message of messages) {
    const key = message.thread_id ?? message.id;
    byThread.set(key, [...(byThread.get(key) ?? []), message]);
  }

  return [...byThread.entries()]
    .map(([threadId, threadMessages]) => {
      const sorted = [...threadMessages].sort((a, b) => messageTime(a).localeCompare(messageTime(b)));
      const last = sorted.at(-1)!;
      const account = accountById.get(last.account_id);
      const writeAffordance = mailWriteAffordance(account, {
        resourceId: threadId,
        payload: { threadId },
      });

      return {
        id: threadId,
        accountId: last.account_id,
        subject: last.subject ?? '(no subject)',
        preview: last.preview,
        participants: messageParticipants(sorted),
        unread: sorted.some((m) => !m.status_flags.read),
        lastActivityAt: messageTime(last),
        messages: sorted,
        affordances: {
          reply: writeAffordance,
          draft: writeAffordance,
        },
      };
    })
    .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
}

function groupConversationsIntoThreads(
  conversations: Conversation[],
  accounts: Account[],
): ConversationThreadView[] {
  const accountById = new Map(accounts.map((account) => [account.id, account]));
  return [...conversations]
    .map((conversation) => {
      const account = accountById.get(conversation.account_id);
      const writeAffordance = dmWriteAffordance(account, {
        resourceId: conversation.id,
        payload: {
          conversationId: conversation.id,
          channel: conversation.channel,
        },
      });
      return {
        id: conversation.id,
        accountId: conversation.account_id,
        channel: conversation.channel,
        participants: conversationParticipants(conversation.participants),
        preview: conversation.preview ?? '',
        unreadCount: conversation.unread_count,
        lastActivityAt: conversation.last_message_at,
        windowOpenUntil: conversation.window_open_until ?? null,
        affordances: {
          reply: writeAffordance,
          draft: writeAffordance,
        },
      };
    })
    .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
}

function eventView(event: Event, accounts: Account[], calendars: Calendar[]): EventViewItem {
  const account = accounts.find((a) => a.id === event.account_id);
  const calendar = calendars.find((c) => c.id === event.calendar_id);
  return {
    id: event.id,
    accountId: event.account_id,
    calendarId: event.calendar_id,
    title: event.title,
    start: event.start,
    end: event.end,
    attendeeCount: event.attendees.length,
    status: event.status,
    affordances: {
      update: calendarEventUpdateAffordance(account, calendar, {
        resourceId: event.id,
        payload: { eventId: event.id },
      }),
    },
  };
}

function buildCalendarActions(
  accounts: Account[],
  calendars: Calendar[],
): ProposedCalendarAction[] {
  return calendars.flatMap((calendar) => {
    const account = accounts.find((a) => a.id === calendar.account_id);
    if (!account) return [];
    const affordance = calendarCreateAffordance(account, calendar, {
      resourceId: calendar.id,
      payload: { calendarId: calendar.id },
    });
    if (affordance.reason !== 'approval_required' || !affordance.approvalIntent) return [];
    return [{
      id: affordance.approvalIntent.id,
      action: 'calendar.create_event',
      accountId: account.id,
      calendarId: calendar.id,
      status: 'approval_required',
      approvalIntent: affordance.approvalIntent,
    }];
  });
}

function desktopSessionView(session: Session): DesktopSessionView {
  const terminal = session.state === 'completed' || session.state === 'killed' || session.state === 'crashed';
  return {
    id: session.id,
    state: session.state,
    agentId: session.agentId,
    currentUrl: stringInput(session.input, 'currentUrl'),
    currentApp: stringInput(session.input, 'currentApp'),
    lastScreenshotPngBase64: stringInput(session.input, 'lastScreenshotPngBase64'),
    boundaries: {
      network: stringInput(session.input, 'networkBoundary'),
      file: stringInput(session.input, 'fileBoundary'),
    },
    takeoverState: takeoverState(session.input['takeoverState']),
    fileDropEnabled: !terminal,
    controls: {
      takeover: terminal
        ? { enabled: false, reason: 'terminal_session' }
        : {
            enabled: false,
            reason: 'approval_required',
            approvalIntent: createApprovalIntent({
              action: 'desktop.takeover_session',
              accountId: null,
              resourceId: session.id,
              payload: { sessionId: session.id },
              requestedBy: { id: 'user:current', type: 'user' },
            }),
          },
      terminate: terminal ? { enabled: false, reason: 'terminal_session' } : { enabled: true },
    },
  };
}

function auditEntryMatches(entry: AuditEntry, filter: AuditFilter): boolean {
  const view = auditViewEntry(entry);
  if (filter.actorId && entry.actor.id !== filter.actorId) return false;
  if (filter.actorType && entry.actor.type !== filter.actorType) return false;
  if (filter.action && entry.action !== filter.action) return false;
  if (filter.resourceKind && entry.resource.kind !== filter.resourceKind) return false;
  if (filter.resourceId && entry.resource.id !== filter.resourceId) return false;
  if (filter.sessionId && view.sessionId !== filter.sessionId) return false;
  if (filter.taskId && view.taskId !== filter.taskId) return false;
  if (filter.accountId && view.accountId !== filter.accountId) return false;
  if (filter.approvalId && view.approvalId !== filter.approvalId) return false;
  if (filter.severity && view.severity !== filter.severity) return false;
  if (filter.verificationStatus && view.verificationStatus !== filter.verificationStatus) return false;
  if (filter.search && !auditSearchHaystack(entry).includes(filter.search.toLowerCase())) return false;
  return true;
}

function auditViewEntry(entry: AuditEntry): AuditViewEntry {
  return {
    id: entry.id,
    seq: entry.seq,
    ts: entry.ts,
    actor: entry.actor,
    action: entry.action,
    resource: entry.resource,
    sessionId: dataString(entry, 'sessionId'),
    taskId: dataString(entry, 'taskId'),
    accountId: dataString(entry, 'accountId'),
    approvalId: dataString(entry, 'approvalId'),
    severity: auditSeverity(entry.data['severity']),
    verificationStatus: verificationStatus(entry.data['verificationStatus']),
    hash: entry.hash,
  };
}

function messageParticipants(messages: Message[]): string[] {
  const values = new Set<string>();
  for (const message of messages) {
    values.add(message.from.name ?? message.from.address);
    for (const contact of message.to) values.add(contact.name ?? contact.address);
  }
  return [...values];
}

function conversationParticipants(participants: Conversation['participants']): string[] {
  return participants.map((p) => p.name ?? p.address);
}

interface IntentSpec {
  resourceId: string;
  payload: Record<string, unknown>;
}

function mailWriteAffordance(account: Account | undefined, spec: IntentSpec): UiAffordance {
  return emailWriteAffordance(account, 'send_mail', 'mail.send', spec);
}

function dmWriteAffordance(account: Account | undefined, spec: IntentSpec): UiAffordance {
  return emailWriteAffordance(account, 'send_dm', 'dm.send', spec);
}

function emailWriteAffordance(
  account: Account | undefined,
  capability: AccountCapability,
  action: 'mail.send' | 'dm.send',
  spec: IntentSpec,
): UiAffordance {
  if (!account) {
    return { enabled: false, reason: 'read_only' };
  }
  if (account.status === 'reauth_required') {
    return { enabled: false, reason: 'reauth_required' };
  }
  if (!account.capabilities.includes(capability)) {
    return { enabled: false, reason: 'read_only' };
  }
  return {
    enabled: false,
    reason: 'approval_required',
    approvalIntent: createApprovalIntent({
      action,
      accountId: account.id,
      resourceId: spec.resourceId,
      payload: spec.payload,
      requestedBy: { id: 'user:current', type: 'user' },
    }),
  };
}

function calendarCreateAffordance(
  account: Account | undefined,
  calendar: Calendar,
  spec: IntentSpec,
): UiAffordance {
  return calendarWriteAffordance(account, calendar, spec, 'calendar.create_event');
}

function calendarEventUpdateAffordance(
  account: Account | undefined,
  calendar: Calendar | undefined,
  spec: IntentSpec,
): UiAffordance {
  if (!calendar) {
    return { enabled: false, reason: 'read_only' };
  }
  return calendarWriteAffordance(account, calendar, spec, 'calendar.update_event');
}

function calendarWriteAffordance(
  account: Account | undefined,
  calendar: Calendar,
  spec: IntentSpec,
  action: 'calendar.create_event' | 'calendar.update_event',
): UiAffordance {
  if (calendar.read_only) {
    return { enabled: false, reason: 'read_only' };
  }
  if (!account) {
    return { enabled: false, reason: 'read_only' };
  }
  if (account.status === 'reauth_required') {
    return { enabled: false, reason: 'reauth_required' };
  }
  if (!account.capabilities.includes('create_event')) {
    return { enabled: false, reason: 'read_only' };
  }
  return {
    enabled: false,
    reason: 'approval_required',
    approvalIntent: createApprovalIntent({
      action,
      accountId: account.id,
      resourceId: spec.resourceId,
      payload: spec.payload,
      requestedBy: { id: 'user:current', type: 'user' },
    }),
  };
}

function messageTime(message: Message): string {
  return message.sent_at ?? message.received_at;
}

function stringInput(input: Record<string, unknown>, key: string): string | null {
  const value = input[key];
  return typeof value === 'string' ? value : null;
}

function takeoverState(value: unknown): TakeoverState {
  return value === 'requested' || value === 'active' || value === 'denied' ? value : 'none';
}

function dataString(entry: AuditEntry, key: string): string | null {
  const value = entry.data[key];
  return typeof value === 'string' ? value : null;
}

function auditSeverity(value: unknown): AuditSeverity {
  if (
    value === 'debug' ||
    value === 'info' ||
    value === 'warning' ||
    value === 'error' ||
    value === 'critical'
  ) {
    return value;
  }
  return 'info';
}

function verificationStatus(value: unknown): VerificationStatus {
  if (value === 'verified' || value === 'unverified' || value === 'broken' || value === 'unknown') {
    return value;
  }
  return 'unknown';
}

function auditSearchHaystack(entry: AuditEntry): string {
  return [
    entry.id,
    entry.actor.id,
    entry.actor.type,
    entry.action,
    entry.resource.kind,
    entry.resource.id,
    JSON.stringify(entry.data),
    entry.hash,
  ].join(' ').toLowerCase();
}

function copy<T>(value: T): T {
  return structuredClone(value);
}
