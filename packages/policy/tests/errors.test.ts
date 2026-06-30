/**
 * Tests for the typed policy errors.
 */
import { describe, expect, it } from 'vitest';
import {
  GovernanceError,
  KeyRetiredError,
  PolicyDeniedError,
  PolicyError,
  SecretNotFoundError,
  TokenExpiredError,
  TokenScopeMismatchError,
  TokenSignatureInvalidError,
} from '../src/index.js';

describe('PolicyError', () => {
  it('carries the code and message', () => {
    const e = new PolicyError('invalid_request', 'bad input', { x: 1 });
    expect(e.code).toBe('invalid_request');
    expect(e.message).toBe('bad input');
    expect(e.details).toEqual({ x: 1 });
    expect(e.name).toBe('PolicyError');
  });
});

describe('PolicyDeniedError', () => {
  it('is a PolicyError with code deny', () => {
    const e = new PolicyDeniedError('rule denied');
    expect(e.code).toBe('deny');
    expect(e.message).toBe('rule denied');
    expect(e.name).toBe('PolicyDeniedError');
  });
});

describe('TokenSignatureInvalidError', () => {
  it('is a PolicyError with code token_signature_invalid', () => {
    const e = new TokenSignatureInvalidError('bad sig');
    expect(e.code).toBe('token_signature_invalid');
    expect(e.name).toBe('TokenSignatureInvalidError');
  });
});

describe('TokenExpiredError', () => {
  it('is a PolicyError with code token_expired', () => {
    const e = new TokenExpiredError('expired');
    expect(e.code).toBe('token_expired');
    expect(e.name).toBe('TokenExpiredError');
  });
});

describe('TokenScopeMismatchError', () => {
  it('is a PolicyError with code token_scope_mismatch', () => {
    const e = new TokenScopeMismatchError('mismatch');
    expect(e.code).toBe('token_scope_mismatch');
    expect(e.name).toBe('TokenScopeMismatchError');
  });
});

describe('SecretNotFoundError', () => {
  it('is a PolicyError with code secret_not_found', () => {
    const e = new SecretNotFoundError('no key');
    expect(e.code).toBe('secret_not_found');
    expect(e.name).toBe('SecretNotFoundError');
  });
});

describe('KeyRetiredError', () => {
  it('is a PolicyError with code key_retired', () => {
    const e = new KeyRetiredError('rotated');
    expect(e.code).toBe('key_retired');
    expect(e.name).toBe('KeyRetiredError');
  });
});

describe('GovernanceError', () => {
  it('is a PolicyError with code governance_invalid_transition', () => {
    const e = new GovernanceError('governance_invalid_transition', 'bad');
    expect(e.code).toBe('governance_invalid_transition');
    expect(e.name).toBe('GovernanceError');
  });
  it('is a PolicyError with code governance_version_not_found', () => {
    const e = new GovernanceError('governance_version_not_found', 'missing');
    expect(e.code).toBe('governance_version_not_found');
  });
  it('is a PolicyError with code governance_version_not_in_state', () => {
    const e = new GovernanceError('governance_version_not_in_state', 'wrong state');
    expect(e.code).toBe('governance_version_not_in_state');
  });
});
