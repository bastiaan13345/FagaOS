/**
 * Normalized model tests.
 *
 * Each schema round-trips a valid input. The tests also probe the
 * validator for the cases the gateway relies on (rejects bad input,
 * applies defaults, does not silently drop fields).
 */
import { describe, it, expect } from 'vitest';
import {
  AccountSchema,
  AttachmentSchema,
  CalendarSchema,
  ContactSchema,
  ConversationSchema,
  EventSchema,
  MessageSchema,
  ProviderRefSchema,
  ProviderSchema,
} from '../src/index.js';

describe('ProviderSchema', () => {
  it('accepts the documented providers', () => {
    for (const p of ['gmail', 'outlook', 'imap', 'icloud', 'whatsapp', 'instagram', 'telegram', 'discord', 'slack', 'google_calendar', 'outlook_calendar', 'caldav']) {
      expect(ProviderSchema.parse(p)).toBe(p);
    }
  });

  it('rejects unknown providers', () => {
    expect(() => ProviderSchema.parse('facebook')).toThrow();
  });
});

describe('ContactSchema', () => {
  it('accepts a minimal contact', () => {
    const c = ContactSchema.parse({ address: 'a@example.com' });
    expect(c.address).toBe('a@example.com');
    expect(c.name).toBeUndefined();
  });

  it('accepts a contact with a name', () => {
    const c = ContactSchema.parse({ address: 'a@example.com', name: 'Alice' });
    expect(c.name).toBe('Alice');
  });

  it('rejects an empty address', () => {
    expect(() => ContactSchema.parse({ address: '' })).toThrow();
  });
});

describe('ProviderRefSchema', () => {
  it('round-trips a minimal ref', () => {
    const r = ProviderRefSchema.parse({ provider: 'gmail', native_id: 'abc' });
    expect(r).toEqual({ provider: 'gmail', native_id: 'abc' });
  });

  it('rejects a ref without provider', () => {
    expect(() => ProviderRefSchema.parse({ native_id: 'abc' })).toThrow();
  });
});

describe('AttachmentSchema', () => {
  it('defaults disposition to attachment', () => {
    const a = AttachmentSchema.parse({
      id: '1',
      filename: 'a.txt',
      mime_type: 'text/plain',
      size_bytes: 12,
    });
    expect(a.disposition).toBe('attachment');
  });

  it('accepts a sha256 content hash', () => {
    const a = AttachmentSchema.parse({
      id: '1',
      filename: 'a.txt',
      mime_type: 'text/plain',
      size_bytes: 12,
      content_hash: 'a'.repeat(64),
    });
    expect(a.content_hash).toBe('a'.repeat(64));
  });

  it('rejects a malformed content hash', () => {
    expect(() =>
      AttachmentSchema.parse({
        id: '1',
        filename: 'a.txt',
        mime_type: 'text/plain',
        size_bytes: 12,
        content_hash: 'not-hex',
      }),
    ).toThrow();
  });
});

describe('AccountSchema', () => {
  it('defaults empty scopes and capabilities', () => {
    const a = AccountSchema.parse({
      id: 'a1',
      user_id: 'u1',
      provider: 'gmail',
      handle: 'j***@gmail.com',
      status: 'active',
      created_at: '2025-01-01T00:00:00.000Z',
      updated_at: '2025-01-01T00:00:00.000Z',
    });
    expect(a.scopes).toEqual([]);
    expect(a.capabilities).toEqual([]);
  });

  it('rejects a missing status', () => {
    expect(() =>
      AccountSchema.parse({
        id: 'a1',
        user_id: 'u1',
        provider: 'gmail',
        handle: 'j***@gmail.com',
        created_at: '2025-01-01T00:00:00.000Z',
        updated_at: '2025-01-01T00:00:00.000Z',
      }),
    ).toThrow();
  });
});

describe('MessageSchema', () => {
  const baseMessage = {
    id: 'm1',
    account_id: 'a1',
    thread_id: 't1',
    direction: 'in',
    from: { address: 'a@example.com' },
    to: [{ address: 'me@example.com' }],
    preview: 'preview',
    body_text: 'body',
    status_flags: { read: true },
    received_at: '2025-01-01T00:00:00.000Z',
    provider_ref: { provider: 'gmail', native_id: 'm1' },
  };

  it('round-trips a minimal message', () => {
    const m = MessageSchema.parse(baseMessage);
    expect(m.attachments).toEqual([]);
    expect(m.labels).toEqual([]);
    expect(m.cc).toEqual([]);
  });

  it('rejects an empty to[]', () => {
    expect(() => MessageSchema.parse({ ...baseMessage, to: [] })).toThrow();
  });

  it('rejects a preview over 280 chars', () => {
    expect(() =>
      MessageSchema.parse({ ...baseMessage, preview: 'x'.repeat(281) }),
    ).toThrow();
  });
});

describe('ConversationSchema', () => {
  it('round-trips a minimal conversation', () => {
    const c = ConversationSchema.parse({
      id: 'c1',
      account_id: 'a1',
      channel: 'whatsapp',
      participants: [{ address: 'a@example.com' }],
      last_message_at: '2025-01-01T00:00:00.000Z',
      unread_count: 0,
      provider_ref: { provider: 'whatsapp', native_id: 'c1' },
    });
    expect(c.unread_count).toBe(0);
  });

  it('rejects negative unread_count', () => {
    expect(() =>
      ConversationSchema.parse({
        id: 'c1',
        account_id: 'a1',
        channel: 'whatsapp',
        participants: [{ address: 'a@example.com' }],
        last_message_at: '2025-01-01T00:00:00.000Z',
        unread_count: -1,
        provider_ref: { provider: 'whatsapp', native_id: 'c1' },
      }),
    ).toThrow();
  });
});

describe('CalendarSchema', () => {
  it('defaults primary and read_only', () => {
    const c = CalendarSchema.parse({
      id: 'cal1',
      account_id: 'a1',
      name: 'Personal',
      provider_ref: { provider: 'google_calendar', native_id: 'cal1' },
    });
    expect(c.primary).toBe(false);
    expect(c.read_only).toBe(false);
  });

  it('rejects a malformed hex color', () => {
    expect(() =>
      CalendarSchema.parse({
        id: 'cal1',
        account_id: 'a1',
        name: 'Personal',
        color: 'red',
        provider_ref: { provider: 'google_calendar', native_id: 'cal1' },
      }),
    ).toThrow();
  });
});

describe('EventSchema', () => {
  const baseEvent = {
    id: 'e1',
    account_id: 'a1',
    calendar_id: 'cal1',
    title: 'Stand-up',
    start: { tz: 'UTC', at: '2025-01-01T10:00:00.000Z' },
    end: { tz: 'UTC', at: '2025-01-01T10:30:00.000Z' },
    all_day: false,
    status: 'confirmed',
    provider_ref: { provider: 'google_calendar', native_id: 'e1' },
  };

  it('round-trips a minimal event', () => {
    const e = EventSchema.parse(baseEvent);
    expect(e.attendees).toEqual([]);
  });

  it('accepts an attendee with optional=false', () => {
    const e = EventSchema.parse({
      ...baseEvent,
      attendees: [
        { contact: { address: 'a@example.com' }, status: 'accepted', optional: false },
      ],
    });
    expect(e.attendees[0]?.status).toBe('accepted');
  });

  it('rejects an unknown status', () => {
    expect(() =>
      EventSchema.parse({ ...baseEvent, status: 'mystery' }),
    ).toThrow();
  });
});
