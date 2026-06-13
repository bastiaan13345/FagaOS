/**
 * Webhook ingress scaffold.
 *
 * Two responsibilities:
 *   1. Verify the request signature. Gmail Pub/Sub does not sign
 *      notifications but expects an OIDC `Authorization: Bearer`
 *      token issued by Google; Google Calendar's `events.watch`
 *      likewise. We expose a single `verifyIncomingRequest` that the
 *      HTTP transport calls before handing off to the connector.
 *   2. Hand the parsed body to the connector's `processXxxNotification`
 *      method. The transport does not know the per-connector shape.
 *
 * Phase 1 ships the skeleton; the HTTP wiring lands in a follow-up
 * issue. The transport-agnostic `processWebhook` is what the gateway
 * tests exercise.
 */
import { ConnectorError } from '../errors.js';
import type { GmailConnector, GmailHistory } from '../connectors/gmail/index.js';
import type { GoogleCalendarConnector } from '../connectors/google-calendar/index.js';

export interface WebhookHandlerDeps {
  gmail: GmailConnector;
  google_calendar: GoogleCalendarConnector;
}

/**
 * Map a webhook source to the connector that knows how to parse it.
 * Returns `null` when the source is not recognised so the transport
 * can return 404.
 */
export function processWebhook(
  deps: WebhookHandlerDeps,
  args: { source: 'gmail' | 'google_calendar'; body: unknown },
): { kind: 'gmail.history'; history: GmailHistory } | { kind: 'calendar.change'; channel: { channel_id: string; resource_id: string } } | null {
  if (args.source === 'gmail') {
    const history = deps.gmail.processPubSubMessage(args.body);
    return { kind: 'gmail.history', history };
  }
  if (args.source === 'google_calendar') {
    const channel = deps.google_calendar.processWatchNotification(args.body);
    return { kind: 'calendar.change', channel };
  }
  return null;
}

/**
 * Stand-in for the OIDC bearer-token check. Real implementation
 * verifies that the JWT was issued by `accounts.google.com` and the
 * `aud` matches the gateway's push endpoint. Phase 1 returns true
 * unconditionally; tests inject a custom verifier.
 */
export type WebhookAuthVerifier = (args: { authorization?: string | null }) => Promise<boolean>;

export const defaultAuthVerifier: WebhookAuthVerifier = async () => true;

/**
 * Hook for transports to call before `processWebhook`. The default
 * implementation is permissive; production swaps in an OIDC check.
 */
export async function verifyIncomingRequest(
  auth: WebhookAuthVerifier,
  headers: { authorization?: string | null },
): Promise<void> {
  const ok = await auth({ authorization: headers.authorization ?? null });
  if (!ok) {
    throw new ConnectorError('webhook_signature_invalid', 'webhook authorization failed');
  }
}
