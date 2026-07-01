/**
 * Account-link lifecycle.
 *
 * FAG-32 acceptance criterion #2: support account-linking states for
 * OAuth / app-password / bot-token providers. The seven states are
 * the contract between the connector gateway (FAG-25), the auth
 * flows, and the onboarding UI. A connector row starts in
 * `not_connected`, walks through `linking`, and ends in `connected`
 * — or a non-happy-path state with a clear next action for the user.
 *
 * State transitions are guarded; an invalid transition raises
 * `AccountLinkTransitionError`. The intent is that the control plane
 * never has to remember whether a state change is legal: it asks
 * the primitive, which is the source of truth.
 */
import { z } from 'zod';
import { ProviderSchema, type Provider } from '@fagaos/connectors';

/** The seven account-link states. */
export const AccountLinkStateSchema = z.enum([
  'not_connected',
  'linking',
  'connected',
  'reauth_required',
  'paused',
  'revoked',
  'error',
]);
export type AccountLinkState = z.infer<typeof AccountLinkStateSchema>;

/** The auth mechanism used to link the account. */
export const AccountLinkKindSchema = z.enum([
  'oauth',
  'app_password',
  'bot_token',
  'api_key',
]);
export type AccountLinkKind = z.infer<typeof AccountLinkKindSchema>;

/** Persisted account-link record. */
export const AccountLinkSchema = z.object({
  /** Stable, server-issued id for this link. */
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  provider: ProviderSchema,
  userId: z.string().min(1),
  kind: AccountLinkKindSchema,
  state: AccountLinkStateSchema.default('not_connected'),
  /** Opaque provider handle (email, phone, channel id, ...). */
  handle: z.string().optional(),
  /** OAuth scopes / bot scopes the link requested. */
  scopes: z.array(z.string()).default([]),
  /** Error code set when state is `error` (matches the error taxonomy). */
  errorCode: z.string().optional(),
  /** ISO 8601 last-mutation timestamp. */
  updatedAt: z.string().datetime().default(() => new Date().toISOString()),
});
export type AccountLink = z.infer<typeof AccountLinkSchema>;

/** Error raised when an account-link transition is not legal. */
export class AccountLinkTransitionError extends Error {
  readonly code: 'invalid_transition' | 'terminal_state' | 'invalid_input';
  constructor(code: 'invalid_transition' | 'terminal_state' | 'invalid_input', message: string) {
    super(message);
    this.name = 'AccountLinkTransitionError';
    this.code = code;
  }
}

/** Terminal states cannot be exited (the user must re-link). */
const TERMINAL_STATES: ReadonlySet<AccountLinkState> = new Set(['revoked']);

/** Valid transitions from each state. */
const TRANSITIONS: Readonly<Record<AccountLinkState, ReadonlyArray<AccountLinkState>>> = {
  not_connected: ['linking', 'revoked'],
  linking: ['connected', 'error', 'revoked'],
  connected: ['reauth_required', 'paused', 'revoked'],
  reauth_required: ['linking', 'revoked'],
  paused: ['connected', 'revoked'],
  revoked: [],
  error: ['linking', 'not_connected', 'revoked'],
};

/** Returns the legal next states for a given state. */
export function nextStatesFor(state: AccountLinkState): ReadonlyArray<AccountLinkState> {
  return TRANSITIONS[state];
}

/** True iff the state is terminal (the user must re-link from scratch). */
export function isAccountLinkTerminal(state: AccountLinkState): boolean {
  return TERMINAL_STATES.has(state);
}

/**
 * Apply a state transition. Validates that the transition is legal
 * from the current state and applies any state-specific side effects
 * (clearing scopes on revoke, populating errorCode on error, ...).
 */
export function transitionAccountLink(
  link: AccountLink,
  next: AccountLinkState,
  now: () => Date = () => new Date(),
  details?: { errorCode?: string },
): AccountLink {
  if (isAccountLinkTerminal(link.state)) {
    throw new AccountLinkTransitionError('terminal_state', `account link "${link.id}" is in terminal state "${link.state}"`);
  }
  if (!TRANSITIONS[link.state].includes(next)) {
    throw new AccountLinkTransitionError(
      'invalid_transition',
      `cannot transition account link "${link.id}" from "${link.state}" to "${next}"`,
    );
  }
  let { scopes, errorCode } = link;
  if (next === 'revoked') {
    // Wipe scopes on revoke so a recycled id can never inherit them.
    scopes = [];
    errorCode = undefined;
  }
  if (next === 'error') {
    if (!details?.errorCode) {
      throw new AccountLinkTransitionError('invalid_input', 'errorCode is required when transitioning to "error"');
    }
    errorCode = details.errorCode;
  }
  if (next === 'connected') {
    // Clear any prior error code on successful re-link.
    errorCode = undefined;
  }
  if (next === 'linking') {
    // The user clicked "retry" — wipe the prior error so the UI
    // does not display a stale error from the previous attempt.
    errorCode = undefined;
  }
  return { ...link, state: next, scopes, errorCode, updatedAt: now().toISOString() };
}

/** A linked provider that the user can act on. */
export interface ResolvedAccountLink {
  account_id: string;
  provider: Provider;
  handle: string;
  state: AccountLinkState;
  scopes: ReadonlyArray<string>;
}

/** Filter the list to the links a caller may act on (`connected` only). */
export function actionableLinks(links: ReadonlyArray<AccountLink>): ReadonlyArray<ResolvedAccountLink> {
  return links
    .filter((l) => l.state === 'connected')
    .map((l) => ({
      account_id: l.id,
      provider: l.provider,
      handle: l.handle ?? '',
      state: l.state,
      scopes: l.scopes,
    }));
}

/** Filter the list to the links that need operator attention. */
export function attentionLinks(links: ReadonlyArray<AccountLink>): ReadonlyArray<AccountLink> {
  return links.filter((l) => l.state === 'reauth_required' || l.state === 'error' || l.state === 'paused');
}
