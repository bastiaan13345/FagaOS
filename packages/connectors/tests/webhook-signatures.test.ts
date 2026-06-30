/**
 * Webhook signature verification tests.
 *
 * The verifiers are the security boundary for every webhook ingress;
 * a regression in any of them is a silent security bug. The tests
 * use deterministic inputs and constant-time-comparison-safe fixtures
 * so a regression in the path from "header is missing" to "raise
 * webhook_signature_invalid" is caught.
 */
import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  verifyMetaSignature,
  verifySlackSignature,
  verifyTelegramSecretToken,
  verifyGraphClientState,
  verifyGoogleOidcBearer,
} from '../src/webhooks/signatures.js';
import { ConnectorError } from '../src/errors.js';

describe('verifyMetaSignature', () => {
  const app_secret = 'shhh-this-is-secret';
  const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [] });

  it('accepts a valid sha256 signature', () => {
    const sig = 'sha256=' + createHmac('sha256', app_secret).update(body).digest('hex');
    expect(() => verifyMetaSignature({ app_secret, body, signature_header: sig })).not.toThrow();
  });

  it('rejects a missing signature', () => {
    expect(() => verifyMetaSignature({ app_secret, body, signature_header: null })).toThrow(ConnectorError);
  });

  it('rejects a tampered body', () => {
    const sig = 'sha256=' + createHmac('sha256', app_secret).update(body).digest('hex');
    const tampered = body + '!';
    expect(() => verifyMetaSignature({ app_secret, body: tampered, signature_header: sig })).toThrow(ConnectorError);
  });

  it('rejects a wrong secret', () => {
    const sig = 'sha256=' + createHmac('sha256', 'wrong-secret').update(body).digest('hex');
    expect(() => verifyMetaSignature({ app_secret, body, signature_header: sig })).toThrow(ConnectorError);
  });
});

describe('verifySlackSignature', () => {
  const signing_secret = 'slack-signing-secret';
  const ts = '1700000000';
  const body = '{"event":"hello"}';
  const base = `v0:${ts}:${body}`;

  it('accepts a valid signature within the tolerance window', () => {
    const sig = 'v0=' + createHmac('sha256', signing_secret).update(base).digest('base64');
    // The function treats `now` as epoch seconds (or multiplies it by 1000).
    expect(() => verifySlackSignature({ signing_secret, timestamp: ts, signature: sig, body, now: 1_700_000_000 })).not.toThrow();
  });

  it('rejects a stale timestamp', () => {
    const sig = 'v0=' + createHmac('sha256', signing_secret).update(base).digest('base64');
    expect(() => verifySlackSignature({ signing_secret, timestamp: ts, signature: sig, body, now: 1_700_000_999 })).toThrow(ConnectorError);
  });

  it('rejects a tampered body', () => {
    const sig = 'v0=' + createHmac('sha256', signing_secret).update(base).digest('base64');
    expect(() => verifySlackSignature({ signing_secret, timestamp: ts, signature: sig, body: body + '!', now: 1_700_000_000 })).toThrow(ConnectorError);
  });
});

describe('verifyTelegramSecretToken', () => {
  it('accepts a matching secret', () => {
    expect(() => verifyTelegramSecretToken({ expected: 'token', header: 'token' })).not.toThrow();
  });
  it('rejects a mismatching secret', () => {
    expect(() => verifyTelegramSecretToken({ expected: 'token', header: 'other' })).toThrow(ConnectorError);
  });
  it('rejects a missing header', () => {
    expect(() => verifyTelegramSecretToken({ expected: 'token', header: null })).toThrow(ConnectorError);
  });
});

describe('verifyGraphClientState', () => {
  it('accepts a matching client state', () => {
    expect(() => verifyGraphClientState({ expected: 'cs', actual: 'cs' })).not.toThrow();
  });
  it('rejects a mismatching client state', () => {
    expect(() => verifyGraphClientState({ expected: 'cs', actual: 'other' })).toThrow(ConnectorError);
  });
  it('rejects a missing client state', () => {
    expect(() => verifyGraphClientState({ expected: 'cs', actual: null })).toThrow(ConnectorError);
  });
});

describe('verifyGoogleOidcBearer', () => {
  const payload = { aud: 'https://fagaos/push', sub: 'service-account@test.iam.gserviceaccount.com' };
  const b64 = (o: object) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const jwt = `header.${b64(payload)}.signature`;

  it('accepts a well-formed bearer with a matching audience', async () => {
    await expect(verifyGoogleOidcBearer({ bearer: `Bearer ${jwt}`, expected_audience: 'https://fagaos/push' })).resolves.toBeUndefined();
  });
  it('rejects a bearer with a mismatched audience', async () => {
    await expect(verifyGoogleOidcBearer({ bearer: `Bearer ${jwt}`, expected_audience: 'other' })).rejects.toBeInstanceOf(ConnectorError);
  });
  it('rejects a missing bearer', async () => {
    await expect(verifyGoogleOidcBearer({ bearer: null, expected_audience: 'x' })).rejects.toBeInstanceOf(ConnectorError);
  });
  it('rejects a JWS with the wrong shape', async () => {
    await expect(verifyGoogleOidcBearer({ bearer: 'Bearer not-a-jwt', expected_audience: 'x' })).rejects.toBeInstanceOf(ConnectorError);
  });
});
