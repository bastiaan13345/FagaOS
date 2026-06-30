import { describe, expect, it } from 'vitest';
import {
  buildAuditView,
  buildCalendarView,
  buildDesktopSessionsView,
  buildInboxView,
  createApprovalIntent,
  filterAuditEntries,
  makeMockUiReadModelAdapter,
  terminateDesktopSession,
  type UiReadModelAdapter,
} from '../src/index.js';
import type {
  Account,
  Calendar,
  Conversation,
  Event,
  Message,
} from '@fagaos/connectors';
import type { AuditEntry } from '@fagaos/audit-log';
import type { Session } from '@fagaos/control-plane';

const readOnlyMailAccount = {
  id: 'acct-mail',
  user_id: 'user-1',
  provider: 'gmail',
  handle: 'a***@example.com',
  scopes: ['gmail.readonly'],
  capabilities: ['read_mail'],
  status: 'active',
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
} satisfies Account;

const writableMailAccount = {
  ...readOnlyMailAccount,
  id: 'acct-mail-writable',
  capabilities: ['read_mail', 'send_mail'],
} satisfies Account;

const readOnlyCalendarAccount = {
  ...readOnlyMailAccount,
  id: 'acct-cal',
  provider: 'google_calendar',
  capabilities: ['list_events'],
} satisfies Account;

const writableCalendarAccount = {
  ...readOnlyMailAccount,
  id: 'acct-cal-writable',
  provider: 'google_calendar',
  capabilities: ['list_events', 'create_event'],
} satisfies Account;

const readOnlyDmAccount = {
  ...readOnlyMailAccount,
  id: 'acct-dm',
  provider: 'whatsapp',
  capabilities: ['list_conversations'],
} satisfies Account;

const writableDmAccount = {
  ...readOnlyMailAccount,
  id: 'acct-dm-writable',
  provider: 'whatsapp',
  capabilities: ['list_conversations', 'send_dm'],
} satisfies Account;

const message = {
  id: 'msg-1',
  account_id: 'acct-mail',
  thread_id: 'thread-1',
  direction: 'in',
  from: { address: 'lead@example.com', name: 'Lead' },
  to: [{ address: 'me@example.com' }],
  cc: [],
  subject: 'Proposal',
  preview: 'Can you review this?',
  body_text: 'Can you review this?',
  attachments: [],
  labels: ['inbox'],
  status_flags: { read: false },
  received_at: '2026-01-02T12:00:00.000Z',
  provider_ref: { provider: 'gmail', native_id: 'native-msg-1' },
} satisfies Message;

const writableMessage = {
  ...message,
  id: 'msg-writable',
  account_id: 'acct-mail-writable',
  thread_id: 'thread-writable',
} satisfies Message;

const readOnlyCalendar = {
  id: 'cal-1',
  account_id: 'acct-cal',
  name: 'Work',
  primary: true,
  read_only: true,
  provider_ref: { provider: 'google_calendar', native_id: 'primary' },
} satisfies Calendar;

const writableCalendar = {
  ...readOnlyCalendar,
  id: 'cal-writable',
  account_id: 'acct-cal-writable',
  read_only: false,
} satisfies Calendar;

const event = {
  id: 'evt-1',
  account_id: 'acct-cal',
  calendar_id: 'cal-1',
  title: 'Planning',
  start: { tz: 'UTC', at: '2026-01-03T10:00:00.000Z' },
  end: { tz: 'UTC', at: '2026-01-03T11:00:00.000Z' },
  all_day: false,
  attendees: [{ contact: { address: 'lead@example.com' }, status: 'needsAction', optional: false }],
  status: 'confirmed',
  provider_ref: { provider: 'google_calendar', native_id: 'evt-1' },
} satisfies Event;

const writableEvent = {
  ...event,
  id: 'evt-writable',
  account_id: 'acct-cal-writable',
  calendar_id: 'cal-writable',
} satisfies Event;

const readOnlyConversation = {
  id: 'conv-1',
  account_id: 'acct-dm',
  channel: 'whatsapp',
  participants: [{ address: '+15555550100', name: 'Lead' }],
  last_message_at: '2026-01-02T13:00:00.000Z',
  unread_count: 1,
  window_open_until: '2026-01-03T13:00:00.000Z',
  preview: 'Sounds good',
  provider_ref: { provider: 'whatsapp', native_id: 'native-conv-1' },
} satisfies Conversation;

const writableConversation = {
  ...readOnlyConversation,
  id: 'conv-writable',
  account_id: 'acct-dm-writable',
  last_message_at: '2026-01-02T14:00:00.000Z',
  unread_count: 0,
} satisfies Conversation;

