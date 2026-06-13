/**
 * Connector contract.
 *
 * Every provider integration implements this interface. The gateway never
 * talks to a provider directly — it always goes through a `Connector`.
 * Two structural rules every connector must obey:
 *
 *   1. Inputs are normalised (`Account`, `CapabilityToken`, `ConnectorRequest`).
 *   2. Outputs are normalised (the `Message`/`Event`/`Conversation` shapes
 *      in `../models/schemas.js`). The connector is responsible for the
 *      wire-format translation, not the gateway.
 *
 * The connector is also responsible for:
 *   - emitting audit entries through the supplied `AuditLog` (the
 *     gateway-level audit wrapper is one entry per call; connectors may
 *     add entries for provider-level events like token refreshes)
 *   - enforcing its own rate-limit budget (the gateway's per-account
 *     budget is upstream of the connector)
 *   - honouring the idempotency key in `ConnectorRequest`
 *
 * A connector that fails to authorise the request MUST throw a
 * `ConnectorError` with code `unauthorized` (token) or `forbidden`
 * (capability), not a generic `Error`.
 */
import type { CapabilityToken, ConnectorOperation } from './capability.js';
import type {
  Account,
  Conversation,
  Event,
  Message,
  Provider,
} from './models/schemas.js';
import type { AuditLog } from '@fagaos/core';

/** Stable identifier for a connector (e.g. "gmail", "google_calendar"). */
export type ConnectorId = Provider;

/**
 * The per-call envelope. Connectors receive the request already-scoped
 * to a single account; the gateway enforces the per-account budget and
 * idempotency before this is constructed.
 */
export interface ConnectorRequest<TArgs = unknown> {
  /** Caller's capability token. */
  token: CapabilityToken;
  /** The account the request targets. */
  account: Account;
  /** Operation being performed. Mirrors `ConnectorOperation`. */
  operation: ConnectorOperation;
  /** Free-form, operation-specific arguments. Schema-validated by the connector. */
  args: TArgs;
  /**
   * Idempotency key for writes. Read-only calls may receive a fresh
   * value per call (gateway-guaranteed to be UUID-shaped).
   */
  idempotency_key: string;
  /**
   * Per-request trace id. Connector echoes it back in audit entries and
   * provider requests so cross-system traces line up.
   */
  trace_id: string;
}

/** Read-only mail result. */
export interface MailListResult {
  messages: Message[];
  /** Provider-issued cursor for the next page, if any. */
  next_page_token: string | null;
}

export interface MailGetResult {
  message: Message;
}

/** Send-mail result. */
export interface MailSendResult {
  /** Provider-issued id of the dispatched message. */
  provider_message_id: string;
  thread_id: string | null;
}

/** Read-only conversation list. */
export interface DmConversationsListResult {
  conversations: Conversation[];
  next_page_token: string | null;
}

/** Send-DM result. */
export interface DmSendResult {
  provider_message_id: string;
}

/** Calendar list calendars. */
export interface CalendarsListResult {
  calendars: import('./models/schemas.js').Calendar[];
}

/** Calendar events.list. */
export interface EventsListResult {
  events: Event[];
  /**
   * Provider-issued sync token. The connector persists this for the
   * account and re-uses it on the next call. On `410 GONE` the gateway
   * wipes the stored token and the next call performs a full sync.
   */
  next_sync_token: string | null;
}

/** Calendar events.get. */
export interface EventGetResult {
  event: Event;
}

/**
 * The connector contract. Every method corresponds 1:1 with a
 * `ConnectorOperation`. The gateway is the only caller.
 */
export interface Connector {
  readonly id: ConnectorId;
  /**
   * Read-only list of operations this connector implements. Used by the
   * gateway to fail fast on unsupported ops without paying the
   * `invoke` overhead.
   */
  readonly operations: ReadonlyArray<ConnectorOperation>;

  /** Mail list. */
  listMessages(request: ConnectorRequest, audit: AuditLog): Promise<MailListResult>;
  /** Mail get. */
  getMessage(request: ConnectorRequest, audit: AuditLog): Promise<MailGetResult>;
  /** Mail send. Read-only mode in this issue; the stub returns a deterministic id. */
  sendMessage(request: ConnectorRequest, audit: AuditLog): Promise<MailSendResult>;

  /** DM conversations list. */
  listConversations(
    request: ConnectorRequest,
    audit: AuditLog,
  ): Promise<DmConversationsListResult>;
  /** DM send. */
  sendDm(request: ConnectorRequest, audit: AuditLog): Promise<DmSendResult>;

  /** Calendar: list calendars on the account. */
  listCalendars(request: ConnectorRequest, audit: AuditLog): Promise<CalendarsListResult>;
  /** Calendar: list events with optional sync token. */
  listEvents(request: ConnectorRequest, audit: AuditLog): Promise<EventsListResult>;
  /** Calendar: get one event. */
  getEvent(request: ConnectorRequest, audit: AuditLog): Promise<EventGetResult>;
}
