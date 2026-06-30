/**
 * Tests for the new messaging connectors.
 *
 * The connectors here are wire-format adapters; the tests assert:
 *   - The 4xx/5xx status mapping to `ConnectorError` codes.
 *   - The 24h CSW window is computed correctly from a webhook entry.
 *   - The send path builds the correct request body.
 */
import { describe, it, expect } from 'vitest';
import { WhatsAppConnector } from '../src/connectors/whatsapp/index.js';
import { InstagramConnector } from '../src/connectors/instagram/index.js';
import { TelegramConnector } from '../src/connectors/telegram/index.js';
import { DiscordConnector } from '../src/connectors/discord/index.js';
import { SlackConnector } from '../src/connectors/slack/index.js';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('WhatsAppConnector', () => {
  it('listConversations returns an empty list (no native endpoint)', async () => {
    const c = new WhatsAppConnector({ tokens: { accessToken: async () => 'at' }, phone_number_id: 'pn1' });
    const out = await c.listConversations({ account: { id: 'a', user_id: 'u', provider: 'whatsapp', handle: 'me', scopes: [], capabilities: [], status: 'active', created_at: '', updated_at: '' }, operation: 'dm.conversations.list', args: {}, token: { subject: 't', capabilities: [], expires_at: '' }, idempotency_key: 'k', trace_id: 't' } as never, noopAudit());
    expect(out.conversations).toEqual([]);
  });

  it('sendDm posts a text message', async () => {
    let captured: { url: string; body: string } | null = null;
    const c = new WhatsAppConnector({
      tokens: { accessToken: async () => 'at' },
      phone_number_id: 'pn1',
      fetchImpl: async (url, init) => {
        captured = { url, body: typeof init.body === 'string' ? init.body : '' };
        return jsonResponse(200, { messages: [{ id: 'wamid.1' }] });
      },
    });
    const out = await c.sendDm({
      account: { id: 'a', user_id: 'u', provider: 'whatsapp', handle: '+1', scopes: [], capabilities: [], status: 'active', created_at: '', updated_at: '' },
      operation: 'dm.send',
      args: { conversation_id: '+15558675309', body: 'hi' },
      token: { subject: 't', capabilities: [], expires_at: '' },
      idempotency_key: 'k',
      trace_id: 't',
    }, noopAudit());
    expect(out.provider_message_id).toBe('wamid.1');
    expect(captured!.url).toContain('/pn1/messages');
    const body = JSON.parse(captured!.body);
    expect(body.to).toBe('+15558675309');
    expect(body.text.body).toBe('hi');
  });

  it('sendDm surfaces 4xx as provider_error', async () => {
    const c = new WhatsAppConnector({
      tokens: { accessToken: async () => 'at' },
      phone_number_id: 'pn1',
      fetchImpl: async () => jsonResponse(400, { error: { message: 'bad' } }),
    });
    await expect(c.sendDm({
      account: { id: 'a', user_id: 'u', provider: 'whatsapp', handle: '+1', scopes: [], capabilities: [], status: 'active', created_at: '', updated_at: '' },
      operation: 'dm.send', args: { conversation_id: '+1', body: 'hi' },
      token: { subject: 't', capabilities: [], expires_at: '' }, idempotency_key: 'k', trace_id: 't',
    }, noopAudit())).rejects.toMatchObject({ code: 'provider_error' });
  });

  it('conversationFromWebhook sets window_open_until to +24h', () => {
    const c = new WhatsAppConnector({ tokens: { accessToken: async () => 'at' }, phone_number_id: 'pn1' });
    const entry = {
      id: 'wh-1',
      changes: [{ field: 'messages', value: {
        messaging_product: 'whatsapp' as const,
        metadata: { phone_number_id: 'pn1' },
        contacts: [{ wa_id: '+15558675309', profile: { name: 'Alice' } }],
        messages: [{ from: '+15558675309', id: 'm1', timestamp: '1700000000', type: 'text', text: { body: 'hi' } }],
      } }],
    };
    const conv = c.conversationFromWebhook('a1', entry);
    expect(conv).not.toBeNull();
    expect(conv!.channel).toBe('whatsapp');
    expect(conv!.window_open_until).toBe(new Date(1700000000_000 + 24 * 60 * 60 * 1000).toISOString());
  });
});

describe('InstagramConnector', () => {
  it('sendDm posts a text message', async () => {
    let captured: { url: string; body: string } | null = null;
    const c = new InstagramConnector({
      tokens: { accessToken: async () => 'at' },
      page_id: 'pg',
      fetchImpl: async (url, init) => {
        captured = { url, body: typeof init.body === 'string' ? init.body : '' };
        return jsonResponse(200, { message_id: 'ig.1' });
      },
    });
    const out = await c.sendDm({
      account: { id: 'a', user_id: 'u', provider: 'instagram', handle: 'me', scopes: [], capabilities: [], status: 'active', created_at: '', updated_at: '' },
      operation: 'dm.send', args: { conversation_id: 'ig-sender-id', body: 'hi' },
      token: { subject: 't', capabilities: [], expires_at: '' }, idempotency_key: 'k', trace_id: 't',
    }, noopAudit());
    expect(out.provider_message_id).toBe('ig.1');
    expect(captured!.url).toContain('/pg/messages');
  });
});

