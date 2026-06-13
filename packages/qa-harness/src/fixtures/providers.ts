/**
 * Mock provider fixtures.
 *
 * Each fixture exposes a `payload(...)` builder that returns a
 * realistic-shaped webhook/update event for a given provider, plus a
 * matching `signature(secret, rawBody)` helper that produces a
 * signature the FakeConnectorHarness (or a real connector harness)
 * can verify. The fixtures are pure data — they do not import any
 * SDK or perform I/O.
 *
 * Goal: Phase 1 tests and demos can run end-to-end against these
 * fixtures without ever talking to a real provider.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { WebhookFixture } from './types.js';

// Re-export type-only from the central types file.
export type { WebhookFixture } from './types.js';

/**
 * Gmail Pub/Sub push notification shape.
 * https://cloud.google.com/pubsub/docs/push
 */
export interface GmailPushFixture {
  provider: 'gmail';
  emailAddress: string;
  historyId: number;
  rawBody: string;
  headers: Record<string, string>;
  parsed: { emailAddress: string; historyId: number };
}

export function gmailPushNotification(opts: { emailAddress?: string; historyId?: number } = {}): GmailPushFixture {
  const emailAddress = opts.emailAddress ?? '[email protected]';
  const historyId = opts.historyId ?? Math.floor(Date.now() / 1000);
  const data = { emailAddress, historyId };
  const message = {
    data: Buffer.from(JSON.stringify(data), 'utf8').toString('base64'),
    messageId: `gmail-push-${historyId}`,
    publishTime: new Date().toISOString(),
  };
  const rawBody = JSON.stringify({ message, subscription: 'projects/fagaos/subscriptions/gmail' });
  return {
    provider: 'gmail',
    emailAddress,
    historyId,
    rawBody,
    headers: { 'content-type': 'application/json' },
    parsed: data,
  };
}

/**
 * Microsoft Graph change notification (subscription webhook).
 * https://learn.microsoft.com/en-us/graph/webhooks
 */
export interface GraphPushFixture {
  provider: 'graph';
  subscriptionId: string;
  resource: string;
  changeType: string;
  rawBody: string;
  headers: Record<string, string>;
  parsed: { value: Array<{ subscriptionId: string; resource: string; changeType: string; clientState: string }> };
}

export function graphChangeNotification(opts: {
  subscriptionId?: string;
  resource?: string;
  changeType?: string;
} = {}): GraphPushFixture {
  const subscriptionId = opts.subscriptionId ?? 'graph-sub-001';
  const resource = opts.resource ?? `users/[email protected]/mailFolders('Inbox')/messages`;
  const changeType = opts.changeType ?? 'created';
  const parsed = {
    value: [{ subscriptionId, resource, changeType, clientState: 'fagaos-graph-client-state' }],
  };
  const rawBody = JSON.stringify(parsed);
  return {
    provider: 'graph',
    subscriptionId,
    resource,
    changeType,
    rawBody,
    headers: { 'content-type': 'application/json' },
    parsed,
  };
}

/**
 * Meta (Facebook/WhatsApp) webhook entry.
 * https://developers.facebook.com/docs/graph-api/webhooks
 */
export interface MetaWebhookFixture {
  provider: 'meta';
  object: 'page' | 'instagram' | 'whatsapp_business_account';
  entry: Array<{ id: string; time: number; messaging?: unknown[] }>;
  rawBody: string;
  headers: Record<string, string>;
  parsed: { object: string; entry: Array<{ id: string; time: number; messaging?: unknown[] }> };
}

export function metaPageWebhook(opts: { pageId?: string; message?: string } = {}): MetaWebhookFixture {
  const pageId = opts.pageId ?? '1234567890';
  const entry = [{ id: pageId, time: Math.floor(Date.now() / 1000), messaging: [{ sender: { id: 'user-1' }, recipient: { id: pageId }, message: { text: opts.message ?? 'hi' } }] }];
  const parsed = { object: 'page' as const, entry };
  const rawBody = JSON.stringify(parsed);
  return {
    provider: 'meta',
    object: 'page',
    entry,
    rawBody,
    headers: { 'content-type': 'application/json' },
    parsed,
  };
}

/**
 * Telegram Bot API Update.
 * https://core.telegram.org/bots/api#update
 */