const session = {
  id: 'session-1',
  agentId: 'agent-1',
  agentVersion: '0.1.0',
  agentCardHash: 'hash',
  state: 'running',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:01:00.000Z',
  createdBy: { id: 'user-1', type: 'user' },
  input: {
    currentUrl: 'https://example.com',
    currentApp: 'Chrome',
    networkBoundary: 'allowlist:example.com',
    fileBoundary: 'downloads-only',
    lastScreenshotPngBase64: 'iVBORw0KGgo=',
    takeoverState: 'requested',
  },
  result: null,
  terminalReason: null,
} satisfies Session;

const auditEntry = {
  id: 'audit-1',
  seq: 1,
  ts: '2026-01-02T12:01:00.000Z',
  actor: { id: 'agent-1', type: 'agent' },
  action: 'connector.gmail.mailSend',
  resource: { kind: 'connector.account', id: 'acct-mail' },
  data: {
    sessionId: 'session-1',
    taskId: 'task-1',
    accountId: 'acct-mail',
    approvalId: 'approval-1',
    severity: 'warning',
    verificationStatus: 'verified',
  },
  prevHash: 'a'.repeat(64),
  hash: 'b'.repeat(64),
  signedCheckpoint: {
    algorithm: 'ed25519-stub-v1',
    payload: 'payload',
    signature: 'signature',
  },
} satisfies AuditEntry;

