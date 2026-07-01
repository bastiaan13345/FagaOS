/**
 * FAG-25 coverage gap tests.
 *
 * These tests cover the gateway code paths that the public surface
 * does not exercise. They use an internal cast on the gateway to
 * dispatch the operations that the gateway's switch in
 * `invokeConnector` handles but that have no public wrapper. The
 * casts are safe at runtime because the underlying methods are
 * normal instance methods — the only barrier is the `private`
 * keyword, which TypeScript erases at compile time.
 *
 * Coverage targets in `gateway/gateway.ts`:
 *   - the `mail.forward`, `calendar.events.get`, `calendar.events.create`,
 *     `calendar.events.update`, and `calendar.events.delete` cases of
 *     `invokeConnector`
 *   - the exhaustive `default` branch (a non-ConnectorOperation string)
 *   - the `default` branch of `isFeatureEnabled` (provider that is not
 *     `gmail` or `google_calendar`, with a connector registered)
 */
import { describe, it, expect, vi } from 'vitest';
import {
  ConnectorGateway,
  InMemoryAccountStore,
  InMemoryIdempotencyStore,
  ReauthTracker,
  FeatureFlagRegistry,
  StubEmailConnector,
  StubCalendarConnector,
  CapabilityTokenSchema,
  ConnectorError,
  type Connector,
  type ConnectorRequest,
  type ConnectorId,
  type ConnectorOperation,
} from '../src/index.js';
import type { Account } from '../src/index.js';
import { InMemoryAuditLog } from '../../core/src/index.js';

function makeAccount(id: string, provider: Account['provider']): Account {
  return {
    id,
    user_id: 'u1',
    provider,
    handle: 'me@example.com',
    scopes: [],
    capabilities: [],
    status: 'active',
    created_at: '2025-01-01T00:00:00.000Z',
    updated_at: '2025-01-01T00:00:00.000Z',
  };
}

function makeToken(provider: Account['provider'], operation: string, accountId: string | null = null) {
  return CapabilityTokenSchema.parse({
    subject: 'agent:test',
    capabilities: [{ provider, operation, account_id: accountId }],
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  });
}

function makeContext(opts: { connectors?: Map<Account['provider'], Connector> } = {}) {
  const audit = new InMemoryAuditLog();
  const accounts = new InMemoryAccountStore();
  const idempotency = new InMemoryIdempotencyStore();
  const reauth = new ReauthTracker();
  const features = new FeatureFlagRegistry({ gmail: true, google_calendar: true, stub_email: true, stub_calendar: true });
  const connectors = opts.connectors ?? new Map<Account['provider'], Connector>([
    ['gmail', new StubEmailConnector()],
    ['google_calendar', new StubCalendarConnector()],
  ]);
  const gateway = new ConnectorGateway({ audit, accounts, idempotency, reauth, features, connectors });
  return { gateway, audit, accounts, idempotency, reauth, features };
}

