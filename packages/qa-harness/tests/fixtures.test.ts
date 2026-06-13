/**
 * Tests for the provider fixture helpers.
 */

import { describe, expect, it } from 'vitest';
import {
  gmailPushNotification,
  graphChangeNotification,
  metaPageWebhook,
  telegramUpdate,
  discordMessageCreate,
  hmacSha256Signature,
  verifyHmacSha256Signature,
  signed,
  asWebhookFixture,
} from '../src/fixtures/index.js';

describe('provider fixtures', () => {
  it('gmailPushNotification emits a Pub/Sub-shaped body', () => {
    const f = gmailPushNotification({ emailAddress: '[email protected]', historyId: 42 });
    expect(f.provider).toBe('gmail');
    expect(f.emailAddress).toBe('[email protected]');
    expect(f.historyId).toBe(42);
    const parsed = JSON.parse(f.rawBody) as { message: { data: string } };
    const decoded = JSON.parse(Buffer.from(parsed.message.data, 'base64').toString('utf8')) as { emailAddress: string; historyId: number };
    expect(decoded.emailAddress).toBe('[email protected]');
    expect(decoded.historyId).toBe(42);
  });

  it('graphChangeNotification emits a Graph change shape', () => {
    const f = graphChangeNotification({ subscriptionId: 'sub-X', resource: 'users/foo/messages', changeType: 'updated' });
    expect(f.provider).toBe('graph');
    expect(f.parsed.value[0]?.subscriptionId).toBe('sub-X');
    expect(f.parsed.value[0]?.changeType).toBe('updated');
  });

  it('metaPageWebhook emits a Meta messaging shape', () => {
    const f = metaPageWebhook();
    expect(f.object).toBe('page');
    expect(f.entry[0]?.messaging?.[0]?.message?.text).toBe('hi');
  });

  it('metaPageWebhook accepts custom pageId and message', () => {
    const f = metaPageWebhook({ pageId: 'P1', message: 'hello from test' });
    expect(f.entry[0]?.id).toBe('P1');
    expect(f.entry[0]?.messaging?.[0]?.message?.text).toBe('hello from test');
  });

  it('telegramUpdate emits an Update shape', () => {
    const f = telegramUpdate({ updateId: 7, chatId: 100, text: 'ping' });
    expect(f.provider).toBe('telegram');
    expect(f.updateId).toBe(7);
    expect(f.message?.text).toBe('ping');
    expect(f.parsed.update_id).toBe(7);
  });

  it('discordMessageCreate emits a Gateway dispatch shape', () => {
    const f = discordMessageCreate({ channelId: '1', authorId: '2', content: 'hi' });
    expect(f.provider).toBe('discord');
    expect(f.t).toBe('MESSAGE_CREATE');
    expect(f.op).toBe(0);
    expect(f.d).toMatchObject({ channel_id: '1', author: { id: '2' }, content: 'hi' });
  });

  it('hmacSha256Signature + verifyHmacSha256Signature round-trip', () => {
    const secret = 'super-secret';
    const body = JSON.stringify({ a: 1 });
    const sig = hmacSha256Signature(secret, body);
    expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(verifyHmacSha256Signature(secret, body, sig)).toBe(true);
    expect(verifyHmacSha256Signature(secret, body + 'x', sig)).toBe(false);
    expect(verifyHmacSha256Signature('wrong', body, sig)).toBe(false);
  });

  it('signed(...) produces a fixture with a verifiable signature', () => {
    const f = signed(gmailPushNotification(), 's3cr3t');
    expect(f.signature).toMatch(/^sha256=/);
    expect(verifyHmacSha256Signature('s3cr3t', f.rawBody, f.signature)).toBe(true);
  });

  it('asWebhookFixture parses JSON bodies safely', () => {
    const f = asWebhookFixture('discord', '{"a":1}');
    expect(f.parsed).toEqual({ a: 1 });
    const bad = asWebhookFixture('discord', '{not-json');
    expect(bad.parsed).toBeNull();
  });

  it('verifyHmacSha256Signature rejects mismatched signature length', () => {
    // Buffer.from(signature).length differs from Buffer.from(expected).length,
    // which makes timingSafeEqual throw RangeError; the helper should
    // catch and return false.
    const f = signed(gmailPushNotification(), 'topsecret');
    // Truncate the signature to force a length mismatch.
    const truncated = f.signature.slice(0, f.signature.length - 4);
    expect(verifyHmacSha256Signature('topsecret', f.rawBody, truncated)).toBe(false);
  });

  it('telegramUpdate supports a custom secretTokenHeader', () => {
    const f = telegramUpdate({ secretTokenHeader: 'X-Telegram-Bot-Api-Secret-Token' });
    expect(f.secretTokenHeader).toBe('X-Telegram-Bot-Api-Secret-Token');
    const f2 = telegramUpdate();
    expect(f2.secretTokenHeader).toBeUndefined();
  });

  it('discordMessageCreate accepts custom channelId/authorId/content', () => {
    const f = discordMessageCreate({ channelId: 'C1', authorId: 'A1', content: 'hi' });
    expect(f.d.channel_id).toBe('C1');
    expect(f.d.author.id).toBe('A1');
    expect(f.d.content).toBe('hi');
  });
});
