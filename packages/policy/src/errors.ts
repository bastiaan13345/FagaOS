/**
 * Typed errors raised by the policy stack.
 *
 * Every code is a stable string so callers (control plane, gateway,
 * desktop-bridge) can pattern-match on it without parsing message
 * text. The `code` is what the audit log records; the `message` is
 * for human operators.
 */

export type PolicyErrorCode =
  | 'invalid_request'
  | 'unknown_action'
  | 'unknown_resource_type'
  | 'deny'
  | 'no_matching_allow'
  | 'rule_compile_error'
  | 'secret_not_found'
  | 'secret_already_exists'
  | 'key_not_active'
  | 'key_retired'
  | 'token_malformed'
  | 'token_signature_invalid'
  | 'token_expired'
  | 'token_not_yet_valid'
  | 'token_scope_mismatch'
  | 'token_unsupported_algorithm'
  | 'token_unknown_key'
  | 'governance_invalid_transition'
  | 'governance_version_not_found'
  | 'governance_version_not_in_state';

export class PolicyError extends Error {
  public readonly code: PolicyErrorCode;
  public readonly details: Record<string, unknown> | undefined;

  constructor(code: PolicyErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'PolicyError';
    this.code = code;
    this.details = details;
  }
}

export class PolicyDeniedError extends PolicyError {
  constructor(reason: string, details?: Record<string, unknown>) {
    super('deny', reason, details);
    this.name = 'PolicyDeniedError';
  }
}

export class TokenSignatureInvalidError extends PolicyError {
  constructor(reason: string, details?: Record<string, unknown>) {
    super('token_signature_invalid', reason, details);
    this.name = 'TokenSignatureInvalidError';
  }
}

export class TokenExpiredError extends PolicyError {
  constructor(reason: string, details?: Record<string, unknown>) {
    super('token_expired', reason, details);
    this.name = 'TokenExpiredError';
  }
}

export class TokenScopeMismatchError extends PolicyError {
  constructor(reason: string, details?: Record<string, unknown>) {
    super('token_scope_mismatch', reason, details);
    this.name = 'TokenScopeMismatchError';
  }
}

export class SecretNotFoundError extends PolicyError {
  constructor(reason: string, details?: Record<string, unknown>) {
    super('secret_not_found', reason, details);
    this.name = 'SecretNotFoundError';
  }
}

export class KeyRetiredError extends PolicyError {
  constructor(reason: string, details?: Record<string, unknown>) {
    super('key_retired', reason, details);
    this.name = 'KeyRetiredError';
  }
}

export class GovernanceError extends PolicyError {
  constructor(
    code: Extract<PolicyErrorCode, 'governance_invalid_transition' | 'governance_version_not_found' | 'governance_version_not_in_state'>,
    reason: string,
    details?: Record<string, unknown>,
  ) {
    super(code, reason, details);
    this.name = 'GovernanceError';
  }
}
