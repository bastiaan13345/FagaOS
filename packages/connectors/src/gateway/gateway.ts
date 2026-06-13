/**
 * Connector gateway.
 *
 * The gateway is the *only* component the agent runtime talks to. It:
 *   1. Routes the call to the right connector (provider-keyed map).
 *   2. Checks the caller's capability token against the (provider,
 *      operation, account_id) triple.
 *   3. Reserves or looks up an idempotency key. On hit, returns the
 *      stored response verbatim.
 *   4. Consumes one unit of the per-account rate budget. On denial,
 *      returns `rate_limited` with the supplied `retry_after_ms`.
 *   5. Calls the connector. Catches `ConnectorError` and emits the
 *      matching audit entry; rethrows.
 *   6. Commits the response under the idempotency key.
 *   7. Emits an `ok` audit entry for the call.
 *
 * Every public method emits at least one audit entry. The audit actor
 * is the token's `subject`; the action name is `connector.<provider>.<op>`.
 *
 * Reauth: the gateway refuses to dispatch a call when the account is
 * in `reauth_required` state. The connector is responsible for
 * flipping the flag via the supplied `ReauthTracker` on token-refresh
 * failures; the gateway is the gate.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { AuditLog } from '@fagaos/core';
import { ConnectorError, ConnectorNotRegisteredError } from '../errors.js';
import type { Connector, ConnectorRequest } from '../connector.js';
import type { CapabilityToken, ConnectorOperation } from '../capability.js';
import { tokenAuthorizes } from '../capability.js';
import { RateLimitBudget } from '../store/rate-limit-budget.js';
import type { AccountStore } from '../store/account-store.js';
import type { IdempotencyStore } from '../store/idempotency-store.js';
import { ReauthTracker } from '../store/reauth-tracker.js';
import { FeatureFlagRegistry } from '../features/feature-flags.js';
import type { Provider } from '../models/schemas.js';

// ---------------------------------------------------------------------------
// Public argument shapes (per-operation, validated by the gateway before
// the connector is invoked). The shapes are documented in the OpenAPI
// spec; do not change them without a migration.
// ---------------------------------------------------------------------------

export interface MailListInput {
  token: CapabilityToken;
  account_id: string;
  args: { query?: string; limit?: number; page_token?: string | null };
  idempotency_key?: string;
  trace_id?: string;
}
export interface MailGetInput {
  token: CapabilityToken;
  account_id: string;
  args: { message_id: string };
  idempotency_key?: string;
  trace_id?: string;
}
export interface MailSendInput {
  token: CapabilityToken;
  account_id: string;
  args: {
    to: string[];
    subject: string;
    body: string;
    thread_id?: string | null;
  };
  idempotency_key?: string;
  trace_id?: string;
}
export interface DmConversationsListInput {
  token: CapabilityToken;
  account_id: string;
  args: { channel?: 'sms' | 'whatsapp' | 'instagram' | 'telegram' | 'discord' | 'slack'; limit?: number };
  idempotency_key?: string;
  trace_id?: string;
}
export interface DmSendInput {
  token: CapabilityToken;
  account_id: string;
  args: { conversation_id: string; body: string };
  idempotency_key?: string;
  trace_id?: string;
}
export interface CalendarsListInput {
  token: CapabilityToken;
  account_id: string;
  args?: Record<string, never>;
  idempotency_key?: string;
  trace_id?: string;
}
export interface EventsListInput {
  token: CapabilityToken;
  account_id: string;
  args: {
    calendar_id?: string;
    time_min?: string;
    time_max?: string;
    limit?: number;
    sync_token?: string | null;
  };
  idempotency_key?: string;
  trace_id?: string;
}

// ---------------------------------------------------------------------------
// Gateway options
// ---------------------------------------------------------------------------

export interface ConnectorGatewayOptions {
  audit: AuditLog;
  accounts: AccountStore;
  idempotency: IdempotencyStore;
  reauth: ReauthTracker;
  features: FeatureFlagRegistry;
  /**
   * Provider-keyed connector registry. The gateway looks up
   * `connectors[provider]` and dispatches. Connectors are
   * registered by `registerConnector` so feature-flag gating is
   * centralised.
   */
  connectors: Map<Provider, Connector>;
  /** Clock for tests / deterministic runs. */
  clock?: () => Date;
}

