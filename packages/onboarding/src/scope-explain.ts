/**
 * Human-readable scope explanations.
 *
 * FAG-32 acceptance criterion #3: surface provider scope requests in
 * human-readable terms before consent, including read/write
 * distinction and destructive-action implications.
 *
 * This module is the *canonical* explainer for every scope the
 * connector gateway knows about. The control plane renders the
 * result before asking the user to approve the link. The output
 * is a structured `ExplainedScope` so the UI can render it in
 * rich (cards, colour-coded chips) or plain (text-only) form.
 */
import type { Provider } from '@fagaos/connectors';

/** A single, human-readable explanation for a provider scope. */
export interface ExplainedScope {
  /** The scope string as the provider knows it. */
  scope: string;
  /** Short label, e.g. "Read your inbox". */
  label: string;
  /** Longer description, one or two sentences. */
  description: string;
  /** True iff this scope grants write access. */
  writes: boolean;
  /** True iff this scope can delete or destroy data. */
  destructive: boolean;
  /** Optional risk hint shown next to the chip. */
  risk: 'low' | 'medium' | 'high';
}

/** Catalog keyed by `provider:scope`. Unrecognised scopes are flagged. */
type ScopeCatalog = Readonly<Record<Provider, Readonly<Record<string, Omit<ExplainedScope, 'scope'>>>>>;

const SCOPE_CATALOG: ScopeCatalog = {
  gmail: {
    'https://www.googleapis.com/auth/gmail.readonly': {
      label: 'Read your inbox',
      description: 'List and read messages in the linked Gmail account.',
      writes: false,
      destructive: false,
      risk: 'low',
    },
    'https://www.googleapis.com/auth/gmail.send': {
      label: 'Send email as you',
      description: 'Send new messages from the linked account. Sends appear in your Sent folder.',
      writes: true,
      destructive: false,
      risk: 'high',
    },
    'https://www.googleapis.com/auth/gmail.modify': {
      label: 'Modify your inbox',
      description: 'Move, label, and delete messages. Agents can remove or trash items.',
      writes: true,
      destructive: true,
      risk: 'high',
    },
    openid: {
      label: 'Verify your identity',
      description: 'Confirm the Google account the link is bound to.',
      writes: false,
      destructive: false,
      risk: 'low',
    },
    email: {
      label: 'See your email address',
      description: 'Read the email address on the linked Google account.',
      writes: false,
      destructive: false,
      risk: 'low',
    },
    profile: {
      label: 'See your basic profile',
      description: 'Read your name and avatar from the linked Google account.',
      writes: false,
      destructive: false,
      risk: 'low',
    },
  },
  google_calendar: {
    'https://www.googleapis.com/auth/calendar.calendarlist.readonly': {
      label: 'List your calendars',
      description: 'Read the list of calendars the linked account can see.',
      writes: false,
      destructive: false,
      risk: 'low',
    },
    'https://www.googleapis.com/auth/calendar.events.readonly': {
      label: 'Read your events',
      description: 'Read events on the linked account\u2019s calendars.',
      writes: false,
      destructive: false,
      risk: 'low',
    },
    'https://www.googleapis.com/auth/calendar.events.owned': {
      label: 'Manage your events',
      description: 'Create, update, and delete events on calendars you own. Sends invites to attendees.',
      writes: true,
      destructive: true,
      risk: 'high',
    },
    openid: {
      label: 'Verify your identity',
      description: 'Confirm the Google account the link is bound to.',
      writes: false,
      destructive: false,
      risk: 'low',
    },
    email: {
      label: 'See your email address',
      description: 'Read the email address on the linked Google account.',
      writes: false,
      destructive: false,
      risk: 'low',
    },
    profile: {
      label: 'See your basic profile',
      description: 'Read your name and avatar from the linked Google account.',
      writes: false,
      destructive: false,
      risk: 'low',
    },
  },
  outlook: {
    'Mail.Read': {
      label: 'Read your inbox',
      description: 'List and read messages in the linked Outlook account.',
      writes: false,
      destructive: false,
      risk: 'low',
    },
    'Mail.ReadWrite': {
      label: 'Modify your inbox',
      description: 'Move, flag, and delete messages in the linked Outlook account.',
      writes: true,
      destructive: true,
      risk: 'high',
    },
    'Mail.Send': {
      label: 'Send email as you',
      description: 'Send new messages from the linked account. Sends appear in your Sent folder.',
      writes: true,
      destructive: false,
      risk: 'high',
    },
    'offline_access': {
      label: 'Stay linked when you are offline',
      description: 'Allow FagaOS to refresh the link in the background so you do not have to re-authenticate.',
      writes: false,
      destructive: false,
      risk: 'medium',
    },
    'User.Read': {
      label: 'See your basic profile',
      description: 'Read your name and avatar from the linked Microsoft account.',
      writes: false,
      destructive: false,
      risk: 'low',
    },
  },
  outlook_calendar: {
    'Calendars.Read': {
      label: 'List your calendars',
      description: 'Read the list of calendars the linked account can see.',
      writes: false,
      destructive: false,
      risk: 'low',
    },
    'Calendars.ReadWrite': {
      label: 'Manage your events',
      description: 'Create, update, and delete events on the linked account. Sends invites to attendees.',
      writes: true,
      destructive: true,
      risk: 'high',
    },
    'offline_access': {
      label: 'Stay linked when you are offline',
      description: 'Allow FagaOS to refresh the link in the background so you do not have to re-authenticate.',
      writes: false,
      destructive: false,
      risk: 'medium',
    },
    'User.Read': {
      label: 'See your basic profile',
      description: 'Read your name and avatar from the linked Microsoft account.',
      writes: false,
      destructive: false,
      risk: 'low',
    },
  },
  imap: {},
  icloud: {},
  caldav: {},
  whatsapp: {},
  instagram: {},
  telegram: {},
  discord: {},
  slack: {},
};

/** Explain a single scope for a provider. */
export function explainScope(provider: Provider, scope: string): ExplainedScope {
  const providerEntry = SCOPE_CATALOG[provider];
  if (providerEntry) {
    const known = providerEntry[scope];
    if (known) return { scope, ...known };
  }
  return {
    scope,
    label: 'Unrecognised scope',
    description: `FagaOS does not have a built-in explanation for "${scope}" on ${provider}. Treat unknown scopes as high-risk.`,
    writes: false,
    destructive: false,
    risk: 'high',
  };
}

/** Explain a list of scopes. Order is preserved. */
export function explainScopes(provider: Provider, scopes: ReadonlyArray<string>): ReadonlyArray<ExplainedScope> {
  return scopes.map((s) => explainScope(provider, s));
}

/** Group explained scopes by risk so the UI can render colour-coded chips. */
export function groupByRisk(scopes: ReadonlyArray<ExplainedScope>): Readonly<Record<'low' | 'medium' | 'high', ReadonlyArray<ExplainedScope>>> {
  const groups: Record<'low' | 'medium' | 'high', ExplainedScope[]> = { low: [], medium: [], high: [] };
  for (const s of scopes) groups[s.risk].push(s);
  return groups;
}

/** Convenience for the consent screen: are any of the scopes destructive? */
export function hasDestructiveScope(scopes: ReadonlyArray<ExplainedScope>): boolean {
  return scopes.some((s) => s.destructive);
}

/** Convenience for the consent screen: are any of the scopes writes? */
export function hasWriteScope(scopes: ReadonlyArray<ExplainedScope>): boolean {
  return scopes.some((s) => s.writes);
}
