/**
 * @fagaos/connectors — interface contracts for external integrations.
 *
 * Per FAG-8 scope: interface only. Concrete implementations (Gmail,
 * WhatsApp, Google Calendar, etc.) land under separate FAG-5 issues and
 * are deliberately out of scope here.
 *
 * Every connector must:
 *   - require a signed capability token for every call
 *   - emit an audit log entry per call (allow, deny, error)
 *   - be idempotent at the operation level
 *   - respect rate limits and back off
 */

export interface ConnectorCapability {
  /** Resource type, e.g. "connector.gmail". */
  type: string;
  /** Operation, e.g. "send", "list", "search". */
  operation: string;
}

export interface ConnectorRequest {
  capability: ConnectorCapability;
  args: Record<string, unknown>;
}

export interface ConnectorResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string };
  /** Echoed for idempotency: same request id never re-executes. */
  idempotencyKey: string;
}

export interface Connector {
  readonly id: string;
  /** Verify a capability token covers this call. */
  authorize(capability: ConnectorCapability): boolean;
  invoke<T = unknown>(request: ConnectorRequest): Promise<ConnectorResponse<T>>;
}

export const CONNECTORS_NOT_IMPLEMENTED =
  'Connector implementations (Gmail, WhatsApp, Calendar, …) land in FAG-5 follow-ups. Phase 0 ships the contract only.';