export class ConnectorGateway {
  private readonly audit: AuditLog;
  private readonly accounts: AccountStore;
  private readonly idempotency: IdempotencyStore;
  private readonly reauth: ReauthTracker;
  private readonly features: FeatureFlagRegistry;
  private readonly connectors: Map<Provider, Connector>;
  private readonly clock: () => Date;
  private readonly budgets = new Map<string, RateLimitBudget>();

  constructor(opts: ConnectorGatewayOptions) {
    this.audit = opts.audit;
    this.accounts = opts.accounts;
    this.idempotency = opts.idempotency;
    this.reauth = opts.reauth;
    this.features = opts.features;
    this.connectors = opts.connectors;
    this.clock = opts.clock ?? (() => new Date());
  }

  // -------------------------------------------------------------------------
  // Public surface
  // -------------------------------------------------------------------------

  mailList(input: MailListInput) {
    return this.dispatch<'mail.list', { messages: unknown[]; next_page_token: string | null }>({
      operation: 'mail.list',
      input,
    });
  }

  mailGet(input: MailGetInput) {
    return this.dispatch<'mail.get', { message: unknown }>({
      operation: 'mail.get',
      input,
    });
  }

  mailSend(input: MailSendInput) {
    return this.dispatch<'mail.send', { provider_message_id: string; thread_id: string | null }>({
      operation: 'mail.send',
      input,
    });
  }

  dmConversationsList(input: DmConversationsListInput) {
    return this.dispatch<'dm.conversations.list', { conversations: unknown[]; next_page_token: string | null }>({
      operation: 'dm.conversations.list',
      input,
    });
  }

  dmSend(input: DmSendInput) {
    return this.dispatch<'dm.send', { provider_message_id: string }>({
      operation: 'dm.send',
      input,
    });
  }

  calendarCalendarsList(input: CalendarsListInput) {
    return this.dispatch<'calendar.calendars.list', { calendars: unknown[] }>({
      operation: 'calendar.calendars.list',
      input,
    });
  }

  calendarEventsList(input: EventsListInput) {
    return this.dispatch<'calendar.events.list', { events: unknown[]; next_sync_token: string | null }>({
      operation: 'calendar.events.list',
      input,
    });
  }

  // -------------------------------------------------------------------------
  // Dispatch
  // -------------------------------------------------------------------------

