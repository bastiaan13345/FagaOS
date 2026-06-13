/**
 * Normalized connector models — Zod schemas and inferred types.
 *
 * These are the FAG-5 normalized model the agent runtime sees for every
 * provider. The values crossing this boundary are deliberately:
 *   - credential-free (Account.handle is redacted, no tokens, no cookies)
 *   - provider-tagged via `provider_ref` for round-trips back to the source
 *   - structurally validated on the way in (Zod) and on the way out
 *
 * The schemas are the single source of truth: the TS types below are
 * `z.infer<…>` of the schemas. Do not re-declare shapes.
 *
 * See `docs/connectors.md` (in this issue) for the full field semantics.
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Provider enumeration. Order is stable because it's the public enum
// surfaced to agents. Add new providers at the end to preserve wire
// compatibility.
// ---------------------------------------------------------------------------

export const ProviderSchema = z.enum([
  'gmail',
  'outlook',
  'imap',
  'icloud',
  'whatsapp',
  'instagram',
  'telegram',
  'discord',
  'slack',
  'google_calendar',
  'outlook_calendar',
  'caldav',
]);
export type Provider = z.infer<typeof ProviderSchema>;

/** A stable reference back to a row in the source provider. */
export const ProviderRefSchema = z.object({
  provider: ProviderSchema,
  /** Native id at the source provider. Opaque to FagaOS. */
  native_id: z.string().min(1),
  /** Provider-issued ETag, used for optimistic-concurrency in `modify` calls. */
  etag: z.string().optional(),
  /** Opaque provider cursor (historyId, deltaToken, syncToken, sequence, ...). */
  cursor: z.string().optional(),
});
export type ProviderRef = z.infer<typeof ProviderRefSchema>;

// ---------------------------------------------------------------------------
// Contact — sender, recipient, attendee, participant.
// ---------------------------------------------------------------------------

export const ContactSchema = z.object({
  /** Stable address at the provider (email, phone, handle, etc.). */
  address: z.string().min(1),
  /** Display name when the provider supplied one. */
  name: z.string().optional(),
  /** Optional avatar URL. Not normalised. */
  avatar_url: z.string().url().optional(),
});
export type Contact = z.infer<typeof ContactSchema>;

// ---------------------------------------------------------------------------
// Attachment — file metadata. The body is fetched lazily through the
// gateway; the schema intentionally does not carry the bytes.
// ---------------------------------------------------------------------------

export const AttachmentSchema = z.object({
  id: z.string().min(1),
  filename: z.string().min(1),
  mime_type: z.string().min(1),
  size_bytes: z.number().int().nonnegative(),
  /** Hash for de-duplication. SHA-256 hex. */
  content_hash: z.string().regex(/^[0-9a-f]{64}$/i).optional(),
  /** Inline vs. attached file. Inline images can be rendered from `content_id`. */
  disposition: z.enum(['attachment', 'inline']).default('attachment'),
  content_id: z.string().optional(),
});
export type Attachment = z.infer<typeof AttachmentSchema>;

// ---------------------------------------------------------------------------
// Account — never exposes raw credentials. The handle is *redacted* and
// stored as the agents see it. Real credentials live in the gateway's
// in-memory secret store; connectors ask for them by account id only.
// ---------------------------------------------------------------------------

export const AccountStatusSchema = z.enum([
  'active',
  'reauth_required',
  'revoked',
  'paused',
]);
export type AccountStatus = z.infer<typeof AccountStatusSchema>;

export const AccountCapabilitySchema = z.enum([
  'read_mail',
  'send_mail',
  'modify_mail',
  'list_events',
  'create_event',
  'send_dm',
  'list_conversations',
]);
export type AccountCapability = z.infer<typeof AccountCapabilitySchema>;

export const AccountSchema = z.object({
  id: z.string().min(1),
  user_id: z.string().min(1),
  provider: ProviderSchema,
  handle: z.string().min(1),
  scopes: z.array(z.string().min(1)).default([]),
  capabilities: z.array(AccountCapabilitySchema).default([]),
  status: AccountStatusSchema,
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});
export type Account = z.infer<typeof AccountSchema>;

// ---------------------------------------------------------------------------
// Message — email-shaped; for messaging DMs use the Conversation object
// below. Subject is email-only.
// ---------------------------------------------------------------------------

export const MessageDirectionSchema = z.enum(['in', 'out']);
export type MessageDirection = z.infer<typeof MessageDirectionSchema>;

export const MessageSchema = z.object({
  id: z.string().min(1),
  account_id: z.string().min(1),
  thread_id: z.string().nullable(),
  direction: MessageDirectionSchema,
  from: ContactSchema,
  to: z.array(ContactSchema).min(1),
  cc: z.array(ContactSchema).default([]),
  subject: z.string().optional(),
  preview: z.string().max(280),
  body_text: z.string(),
  body_html: z.string().optional(),
  attachments: z.array(AttachmentSchema).default([]),
  labels: z.array(z.string()).default([]),
  folder: z.string().optional(),
  status_flags: z.object({
    read: z.boolean(),
    starred: z.boolean().optional(),
  }),
  received_at: z.string().datetime(),
  sent_at: z.string().datetime().optional(),
  provider_ref: ProviderRefSchema,
});
export type Message = z.infer<typeof MessageSchema>;