describe('@fagaos/ui-read-model', () => {
  it('builds a read-only inbox view with account filters and gates reply/draft on send_mail capability', async () => {
    const adapter = makeMockUiReadModelAdapter({
      accounts: [readOnlyMailAccount],
      messages: [message],
    });

    const view = await buildInboxView(adapter, { accountIds: ['acct-mail'] });

    expect(view.accounts).toEqual([
      expect.objectContaining({
        id: 'acct-mail',
        provider: 'gmail',
        status: 'active',
        capabilities: ['read_mail'],
      }),
    ]);
    expect(view.threads[0]).toMatchObject({
      id: 'thread-1',
      accountId: 'acct-mail',
      subject: 'Proposal',
      unread: true,
    });
    expect(view.threads[0]?.affordances.reply).toEqual({
      enabled: false,
      reason: 'read_only',
    });
    expect(view.threads[0]?.affordances.draft).toEqual({
      enabled: false,
      reason: 'read_only',
    });
    expect(view.conversations).toEqual([]);
  });

  it('emits approval-required reply and draft affordances for writable mail accounts', async () => {
    const adapter = makeMockUiReadModelAdapter({
      accounts: [writableMailAccount],
      messages: [writableMessage],
    });

    const view = await buildInboxView(adapter, { accountIds: ['acct-mail-writable'] });

    expect(view.threads[0]?.affordances.reply).toMatchObject({
      enabled: false,
      reason: 'approval_required',
    });
    expect(view.threads[0]?.affordances.reply.approvalIntent).toMatchObject({
      action: 'mail.send',
      accountId: 'acct-mail-writable',
      resourceId: 'thread-writable',
    });
    expect(view.threads[0]?.affordances.draft.approvalIntent).toMatchObject({
      action: 'mail.send',
    });
  });

  it('exposes DM conversation threads with channel, participants, and unread counts', async () => {
    const adapter = makeMockUiReadModelAdapter({
      accounts: [readOnlyDmAccount, writableDmAccount],
      conversations: [readOnlyConversation, writableConversation],
    });

    const view = await buildInboxView(adapter);

    expect(view.threads).toEqual([]);
    expect(view.conversations).toHaveLength(2);
    expect(view.conversations[0]).toMatchObject({
      id: 'conv-writable',
      accountId: 'acct-dm-writable',
      channel: 'whatsapp',
      participants: ['Lead'],
      unreadCount: 0,
      windowOpenUntil: '2026-01-03T13:00:00.000Z',
    });
    expect(view.conversations[1]).toMatchObject({
      id: 'conv-1',
      accountId: 'acct-dm',
      channel: 'whatsapp',
      unreadCount: 1,
    });
  });

  it('gates DM reply affordances on send_dm capability', async () => {
    const adapter = makeMockUiReadModelAdapter({
      accounts: [readOnlyDmAccount, writableDmAccount],
      conversations: [readOnlyConversation, writableConversation],
    });

    const view = await buildInboxView(adapter);

    const readOnlyThread = view.conversations.find((c) => c.id === 'conv-1');
    const writableThread = view.conversations.find((c) => c.id === 'conv-writable');
    expect(readOnlyThread?.affordances.reply).toEqual({
      enabled: false,
      reason: 'read_only',
    });
    expect(readOnlyThread?.affordances.draft).toEqual({
      enabled: false,
      reason: 'read_only',
    });
    expect(writableThread?.affordances.reply).toMatchObject({
      enabled: false,
      reason: 'approval_required',
    });
    expect(writableThread?.affordances.reply.approvalIntent).toMatchObject({
      action: 'dm.send',
      accountId: 'acct-dm-writable',
      resourceId: 'conv-writable',
      payload: { conversationId: 'conv-writable', channel: 'whatsapp' },
    });
  });

  it('filters conversations by accountIds when building the inbox view', async () => {
    const adapter = makeMockUiReadModelAdapter({
      accounts: [readOnlyDmAccount, writableDmAccount],
      conversations: [readOnlyConversation, writableConversation],
    });

    const view = await buildInboxView(adapter, { accountIds: ['acct-dm-writable'] });

    expect(view.conversations).toEqual([
      expect.objectContaining({ id: 'conv-writable', accountId: 'acct-dm-writable' }),
    ]);
  });

  it('surfaces reauth banners instead of dispatching connector behavior', async () => {
    const reauthAccount = {
      ...readOnlyMailAccount,
      id: 'acct-reauth',
      status: 'reauth_required',
    } satisfies Account;
    const adapter = makeMockUiReadModelAdapter({
      accounts: [reauthAccount],
      messages: [{ ...message, account_id: 'acct-reauth' }],
      reauthReasons: { 'acct-reauth': 'invalid_grant' },
    });

    const view = await buildInboxView(adapter);

    expect(view.banners).toEqual([
      {
        kind: 'reauth_required',
        accountId: 'acct-reauth',
        provider: 'gmail',
        message: 'invalid_grant',
      },
    ]);
    expect(view.threads[0]?.affordances.reply).toEqual({
      enabled: false,
      reason: 'reauth_required',
    });
  });

  it('builds calendar read models with free/busy and gates write actions on create_event + calendar.read_only', async () => {
    const adapter = makeMockUiReadModelAdapter({
      accounts: [readOnlyCalendarAccount],
      calendars: [readOnlyCalendar],
      events: [event],
      freeBusy: [{ calendarId: 'cal-1', start: event.start.at, end: event.end.at, status: 'busy' }],
    });

    const view = await buildCalendarView(adapter, {
      timeMin: '2026-01-03T00:00:00.000Z',
      timeMax: '2026-01-04T00:00:00.000Z',
    });

    expect(view.calendars[0]).toMatchObject({ id: 'cal-1', readOnly: true });
    expect(view.events[0]).toMatchObject({ id: 'evt-1', title: 'Planning' });
    expect(view.events[0]?.affordances.update).toEqual({
      enabled: false,
      reason: 'read_only',
    });
    expect(view.freeBusy).toEqual([
      { calendarId: 'cal-1', start: event.start.at, end: event.end.at, status: 'busy' },
    ]);
    expect(view.proposedActions).toEqual([]);
  });

  it('emits approval-required proposed actions and update intents for writable calendar accounts', async () => {
    const adapter = makeMockUiReadModelAdapter({
      accounts: [writableCalendarAccount],
      calendars: [writableCalendar],
      events: [writableEvent],
      freeBusy: [
        {
          calendarId: 'cal-writable',
          start: writableEvent.start.at,
          end: writableEvent.end.at,
          status: 'busy',
        },
      ],
    });

    const view = await buildCalendarView(adapter, {
      timeMin: '2026-01-03T00:00:00.000Z',
      timeMax: '2026-01-04T00:00:00.000Z',
    });

    expect(view.calendars[0]).toMatchObject({ id: 'cal-writable', readOnly: false });
    expect(view.events[0]?.affordances.update).toMatchObject({
      enabled: false,
      reason: 'approval_required',
    });
    expect(view.events[0]?.affordances.update.approvalIntent).toMatchObject({
      action: 'calendar.update_event',
      accountId: 'acct-cal-writable',
      resourceId: 'evt-writable',
    });
    expect(view.proposedActions[0]).toMatchObject({
      action: 'calendar.create_event',
      accountId: 'acct-cal-writable',
      status: 'approval_required',
    });
    expect(view.proposedActions[0]?.approvalIntent).toMatchObject({
      action: 'calendar.create_event',
      resourceId: 'cal-writable',
    });
  });

  it('does not propose calendar.create_event for a writable account on a read_only calendar', async () => {
    const writableAccountOnReadOnlyCalendar = {
      ...writableCalendarAccount,
      id: 'acct-cal-mix',
    } satisfies Account;
    const readOnlyCalendarForWritableAccount = {
      ...readOnlyCalendar,
      id: 'cal-mix',
      account_id: 'acct-cal-mix',
    } satisfies Calendar;
    const adapter = makeMockUiReadModelAdapter({
      accounts: [writableAccountOnReadOnlyCalendar],
      calendars: [readOnlyCalendarForWritableAccount],
      events: [],
    });

    const view = await buildCalendarView(adapter);

    expect(view.proposedActions).toEqual([]);
    expect(view.calendars[0]).toMatchObject({ id: 'cal-mix', readOnly: true });
  });

  it('builds desktop session controls and routes termination through the runtime adapter', async () => {
    const adapter = makeMockUiReadModelAdapter({ sessions: [session] });

    const view = await buildDesktopSessionsView(adapter);
    const control = view.sessions[0];

    expect(control).toMatchObject({
      id: 'session-1',
      state: 'running',
      currentUrl: 'https://example.com',
      currentApp: 'Chrome',
      lastScreenshotPngBase64: 'iVBORw0KGgo=',
      boundaries: {
        network: 'allowlist:example.com',
        file: 'downloads-only',
      },
      takeoverState: 'requested',
    });
    expect(control?.controls.terminate).toEqual({ enabled: true });

    const result = await terminateDesktopSession(adapter, 'session-1', 'user requested');

    expect(result).toEqual({ ok: true, sessionId: 'session-1', state: 'killed' });
    expect((await adapter.listSessions())[0]?.state).toBe('killed');
  });

  it('filters audit views by actor, action, resource, session, task, account, approval, severity, and verification status', async () => {
    const entries = [
      auditEntry,
      {
        ...auditEntry,
        id: 'audit-2',
        seq: 2,
        actor: { id: 'user-2', type: 'user' },
        action: 'session.kill',
        resource: { kind: 'session', id: 'session-2' },
        data: {
          sessionId: 'session-2',
          taskId: 'task-2',
          accountId: 'acct-other',
          severity: 'info',
          verificationStatus: 'unverified',
        },
        hash: 'c'.repeat(64),
      } satisfies AuditEntry,
    ];

    const filtered = filterAuditEntries(entries, {
      actorId: 'agent-1',
      action: 'connector.gmail.mailSend',
      resourceKind: 'connector.account',
      resourceId: 'acct-mail',
      sessionId: 'session-1',
      taskId: 'task-1',
      accountId: 'acct-mail',
      approvalId: 'approval-1',
      severity: 'warning',
      verificationStatus: 'verified',
      search: 'mailSend',
    });

    expect(filtered).toEqual([auditEntry]);
  });

  it('builds audit view verification summary from adapter-supplied chain status', async () => {
    const adapter = makeMockUiReadModelAdapter({
      auditEntries: [auditEntry],
      auditVerification: { ok: true, inspected: 1, brokenAtSeq: null, reason: null },
    });

    const view = await buildAuditView(adapter, { severity: 'warning' });

    expect(view.entries).toEqual([expect.objectContaining({ id: 'audit-1', verificationStatus: 'verified' })]);
    expect(view.verification).toEqual({ ok: true, inspected: 1, brokenAtSeq: null, reason: null });
  });

  it('creates explicit approval intents without executing provider or runtime writes', () => {
    const intent = createApprovalIntent({
      action: 'desktop.terminate_session',
      accountId: null,
      resourceId: 'session-1',
      payload: { reason: 'user requested' },
      requestedBy: { id: 'user-1', type: 'user' },
    });

    expect(intent).toMatchObject({
      id: expect.stringMatching(/^approval_/),
      action: 'desktop.terminate_session',
      status: 'pending',
      resourceId: 'session-1',
    });
    expect(intent.payload).toEqual({ reason: 'user requested' });
  });

  it('works with a typed adapter boundary instead of direct provider/runtime calls', async () => {
    const adapter: UiReadModelAdapter = makeMockUiReadModelAdapter({
      accounts: [readOnlyMailAccount],
      messages: [message],
      conversations: [readOnlyConversation],
      auditEntries: [auditEntry],
    });

    await expect(adapter.listAccounts()).resolves.toHaveLength(1);
    await expect(adapter.listMessages({ accountIds: ['acct-mail'] })).resolves.toHaveLength(1);
    await expect(adapter.listConversations({ accountIds: ['acct-dm'] })).resolves.toHaveLength(1);
    await expect(adapter.listAuditEntries()).resolves.toHaveLength(1);
  });
});