describe('TelegramConnector', () => {
  it('sendDm hits sendMessage with chat_id', async () => {
    let captured: { url: string; body: string } | null = null;
    const c = new TelegramConnector({
      tokens: { accessToken: async () => 'TOKEN' },
      fetchImpl: async (url, init) => {
        captured = { url, body: typeof init.body === 'string' ? init.body : '' };
        return jsonResponse(200, { ok: true, result: { message_id: 42 } });
      },
    });
    const out = await c.sendDm({
      account: { id: 'a', user_id: 'u', provider: 'telegram', handle: 'me', scopes: [], capabilities: [], status: 'active', created_at: '', updated_at: '' },
      operation: 'dm.send', args: { conversation_id: '12345', body: 'hi' },
      token: { subject: 't', capabilities: [], expires_at: '' }, idempotency_key: 'k', trace_id: 't',
    }, noopAudit());
    expect(out.provider_message_id).toMatch(/^telegram-42-/);
    expect(captured!.url).toContain('/botTOKEN/sendMessage');
    expect(JSON.parse(captured!.body).chat_id).toBe('12345');
  });

  it('rate-limit mapping: 429 -> rate_limited', async () => {
    const c = new TelegramConnector({
      tokens: { accessToken: async () => 'TOKEN' },
      fetchImpl: async () => new Response('throttled', { status: 429, headers: { 'retry-after': '1' } }),
    });
    await expect(c.sendDm({
      account: { id: 'a', user_id: 'u', provider: 'telegram', handle: 'me', scopes: [], capabilities: [], status: 'active', created_at: '', updated_at: '' },
      operation: 'dm.send', args: { conversation_id: '1', body: 'hi' },
      token: { subject: 't', capabilities: [], expires_at: '' }, idempotency_key: 'k', trace_id: 't',
    }, noopAudit())).rejects.toMatchObject({ code: 'rate_limited' });
  });
});

describe('DiscordConnector', () => {
  it('sendDm posts to /channels/{id}/messages', async () => {
    let captured: { url: string; body: string } | null = null;
    const c = new DiscordConnector({
      tokens: { accessToken: async () => 'TOKEN' },
      fetchImpl: async (url, init) => {
        captured = { url, body: typeof init.body === 'string' ? init.body : '' };
        return jsonResponse(200, { id: 'm1' });
      },
    });
    const out = await c.sendDm({
      account: { id: 'a', user_id: 'u', provider: 'discord', handle: 'me', scopes: [], capabilities: [], status: 'active', created_at: '', updated_at: '' },
      operation: 'dm.send', args: { conversation_id: 'chan-1', body: 'hi' },
      token: { subject: 't', capabilities: [], expires_at: '' }, idempotency_key: 'k', trace_id: 't',
    }, noopAudit());
    expect(out.provider_message_id).toMatch(/^m1-/);
    expect(captured!.url).toContain('/channels/chan-1/messages');
  });
});

describe('SlackConnector', () => {
  it('sendDm calls chat.postMessage', async () => {
    let captured: { url: string; body: string } | null = null;
    const c = new SlackConnector({
      tokens: { accessToken: async () => 'xoxb-TOKEN' },
      fetchImpl: async (url, init) => {
        captured = { url, body: typeof init.body === 'string' ? init.body : '' };
        return jsonResponse(200, { ok: true, ts: '1700000000.000100', channel: 'C1' });
      },
    });
    const out = await c.sendDm({
      account: { id: 'a', user_id: 'u', provider: 'slack', handle: 'me', scopes: [], capabilities: [], status: 'active', created_at: '', updated_at: '' },
      operation: 'dm.send', args: { conversation_id: 'C1', body: 'hi' },
      token: { subject: 't', capabilities: [], expires_at: '' }, idempotency_key: 'k', trace_id: 't',
    }, noopAudit());
    expect(out.provider_message_id).toMatch(/^C1:1700000000.000100:/);
    expect(captured!.url).toContain('/chat.postMessage');
  });

  it('Slack ok=false is mapped to provider_error', async () => {
    const c = new SlackConnector({
      tokens: { accessToken: async () => 'xoxb-TOKEN' },
      fetchImpl: async () => new Response(JSON.stringify({ ok: false, error: 'channel_not_found' }), { status: 200, headers: { 'content-type': 'application/json' } }),
    });
    await expect(c.sendDm({
      account: { id: 'a', user_id: 'u', provider: 'slack', handle: 'me', scopes: [], capabilities: [], status: 'active', created_at: '', updated_at: '' },
      operation: 'dm.send', args: { conversation_id: 'C1', body: 'hi' },
      token: { subject: 't', capabilities: [], expires_at: '' }, idempotency_key: 'k', trace_id: 't',
    }, noopAudit())).rejects.toMatchObject({ code: 'provider_error' });
  });
});

function noopAudit() {
  return {
    append: async () => undefined,
    query: async () => [],
  } as never;
}