  private async dispatch<Op extends ConnectorOperation, R>(args: {
    operation: Op;
    input:
      | MailListInput
      | MailGetInput
      | MailSendInput
      | DmConversationsListInput
      | DmSendInput
      | CalendarsListInput
      | EventsListInput;
  }): Promise<R> {
    const { operation, input } = args;
    const account = await this.accounts.get(input.account_id);
    if (!account) {
      throw new ConnectorError('not_found', `account "${input.account_id}" not found`);
    }
    if (account.status === 'reauth_required') {
      throw new ConnectorError('reauth_required', `account "${input.account_id}" requires re-authorisation`);
    }
    if (account.status === 'paused' || account.status === 'revoked') {
      throw new ConnectorError('forbidden', `account "${input.account_id}" is ${account.status}`);
    }
    if (!tokenAuthorizes(input.token, {
      provider: account.provider,
      operation,
      account_id: account.id,
    })) {
      await this.audit.append({
        actor: { id: input.token.subject },
        action: { name: `connector.${account.provider}.${operation}`, outcome: 'deny' },
        resource: { type: 'connector.account', id: account.id },
      });
      throw new ConnectorError('forbidden', `token does not authorise connector.${account.provider}.${operation} on account ${account.id}`);
    }
    const connector = this.connectors.get(account.provider);
    if (!connector) {
      throw new ConnectorNotRegisteredError(account.provider);
    }
    if (!connector.operations.includes(operation)) {
      throw new ConnectorError('not_found', `connector "${connector.id}" does not implement ${operation}`);
    }
    if (!this.isFeatureEnabled(account.provider, operation)) {
      throw new ConnectorError('feature_disabled', `feature flag for provider "${account.provider}" is off`);
    }

    const budget = this.budgetFor(account.id);
    const decision = budget.consume(1);
    if (!decision.allowed) {
      await this.audit.append({
        actor: { id: input.token.subject },
        action: { name: `connector.${account.provider}.${operation}`, outcome: 'deny' },
        resource: { type: 'connector.account', id: account.id },
        payload: { reason: 'rate_limited', retry_after_ms: decision.retry_after_ms },
      });
      throw new ConnectorError(
        'rate_limited',
        `rate budget exhausted for account "${account.id}"; retry after ${decision.retry_after_ms}ms`,
      );
    }

    const idempotencyKey = input.idempotency_key ?? randomUUID();
    const requestHash = createHash('sha256')
      .update(JSON.stringify({ operation, account_id: account.id, args: input.args }))
      .digest('hex');
    const traceId = input.trace_id ?? randomUUID();

    const replay = await this.idempotency.reserveOrLookup({
      key: idempotencyKey,
      request_hash: requestHash,
    });
    if (replay) {
      await this.audit.append({
        actor: { id: input.token.subject },
        action: { name: `connector.${account.provider}.${operation}`, outcome: 'ok' },
        resource: { type: 'connector.account', id: account.id },
        payload: { replay: true, idempotency_key: idempotencyKey, trace_id: traceId },
      });
      return replay.response as R;
    }

    const request: ConnectorRequest = {
      token: input.token,
      account,
      operation,
      args: input.args as Record<string, unknown>,
      idempotency_key: idempotencyKey,
      trace_id: traceId,
    };

    let result: unknown;
    try {
      result = await this.invokeConnector(connector, operation, request);
    } catch (err) {
      const code = err instanceof ConnectorError ? err.code : 'internal';
      const outcome = code === 'internal' ? 'error' : 'deny';
      await this.audit.append({
        actor: { id: input.token.subject },
        action: { name: `connector.${account.provider}.${operation}`, outcome },
        resource: { type: 'connector.account', id: account.id },
        payload: { error_code: code, trace_id: traceId, idempotency_key: idempotencyKey },
      });
      if (err instanceof ConnectorError && err.code === 'reauth_required') {
        this.reauth.markReauthRequired(account.id, err.message);
      }
      throw err;
    }

    await this.idempotency.commit({
      key: idempotencyKey,
      request_hash: requestHash,
      response: result,
    });
    await this.audit.append({
      actor: { id: input.token.subject },
      action: { name: `connector.${account.provider}.${operation}`, outcome: 'ok' },
      resource: { type: 'connector.account', id: account.id },
      payload: { trace_id: traceId, idempotency_key: idempotencyKey },
    });
    return result as R;
  }

  private async invokeConnector(
    connector: Connector,
    operation: ConnectorOperation,
    request: ConnectorRequest,
  ): Promise<unknown> {
    switch (operation) {
      case 'mail.list':
        return connector.listMessages(request, this.audit);
      case 'mail.get':
        return connector.getMessage(request, this.audit);
      case 'mail.send':
        return connector.sendMessage(request, this.audit);
      case 'dm.conversations.list':
        return connector.listConversations(request, this.audit);
      case 'dm.send':
        return connector.sendDm(request, this.audit);
      case 'calendar.calendars.list':
        return connector.listCalendars(request, this.audit);
      case 'calendar.events.list':
        return connector.listEvents(request, this.audit);
      case 'calendar.events.get':
        return connector.getEvent(request, this.audit);
      default: {
        const exhaustive: never = operation;
        throw new Error(`unhandled operation: ${String(exhaustive)}`);
      }
    }
  }

  private budgetFor(accountId: string): RateLimitBudget {
    const existing = this.budgets.get(accountId);
    if (existing) return existing;
    // Default: 250 units / minute. Per-provider overrides are a
    // future enhancement; the connector may consult a config map.
    const budget = new RateLimitBudget({ maxUnits: 250, windowMs: 60_000, clock: () => this.clock().getTime() });
    this.budgets.set(accountId, budget);
    return budget;
  }

  private isFeatureEnabled(provider: Provider, _operation: ConnectorOperation): boolean {
    // Map (provider, operation) to a feature flag. Most pairs map to
    // the provider's flag. Mail-shaped Gmail returns true for the
    // stub email default-on flag in the meantime.
    switch (provider) {
      case 'gmail':
        return this.features.isEnabled('gmail') || this.features.isEnabled('stub_email');
      case 'google_calendar':
        return this.features.isEnabled('google_calendar') || this.features.isEnabled('stub_calendar');
      default:
        return this.features.isEnabled('stub_email') || this.features.isEnabled('stub_calendar');
    }
  }
}