// ---------------------------------------------------------------------------
// Conversation — messaging-shaped. Carries the 24h CSW window for the
// providers that have one (WhatsApp / Instagram) and a last-message
// timestamp for ordering.
// ---------------------------------------------------------------------------

export const ConversationChannelSchema = z.enum([
  'sms',
  'whatsapp',
  'instagram',
  'telegram',
  'discord',
  'slack',
]);
export type ConversationChannel = z.infer<typeof ConversationChannelSchema>;

export const ConversationSchema = z.object({
  id: z.string().min(1),
  account_id: z.string().min(1),
  channel: ConversationChannelSchema,
  participants: z.array(ContactSchema).min(1),
  last_message_at: z.string().datetime(),
  unread_count: z.number().int().nonnegative(),
  /** For platforms with a free-form message window (Meta, etc.). */
  window_open_until: z.string().datetime().optional(),
  preview: z.string().max(280).optional(),
  provider_ref: ProviderRefSchema,
});
export type Conversation = z.infer<typeof ConversationSchema>;

// ---------------------------------------------------------------------------
// Event — calendar-shaped. Recurrence uses an RFC 5545 RRULE and tracks
// per-instance overrides + EXDATEs.
// ---------------------------------------------------------------------------

export const AttendeeStatusSchema = z.enum([
  'accepted',
  'declined',
  'tentative',
  'needsAction',
]);
export type AttendeeStatus = z.infer<typeof AttendeeStatusSchema>;

export const AttendeeSchema = z.object({
  contact: ContactSchema,
  status: AttendeeStatusSchema,
  optional: z.boolean().default(false),
});
export type Attendee = z.infer<typeof AttendeeSchema>;

/**
 * The Recurrence schema references Event (overrides are themselves
 * events). Using `z.lazy` creates a cycle. We declare the type first
 * and tell Zod the schema's static type.
 *
 * `exdates` and `overrides` are optional in the *input* shape (they
 * default to `[]`); they are always present in the parsed shape.
 */
export interface Recurrence {
  rrule: string;
  exdates?: string[];
  overrides?: Event[];
}

export const RecurrenceSchema = z.lazy(() =>
  z.object({
    rrule: z.string().min(1),
    exdates: z.array(z.string().datetime()).optional(),
    overrides: z.array(EventSchema).optional(),
  }),
) as unknown as z.ZodType<Recurrence>;

export const ConferenceSchema = z.object({
  provider: z.enum(['google_meet', 'teams', 'other']),
  join_url: z.string().url().optional(),
});
export type Conference = z.infer<typeof ConferenceSchema>;

export const EventStatusSchema = z.enum(['confirmed', 'tentative', 'cancelled']);
export type EventStatus = z.infer<typeof EventStatusSchema>;

export const EventTimeSchema = z.object({
  /** IANA tzid, e.g. "America/Los_Angeles". */
  tz: z.string().min(1),
  /** RFC 3339 timestamp. */
  at: z.string().datetime(),
});

export const CalendarSchema = z.object({
  id: z.string().min(1),
  account_id: z.string().min(1),
  /** Display name of the calendar. */
  name: z.string().min(1),
  /** Whether the calendar is the user's primary calendar. */
  primary: z.boolean().default(false),
  /** Hex color (#rrggbb) when the provider supplies one. */
  color: z
    .string()
    .regex(/^#[0-9a-f]{6}$/i)
    .optional(),
  /** Read-only calendars cannot be modified by the gateway. */
  read_only: z.boolean().default(false),
  provider_ref: ProviderRefSchema,
});
export type Calendar = z.infer<typeof CalendarSchema>;

export interface Event {
  id: string;
  account_id: string;
  calendar_id: string;
  title: string;
  description?: string;
  start: z.infer<typeof EventTimeSchema>;
  end: z.infer<typeof EventTimeSchema>;
  all_day: boolean;
  recurrence?: Recurrence;
  attendees: Attendee[];
  conference?: Conference;
  status: EventStatus;
  provider_ref: ProviderRef;
}

export const EventSchema = z.lazy(() =>
  z.object({
    id: z.string().min(1),
    account_id: z.string().min(1),
    calendar_id: z.string().min(1),
    title: z.string().min(1),
    description: z.string().optional(),
    start: EventTimeSchema,
    end: EventTimeSchema,
    all_day: z.boolean(),
    recurrence: RecurrenceSchema.optional(),
    attendees: z.array(AttendeeSchema).default([]),
    conference: ConferenceSchema.optional(),
    status: EventStatusSchema,
    provider_ref: ProviderRefSchema,
  }),
) as unknown as z.ZodType<Event>;
