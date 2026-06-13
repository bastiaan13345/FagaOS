/**
 * Webhook ingress tests.
 *
 * The webhook layer routes Pub/Sub envelopes to the matching
 * connector. The test covers happy path and shape rejection for both
 * Gmail and Google Calendar.
 */
import { describe, it, expect } from 'vitest';
import {
  GmailConnector,
  GoogleCalendarConnector,
  processWebhook,
  verifyIncomingRequest,
  defaultAuthVerifier,
  type GoogleTokenProvider,
} from '../src/index.js';
import { ConnectorError } from '../src/index.js';

const tokens: GoogleTokenProvider = { accessToken: async () => 't' };

describe('processWebhook — gmail', () => {
  it('decodes a valid history notification', () => {
    const gmail = new GmailConnector({ tokens });
    const gcal = new GoogleCalendarConnector({ tokens });
    const data = Buffer.from(JSON.stringify({ emailAddress: 'me@x.com', historyId: '42' })).toString('base64');
    const out = processWebhook(
      { gmail, google_calendar: gcal },
      { source: 'gmail', body: { message: { data, messageId: 'm' }, subscription: 'sub' } },
    );
    expect(out?.kind).toBe('gmail.history');
  });

  it('rejects a malformed notification', () => {
    const gmail = new GmailConnector({ tokens });
    const gcal = new GoogleCalendarConnector({ tokens });
    expect(() =>
      processWebhook(
        { gmail, google_calendar: gcal },
        { source: 'gmail', body: { message: { data: 'garbage', messageId: 'm' }, subscription: 'sub' } },
      ),
    ).toThrow(ConnectorError);
  });
});

describe('processWebhook — calendar', () => {
  it('decodes a valid events.watch notification', () => {
    const gmail = new GmailConnector({ tokens });
    const gcal = new GoogleCalendarConnector({ tokens });
    const data = Buffer.from(JSON.stringify({ channel_id: 'c', resource_id: 'r' })).toString('base64');
    const out = processWebhook(
      { gmail, google_calendar: gcal },
      { source: 'google_calendar', body: { message: { data } } },
    );
    expect(out?.kind).toBe('calendar.change');
  });

  it('returns null for an unknown source', () => {
    const gmail = new GmailConnector({ tokens });
    const gcal = new GoogleCalendarConnector({ tokens });
    const out = processWebhook(
      { gmail, google_calendar: gcal },
      { source: 'whatsapp' as never, body: {} },
    );
    expect(out).toBeNull();
  });
});

describe('verifyIncomingRequest', () => {
  it('passes with the default verifier', async () => {
    await expect(verifyIncomingRequest(defaultAuthVerifier, { authorization: 'Bearer x' })).resolves.toBeUndefined();
  });

  it('throws when the verifier returns false', async () => {
    await expect(
      verifyIncomingRequest(async () => false, { authorization: 'Bearer x' }),
    ).rejects.toMatchObject({ code: 'webhook_signature_invalid' });
  });
});
