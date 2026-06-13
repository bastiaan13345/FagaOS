/**
 * Connector error taxonomy.
 *
 * Every error a connector or the gateway raises is one of these. The shape
 * is fixed so callers can `switch` on `code` and route to user-facing
 * recovery flows (reauth prompt, backoff, conflict, ...).
 *
 * Codes are stable and snake_case. Do not rename without a migration.
 */

export type ConnectorErrorCode =
  | 'invalid_input'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'rate_limited'
  | 'provider_error'
  | 'provider_unavailable'
  | 'webhook_signature_invalid'
  | 'webhook_payload_invalid'
  | 'reauth_required'
  | 'idempotency_conflict'
  | 'feature_disabled'
  | 'internal';

export class ConnectorError extends Error {
  readonly code: ConnectorErrorCode;
  /** Provider-issued detail (HTTP status, provider error code, ...). */
  override readonly cause?: unknown;

  constructor(code: ConnectorErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = 'ConnectorError';
    this.code = code;
    this.cause = cause;
  }

  static isConnectorError(value: unknown): value is ConnectorError {
    return value instanceof ConnectorError;
  }
}

/**
 * Specialisation: the gateway did not find a registered connector for the
 * requested provider. Distinct from `not_found` so callers can react to
 * "we have not shipped this provider yet" vs. "the resource does not
 * exist".  `code` is `feature_disabled` for parity with disabled features
 * behind a flag.
 */
export class ConnectorNotRegisteredError extends ConnectorError {
  constructor(provider: string) {
    super('feature_disabled', `no connector registered for provider "${provider}"`);
    this.name = 'ConnectorNotRegisteredError';
  }
}