export interface TelegramUpdateFixture {
  provider: 'telegram';
  updateId: number;
  message?: { messageId: number; from: { id: number }; chat: { id: number }; text: string };
  rawBody: string;
  headers: Record<string, string>;
  parsed: { update_id: number; message?: { message_id: number; from: { id: number }; chat: { id: number }; text: string } };
}

export function telegramUpdate(opts: {
  updateId?: number;
  chatId?: number;
  text?: string;
  secretTokenHeader?: string;
} = {}): TelegramUpdateFixture & { secretTokenHeader?: string } {
  const updateId = opts.updateId ?? Math.floor(Math.random() * 1e9);
  const chatId = opts.chatId ?? 1001;
  const text = opts.text ?? 'hello';
  const message = { message_id: updateId, from: { id: 42 }, chat: { id: chatId }, date: Math.floor(Date.now() / 1000), text };
  const parsed = { update_id: updateId, message };
  const rawBody = JSON.stringify(parsed);
  const out: TelegramUpdateFixture & { secretTokenHeader?: string } = {
    provider: 'telegram',
    updateId,
    message: { messageId: updateId, from: { id: 42 }, chat: { id: chatId }, text },
    rawBody,
    headers: { 'content-type': 'application/json' },
    parsed,
  };
  if (opts.secretTokenHeader !== undefined) out.secretTokenHeader = opts.secretTokenHeader;
  return out;
}

/**
 * Discord Gateway event. Real Discord uses a WebSocket; for offline
 * tests we expose a synthetic dispatch payload of the same shape.
 * https://discord.com/developers/docs/topics/gateway#dispatch
 */
export interface DiscordGatewayFixture {
  provider: 'discord';
  op: 0;
  t: string;
  d: Record<string, unknown>;
  rawBody: string;
  headers: Record<string, string>;
  parsed: { op: 0; t: string; s: number; d: Record<string, unknown> };
}

export function discordMessageCreate(opts: {
  channelId?: string;
  authorId?: string;
  content?: string;
} = {}): DiscordGatewayFixture {
  const channelId = opts.channelId ?? '111111111111111111';
  const authorId = opts.authorId ?? '222222222222222222';
  const content = opts.content ?? 'hello from discord mock';
  const d = {
    id: '333333333333333333',
    channel_id: channelId,
    author: { id: authorId, username: 'mock-user', bot: false },
    content,
    timestamp: new Date().toISOString(),
  };
  const parsed = { op: 0 as const, t: 'MESSAGE_CREATE', s: 1, d };
  const rawBody = JSON.stringify(parsed);
  return {
    provider: 'discord',
    op: 0,
    t: 'MESSAGE_CREATE',
    d,
    rawBody,
    headers: { 'content-type': 'application/json' },
    parsed,
  };
}

/**
 * Sign a raw body with HMAC-SHA-256 using the given secret. Returns
 * a `sha256=...` hex digest suitable for the standard `X-Signature`
 * header. The provider helpers above all produce raw bodies that
 * can be signed with this function.
 */
export function hmacSha256Signature(secret: string, rawBody: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
}

/**
 * Verify a signature under HMAC-SHA-256 with timing-safe compare.
 * Returns true iff the signature is well-formed and matches.
 */
export function verifyHmacSha256Signature(secret: string, rawBody: string, signature: string): boolean {
  const expected = hmacSha256Signature(secret, rawBody);
  if (expected.length !== signature.length) return false;
  // Note: timingSafeEqual only throws RangeError when the buffers
  // differ in length, which the guard above already prevents. The
  // equality comparison returns false on mismatch (which is the only
  // other outcome for valid equal-length buffer inputs), so a
  // try/catch is not needed here.
  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

/** Convenience: build a fixture and its matching signature in one call. */
export function signed<T extends { rawBody: string }>(fixture: T, secret: string): T & { signature: string } {
  return { ...fixture, signature: hmacSha256Signature(secret, fixture.rawBody) };
}

/** Build a WebhookFixture-shaped wrapper for ad-hoc payloads. */
export function asWebhookFixture(provider: WebhookFixture['provider'], rawBody: string): WebhookFixture {
  return {
    provider,
    rawBody,
    headers: { 'content-type': 'application/json' },
    parsed: (() => {
      try {
        return JSON.parse(rawBody);
      } catch {
        return null;
      }
    })(),
  };
}