describe('ConnectorGateway — FAG-25 coverage gaps in invokeConnector', () => {
  it('routes mail.forward through the dispatch switch', async () => {
    const ctx = makeContext();
    await ctx.accounts.upsert(makeAccount('a1', 'gmail'));

    const spy = vi.fn(async () => ({ provider_message_id: 'spy-fwd-id' }));
    class ForwardSpy implements Connector {
      readonly id: ConnectorId = 'gmail';
      readonly operations: ReadonlyArray<ConnectorOperation> = [
        'mail.list', 'mail.get', 'mail.send', 'mail.reply', 'mail.forward',
        'dm.conversations.list', 'dm.send',
      ];
      async listMessages(): Promise<never> { throw new ConnectorError('not_found', 'x'); }
      async getMessage(): Promise<never> { throw new ConnectorError('not_found', 'x'); }
      async sendMessage(): Promise<never> { throw new ConnectorError('not_found', 'x'); }
      async replyMessage(): Promise<never> { throw new ConnectorError('not_found', 'x'); }
      async forwardMessage(_req: ConnectorRequest, _audit: unknown) {
        return spy(_req, _audit);
      }
      async listConversations(): Promise<never> { throw new ConnectorError('not_found', 'x'); }
      async sendDm(): Promise<never> { throw new ConnectorError('not_found', 'x'); }
      async listCalendars(): Promise<never> { throw new ConnectorError('not_found', 'x'); }
      async listEvents(): Promise<never> { throw new ConnectorError('not_found', 'x'); }
      async getEvent(): Promise<never> { throw new ConnectorError('not_found', 'x'); }
      async createEvent(): Promise<never> { throw new ConnectorError('not_found', 'x'); }
      async updateEvent(): Promise<never> { throw new ConnectorError('not_found', 'x'); }
      async deleteEvent(): Promise<never> { throw new ConnectorError('not_found', 'x'); }
    }
    const gateway = new ConnectorGateway({
      audit: ctx.audit,
      accounts: ctx.accounts,
      idempotency: ctx.idempotency,
      reauth: ctx.reauth,
      features: ctx.features,
      connectors: new Map<Account['provider'], Connector>([
        ['gmail', new ForwardSpy()],
        ['google_calendar', new StubCalendarConnector()],
      ]),
    });
    // Drive the switch through the private dispatch — the cast is
    // safe because dispatch is a normal instance method at runtime.
    const out = await (gateway as unknown as {
      dispatch: (args: { operation: ConnectorOperation; input: { token: ReturnType<typeof makeToken>; account_id: string; args: { message_id: string; to: string[]; body: string }; idempotency_key: string } }) => Promise<{ provider_message_id: string }>;
    }).dispatch({
      operation: 'mail.forward',
      input: {
        token: makeToken('gmail', 'mail.forward', 'a1'),
        account_id: 'a1',
        args: { message_id: 'm1', to: ['x@example.com'], body: 'fwd' },
        idempotency_key: 'k-fwd-1',
      },
    });
    expect(out.provider_message_id).toBe('spy-fwd-id');
    expect(spy).toHaveBeenCalledOnce();
  });

  it('routes calendar.events.get/create/update/delete through the dispatch switch', async () => {
    const calls: string[] = [];
    class CalSpy implements Connector {
      readonly id: ConnectorId = 'google_calendar';
      readonly operations: ReadonlyArray<ConnectorOperation> = [
        'calendar.calendars.list', 'calendar.events.list', 'calendar.events.get',
        'calendar.events.create', 'calendar.events.update', 'calendar.events.delete',
      ];
      async listCalendars(): Promise<never> { throw new ConnectorError('not_found', 'x'); }
      async listEvents(): Promise<never> { throw new ConnectorError('not_found', 'x'); }
      async getEvent() { calls.push('getEvent'); return { event: { id: 'g' } as never }; }
      async createEvent() { calls.push('createEvent'); return { event: { id: 'c' } as never }; }
      async updateEvent() { calls.push('updateEvent'); return { event: { id: 'u' } as never }; }
      // Return a defined object rather than `undefined` so the
      // gateway's idempotency-commit step can JSON-stringify the
      // response (the InMemoryIdempotencyStore hash builder does
      // not tolerate `undefined`).
      async deleteEvent() { calls.push('deleteEvent'); return { deleted: true }; }
      async listMessages(): Promise<never> { throw new ConnectorError('not_found', 'x'); }
      async getMessage(): Promise<never> { throw new ConnectorError('not_found', 'x'); }
      async sendMessage(): Promise<never> { throw new ConnectorError('not_found', 'x'); }
      async replyMessage(): Promise<never> { throw new ConnectorError('not_found', 'x'); }
      async forwardMessage(): Promise<never> { throw new ConnectorError('not_found', 'x'); }
      async listConversations(): Promise<never> { throw new ConnectorError('not_found', 'x'); }
      async sendDm(): Promise<never> { throw new ConnectorError('not_found', 'x'); }
    }
    const ctx = makeContext({
      connectors: new Map<Account['provider'], Connector>([
        ['gmail', new StubEmailConnector()],
        ['google_calendar', new CalSpy()],
      ]),
    });
    await ctx.accounts.upsert(makeAccount('a1', 'google_calendar'));
    const dispatch = (ctx.gateway as unknown as {
      dispatch: (args: { operation: ConnectorOperation; input: { token: ReturnType<typeof makeToken>; account_id: string; args: unknown; idempotency_key: string } }) => Promise<unknown>;
    }).dispatch.bind(ctx.gateway);

    await dispatch({
      operation: 'calendar.events.get',
      input: { token: makeToken('google_calendar', 'calendar.events.get', 'a1'), account_id: 'a1', args: { event_id: 'e1' }, idempotency_key: 'k1' },
    });
    await dispatch({
      operation: 'calendar.events.create',
      input: {
        token: makeToken('google_calendar', 'calendar.events.create', 'a1'),
        account_id: 'a1',
        args: { title: 't', start: { tz: 'UTC', at: '2025-01-01T10:00:00.000Z' }, end: { tz: 'UTC', at: '2025-01-01T11:00:00.000Z' } },
        idempotency_key: 'k2',
      },
    });
    await dispatch({
      operation: 'calendar.events.update',
      input: {
        token: makeToken('google_calendar', 'calendar.events.update', 'a1'),
        account_id: 'a1',
        args: { event_id: 'e1', etag: 'etag-1' },
        idempotency_key: 'k3',
      },
    });
    await dispatch({
      operation: 'calendar.events.delete',
      input: {
        token: makeToken('google_calendar', 'calendar.events.delete', 'a1'),
        account_id: 'a1',
        args: { event_id: 'e1' },
        idempotency_key: 'k4',
      },
    });
    expect(calls).toEqual(['getEvent', 'createEvent', 'updateEvent', 'deleteEvent']);
  });

  it('throws on the exhaustive default branch in invokeConnector', async () => {
    // The exhaustive default is only reachable when a connector
    // claims an operation that the switch does not handle. Build a
    // connector that does so, then drive dispatch with that custom
    // operation value.
    class BogusOp implements Connector {
      readonly id: ConnectorId = 'gmail';
      // Cast keeps the assignment type-safe even though the operation
      // is not in the ConnectorOperation union.
      readonly operations = ['mail.list', 'mail.get', 'mail.send', 'mail.bogus'] as unknown as ReadonlyArray<ConnectorOperation>;
      async listMessages(): Promise<never> { throw new ConnectorError('not_found', 'x'); }
      async getMessage(): Promise<never> { throw new ConnectorError('not_found', 'x'); }
      async sendMessage(): Promise<never> { throw new ConnectorError('not_found', 'x'); }
      async replyMessage(): Promise<never> { throw new ConnectorError('not_found', 'x'); }
      async forwardMessage(): Promise<never> { throw new ConnectorError('not_found', 'x'); }
      async listConversations(): Promise<never> { throw new ConnectorError('not_found', 'x'); }
      async sendDm(): Promise<never> { throw new ConnectorError('not_found', 'x'); }
      async listCalendars(): Promise<never> { throw new ConnectorError('not_found', 'x'); }
      async listEvents(): Promise<never> { throw new ConnectorError('not_found', 'x'); }
      async getEvent(): Promise<never> { throw new ConnectorError('not_found', 'x'); }
      async createEvent(): Promise<never> { throw new ConnectorError('not_found', 'x'); }
      async updateEvent(): Promise<never> { throw new ConnectorError('not_found', 'x'); }
      async deleteEvent(): Promise<never> { throw new ConnectorError('not_found', 'x'); }
    }
    const ctx = makeContext({
      connectors: new Map<Account['provider'], Connector>([
        ['gmail', new BogusOp()],
        ['google_calendar', new StubCalendarConnector()],
      ]),
    });
    await ctx.accounts.upsert(makeAccount('a1', 'gmail'));
    // Build the token by hand — the schema refuses the unknown
    // operation, but the dispatch only checks the structural
    // capability via `tokenAuthorizes`.
    const fakeToken = {
      subject: 'agent:test',
      capabilities: [{ provider: 'gmail' as const, operation: 'mail.bogus' as string, account_id: 'a1' }],
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    };
    const dispatch = (ctx.gateway as unknown as {
      dispatch: (args: { operation: string; input: { token: typeof fakeToken; account_id: string; args: unknown; idempotency_key: string } }) => Promise<unknown>;
    }).dispatch.bind(ctx.gateway);
    await expect(
      dispatch({
        operation: 'mail.bogus',
        input: { token: fakeToken, account_id: 'a1', args: {}, idempotency_key: 'k-bogus' },
      }),
    ).rejects.toThrow(/unhandled operation/);
  });
});

