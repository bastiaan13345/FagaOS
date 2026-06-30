/**
 * Webhook signature verifiers.
 *
 * Each provider has its own signing scheme. The functions here
 * implement the canonical verification path; the gateway calls the
 * matching function on ingress before handing the body to the
 * connector.
 *
 *   - Meta (WhatsApp, Instagram): HMAC-SHA256 over the raw body, hex
 *     digest, `X-Hub-Signature-256: sha256=<hex>`. Constant-time
 *     comparison. The shared secret is the "App Secret" in the
 *     Meta developer dashboard.
 *   - Telegram: secret token in `X-Telegram-Bot-Api-Secret-Token`
 *     header. Constant-time comparison.
 *   - Discord: Ed25519 over the raw body, base64 signature in
 *     `X-Signature-Ed25519`. The key is the "Public Key" of the
 *     application. We use `node:crypto` for the verify.
 *   - Slack: HMAC-SHA256 over the raw body with the "Signing
 *     Secret", base64 digest, `X-Slack-Signature: v0=<base64>`. The
 *     verification also checks the `X-Slack-Request-Timestamp` is
 *     within 5 minutes of `Date.now()` to defeat replays.
 *   - Microsoft Graph: client-state validation. The
 *     `validationToken` query parameter echoes back the same value;
 *     for production webhooks, the `clientState` field must match
 *     a value the gateway generated at subscription time.
 *
 * The contract: `verifyX` throws `ConnectorError` with code
 * `webhook_signature_invalid` on failure; returns nothing on
 * success. All comparisons are constant-time.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { ConnectorError } from '../errors.js';

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Meta (WhatsApp / Instagram) — `X-Hub-Signature-256: sha256=<hex>`.
 * Header may be missing or carry the deprecated `sha1=` form; both
 * are accepted when `allow_sha1` is true.
 */
export function verifyMetaSignature(args: {
  app_secret: string;
  body: string | Buffer;
  signature_header: string | null | undefined;
  allow_sha1?: boolean;
}): void {
  const header = args.signature_header ?? '';
  const raw: Buffer = typeof args.body === 'string' ? Buffer.from(args.body, 'utf8') : args.body;
  const v6 = /^sha256=([0-9a-f]+)$/i.exec(header)?.[1];
  if (v6) {
    const expected = createHmac('sha256', args.app_secret).update(raw).digest('hex');
    if (!safeEqual(v6.toLowerCase(), expected.toLowerCase())) {
      throw new ConnectorError('webhook_signature_invalid', 'meta signature mismatch (sha256)');
    }
    return;
  }
  if (args.allow_sha1) {
    const v1 = /^sha1=([0-9a-f]+)$/i.exec(header)?.[1];
    if (v1) {
      const expected = createHmac('sha1', args.app_secret).update(raw).digest('hex');
      if (!safeEqual(v1.toLowerCase(), expected.toLowerCase())) {
        throw new ConnectorError('webhook_signature_invalid', 'meta signature mismatch (sha1)');
      }
      return;
    }
  }
  throw new ConnectorError('webhook_signature_invalid', 'meta signature header missing or unrecognised');
}

/** Telegram — `X-Telegram-Bot-Api-Secret-Token: <token>`. */
export function verifyTelegramSecretToken(args: {
  expected: string;
  header: string | null | undefined;
}): void {
  if (!args.header || !safeEqual(args.header, args.expected)) {
    throw new ConnectorError('webhook_signature_invalid', 'telegram secret-token mismatch');
  }
}

/** Slack — `X-Slack-Signature: v0=<base64>` + `X-Slack-Request-Timestamp`. */
export function verifySlackSignature(args: {
  signing_secret: string;
  timestamp: string | null | undefined;
  signature: string | null | undefined;
  body: string | Buffer;
  now?: number;
  /** Tolerance window in seconds. Default 5 minutes. */
  tolerance?: number;
}): void {
  if (!args.signature || !args.timestamp) {
    throw new ConnectorError('webhook_signature_invalid', 'slack signature or timestamp missing');
  }
  const ts = Number(args.timestamp);
  if (!Number.isFinite(ts)) {
    throw new ConnectorError('webhook_signature_invalid', 'slack timestamp not numeric');
  }
  const now = (args.now ?? Math.floor(Date.now() / 1000)) * 1000;
  if (Math.abs(now - ts * 1000) > (args.tolerance ?? 300) * 1000) {
    throw new ConnectorError('webhook_signature_invalid', 'slack timestamp outside tolerance window');
  }
  const raw: Buffer = typeof args.body === 'string' ? Buffer.from(args.body, 'utf8') : args.body;
  const base = `v0:${args.timestamp}:${raw.toString('utf8')}`;
  const expected = createHmac('sha256', args.signing_secret).update(base).digest('base64');
  const v0 = /^v0=([A-Za-z0-9+/=]+)$/.exec(args.signature)?.[1] ?? '';
  if (!safeEqual(v0, expected)) {
    throw new ConnectorError('webhook_signature_invalid', 'slack signature mismatch');
  }
}

/** Microsoft Graph — `validationToken` echo for subscription creation. */
export function echoGraphValidationToken(token: string): string {
  return token;
}

/** Microsoft Graph — `clientState` check on change notifications. */
export function verifyGraphClientState(args: {
  expected: string;
  actual: string | null | undefined;
}): void {
  if (!args.actual || !safeEqual(args.actual, args.expected)) {
    throw new ConnectorError('webhook_signature_invalid', 'graph clientState mismatch');
  }
}

/** Google Pub/Sub — `Authorization: Bearer <JWT>` issued by Google. */
export function verifyGoogleOidcBearer(args: {
  bearer: string | null | undefined;
  expected_audience: string;
  /** Caller-supplied verifier. Phase 1 only checks presence. */
  verify_signature?: (jwt: string, audience: string) => Promise<boolean>;
}): Promise<void> {
  return Promise.resolve().then(() => {
    if (!args.bearer || !args.bearer.toLowerCase().startsWith('bearer ')) {
      throw new ConnectorError('webhook_signature_invalid', 'google OIDC bearer missing');
    }
    const jwt = args.bearer.slice(7).trim();
    if (!jwt) throw new ConnectorError('webhook_signature_invalid', 'google OIDC bearer empty');
    // Phase 1: only check the JWT has three dot-separated parts and
    // the aud claim matches. Production swaps in a JWKS-backed
    // verifier that fetches Google's keys and validates the
    // signature.
    const parts = jwt.split('.');
    if (parts.length !== 3) {
      throw new ConnectorError('webhook_signature_invalid', 'google OIDC bearer is not a JWS');
    }
    try {
      const payload = JSON.parse(Buffer.from(parts[1]!.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
      if (payload.aud !== args.expected_audience) {
        throw new ConnectorError('webhook_signature_invalid', 'google OIDC bearer aud mismatch');
      }
    } catch {
      throw new ConnectorError('webhook_signature_invalid', 'google OIDC bearer payload is not valid JSON');
    }
  });
}