describe('ConnectorGateway — isFeatureEnabled default branch', () => {
  it('uses the stub flags for non-Google providers when their connector is registered', async () => {
    // whatsapp is not in the switch; the default branch returns
    // `stub_email || stub_calendar`. With both flags on the
    // feature gate passes and the connector is invoked.
    class StubNoopWhatsapp implements Connector {
      readonly id: ConnectorId = 'whatsapp';
      readonly operations: ReadonlyArray<ConnectorOperation> = ['dm.conversations.list'];
      async listMessages(): Promise<never> { throw new ConnectorError('not_found', 'x'); }
      async getMessage(): Promise<never> { throw new ConnectorError('not_found', 'x'); }
      async sendMessage(): Promise<never> { throw new ConnectorError('not_found', 'x'); }
      async replyMessage(): Promise<never> { throw new ConnectorError('not_found', 'x'); }
      async forwardMessage(): Promise<never> { throw new ConnectorError('not_found', 'x'); }
      async listConversations() { return { conversations: [], next_page_token: null }; }
      async sendDm(): Promise<never> { throw new ConnectorError('not_found', 'x'); }
      async listCalendars(): Promise<never> { throw new ConnectorError('not_found', 'x'); }
      async listEvents(): Promise<never> { throw new ConnectorError('not_found', 'x'); }
      async getEvent(): Promise<never> { throw new ConnectorError('not_found', 'x'); }
      async createEvent(): Promise<never> { throw new ConnectorError('not_found', 'x'); }
      async updateEvent(): Promise<never> { throw new ConnectorError('not_found', 'x'); }
      async deleteEvent(): Promise<never> { throw new ConnectorError('not_found', 'x'); }
    }
    const ctx = makeContext({
      connectors: new Map<Account['provider'], Connector>([
        ['gmail', new StubEmailConnector()],
        ['google_calendar', new StubCalendarConnector()],
        ['whatsapp', new StubNoopWhatsapp()],
      ]),
    });
    await ctx.accounts.upsert(makeAccount('a1', 'whatsapp'));
    const out = await ctx.gateway.dmConversationsList({
      token: makeToken('whatsapp', 'dm.conversations.list', 'a1'),
      account_id: 'a1',
      args: { channel: 'whatsapp' },
    });
    expect(out.conversations).toEqual([]);
  });

  it('refuses the call when both stub flags are off for a non-Google provider', async () => {
    class StubNoopWhatsapp implements Connector {
      readonly id: ConnectorId = 'whatsapp';
      readonly operations: ReadonlyArray<ConnectorOperation> = ['dm.conversations.list'];
      async listMessages(): Promise<never> { throw new ConnectorError('not_found', 'x'); }
      async getMessage(): Promise<never> { throw new ConnectorError('not_found', 'x'); }
      async sendMessage(): Promise<never> { throw new ConnectorError('not_found', 'x'); }
      async replyMessage(): Promise<never> { throw new ConnectorError('not_found', 'x'); }
      async forwardMessage(): Promise<never> { throw new ConnectorError('not_found', 'x'); }
      async listConversations(): Promise<never> { throw new ConnectorError('not_found', 'x'); }
      async sendDm(): Promise<never> { throw new ConnectorError('not_found', 'x'); }
      async listCalendars(): Promise<never> { throw new ConnectorError('not_found', 'x'); }
      async listEvents(): Promise<never> { throw new ConnectorError('not_found', 'x'); }
      async getEvent(): Promise<never> { throw new ConnectorError('not_found', 'x'); }
      async createEvent(): Promise<never> { throw new ConnectorError('not_found', 'x'); }
      async updateEvent(): Promise<never> { throw new ConnectorError('not_found', 'x'); }
      async deleteEvent(): Promise<never> { throw new ConnectorError('not_found', 'x'); }
    }
    const audit = new InMemoryAuditLog();
    const accounts = new InMemoryAccountStore();
    const features = new FeatureFlagRegistry({ gmail: true, google_calendar: true, stub_email: false, stub_calendar: false });
    const gateway = new ConnectorGateway({
      audit,
      accounts,
      idempotency: new InMemoryIdempotencyStore(),
      reauth: new ReauthTracker(),
      features,
      connectors: new Map<Account['provider'], Connector>([
        ['gmail', new StubEmailConnector()],
        ['google_calendar', new StubCalendarConnector()],
        ['whatsapp', new StubNoopWhatsapp()],
      ]),
    });
    await accounts.upsert(makeAccount('a1', 'whatsapp'));
    await expect(
      gateway.dmConversationsList({
        token: makeToken('whatsapp', 'dm.conversations.list', 'a1'),
        account_id: 'a1',
        args: { channel: 'whatsapp' },
      }),
    ).rejects.toMatchObject({ code: 'feature_disabled' });
  });
});
