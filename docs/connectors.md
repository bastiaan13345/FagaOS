# FagaOS Connector Gateway — Architecture

This document is the architectural companion to `packages/connectors`. It
covers the FAG-11 deliverables in `FAG-5` (the integrations design) and
how the gateway surface, normalised model, capability model, and
connector implementations fit together.

> Status: **Phase 1 skeleton (FAG-11)**. Read-only for email and
> calendar on Gmail and Google Calendar. Other providers (Outlook,
> IMAP, WhatsApp, Instagram, Telegram, Discord, Slack, iCloud, CalDAV)
> ship in follow-up issues.

## 1. Goals and non-goals

**Goals**

- A single agent-facing API: `mail.list`, `mail.get`, `mail.send`,
  `dm.conversations.list`, `dm.send`, `calendar.calendars.list`,
  `calendar.events.list`, `calendar.events.get`. Agents see the
  normalised `Message` / `Event` / `Conversation` shapes from
  `FAG-5 §4`.
- A connector per provider. Phase 1 ships Gmail and Google Calendar
  behind feature flags; everything else falls through to a stub.
- Server-side credentials. Connectors receive an access token from the
  gateway; the refresh token never leaves the credential vault (out of
  scope for this issue).
- Per-account rate-limit budget and 24-hour idempotency store.
- Reauth-status tracking: a refresh failure flips the account to
  `reauth_required` and the gateway refuses to dispatch.
- Every gateway call emits an `AuditLog` entry.

**Non-goals (this issue)**

- Production OAuth consent screens and production webhook deployments
  (local dev only).
- Sending email or creating calendar events (read-only mode in this
  issue; `mail.send` works in stubs only, real connectors are pinned
  `read_only: true`).
- Policy-engine integration: the gateway accepts a token-shaped object
  and trusts the broker in Phase 1.
- The full provider matrix in `FAG-5 §3`: only Gmail + Google Calendar
  + their stubs.

## 2. Package layout

```
packages/connectors/
├── src/
│   ├── models/             # Zod schemas + inferred types (single source of truth)
│   │   ├── schemas.ts      # Account, Message, Event, Conversation, ...
│   │   └── index.ts
│   ├── capability.ts       # Capability + CapabilityToken + tokenAuthorizes
│   ├── connector.ts        # Connector interface + request/result envelopes
│   ├── errors.ts           # ConnectorError taxonomy
│   ├── features/           # FeatureFlagRegistry (gmail, google_calendar, stub_*)
│   ├── oauth/              # PKCE helper + Google token-exchange client
│   ├── store/              # AccountStore, IdempotencyStore, RateLimitBudget, ReauthTracker
│   ├── connectors/         # Concrete connector implementations
│   │   ├── stub/           # StubEmailConnector, StubCalendarConnector
│   │   ├── gmail/          # GmailConnector (real, read-only)
│   │   └── google-calendar/# GoogleCalendarConnector (real, read-only)
│   ├── webhooks/           # Pub/Sub envelope → connector notification decoder
│   ├── gateway/            # ConnectorGateway (the only public surface)
│   └── index.ts            # Public re-exports
└── tests/                  # Vitest suites for every layer
```

The `ConnectorGateway` is the **only** entry point agents see. It
exposes the FAG-5 tool surface one-to-one and is responsible for
account lookup, capability check, rate-limit, idempotency, audit
emission, and connector dispatch.

## 3. Public surface

```ts
// All operations share this envelope:
interface GatewayInput {
  token: CapabilityToken;
  account_id: string;
  args: { ... };            // schema-validated by the gateway
  idempotency_key?: string; // gateway generates one when omitted
  trace_id?: string;        // gateway generates one when omitted
}

class ConnectorGateway {
  mailList(input: MailListInput): Promise<MailListResult>;
  mailGet(input: MailGetInput): Promise<MailGetResult>;
  mailSend(input: MailSendInput): Promise<MailSendResult>;
  dmConversationsList(input: DmConversationsListInput): Promise<DmConversationsListResult>;
  dmSend(input: DmSendInput): Promise<DmSendResult>;
  calendarCalendarsList(input: CalendarsListInput): Promise<CalendarsListResult>;
  calendarEventsList(input: EventsListInput): Promise<EventsListResult>;
}
```

Errors are `ConnectorError` with a stable `code`:

| Code                       | Meaning                                                |
| -------------------------- | ------------------------------------------------------ |
| `invalid_input`            | The `args` block failed Zod validation.                 |
| `unauthorized`             | The provider rejected the access token.                |
| `forbidden`                | The token does not cover the call, or the account is paused/revoked. |
| `not_found`                | The account id or the target resource is unknown.      |
| `rate_limited`             | The per-account budget is exhausted; `retry_after_ms` is the hint. |
| `provider_error`           | The provider returned a non-2xx response.              |
| `provider_unavailable`     | Network or DNS failure.                                |
| `webhook_signature_invalid`| Webhook OIDC/HMAC verification failed.                 |
| `webhook_payload_invalid`  | Webhook body failed schema validation.                 |
| `reauth_required`          | The account needs the user to re-link.                 |
| `idempotency_conflict`     | The same key was used with a different request body.   |
| `feature_disabled`         | The provider's feature flag is off, or no connector is registered. |
| `internal`                 | Unexpected. Surfaces to the audit log as `error`.      |

## 4. Dispatch flow

For every public call the gateway runs the same pipeline:

1. **Account lookup** — `accounts.get(id)`. Missing → `not_found`.
2. **Account state** — `reauth_required` → `reauth_required`;
   `paused` / `revoked` → `forbidden`.
3. **Capability check** — `tokenAuthorizes(token, { provider, operation, account_id })`.
   Missing → `forbidden` + `deny` audit entry.
4. **Connector registration** — `connectors.get(provider)`;
   missing → `feature_disabled`.
5. **Operation support** — connector advertises the op in `operations`;
   missing → `not_found`.
6. **Feature flag** — provider flag is on (or stub fallback);
   off → `feature_disabled`.
7. **Rate-limit budget** — `RateLimitBudget.consume(1)`. Denied → `rate_limited` + `deny` audit + `retry_after_ms`.
8. **Idempotency** — `idempotency.reserveOrLookup(key, request_hash)`.
   Hit with same hash → return stored response + extra audit entry
   marked `replay: true`. Hit with different hash → `idempotency_conflict`.
9. **Connector call** — the matching `connector.<op>(request, audit)`
   method. The connector receives the `AuditLog` and may append its
   own entries (e.g. token refresh).
10. **Audit** — one entry per call, `action.name =
    connector.<provider>.<operation>`, `outcome = ok | deny | error`.
11. **Idempotency commit** — store `key → response` for 24h.
12. **Reauth tracking** — if the connector raised `reauth_required`,
    the gateway flips the reauth flag in addition to throwing.

## 5. Normalized model

The Zod schemas in `src/models/schemas.ts` are the single source of
truth. The types are `z.infer<…>` of the schemas. Additions and
changes go through the schema first.

Highlights:

- `Account.handle` is the **redacted** handle. The connector never
  surfaces the raw email/phone; the gateway redacts at the
  account-store boundary.
- `ProviderRef.native_id` is the opaque id at the source. The gateway
  uses it for the return path (e.g. reply in the right thread).
- `Message.preview` is capped at 280 chars. The connector is
  responsible for truncating.
- `Event.recurrence.overrides` and `Event.recurrence.exdates` are
  optional in the input; the parser fills defaults.
- `Account.status` is `active | reauth_required | revoked | paused`.
  The gateway is the gate; the connector is the source of the
  reauth signal.

## 6. Auth (PKCE + Google)

The OAuth helper in `src/oauth/google.ts` and the PKCE helper in
`src/oauth/pkce.ts` cover the Phase 1 path:

- `generatePkce()` returns a verifier + S256 challenge.
- `buildAuthorizationUrl()` returns the URL the user visits.
- `exchangeAuthorizationCode()` performs the code → token exchange.
- `exchangeRefreshToken()` refreshes; failure raises `reauth_required`.

The connector never holds the refresh token. It asks the gateway for
an access token through a `GoogleTokenProvider` interface that the
gateway wires to the credential vault.

## 7. Push and sync

Two webhook surfaces ship in this issue, both behind the `webhooks/`
module:

- **Gmail**: `users.watch` → Pub/Sub push. The `processPubSubMessage`
  method on `GmailConnector` decodes the envelope; the gateway
  translates the decoded history into a `users.history.list` backfill
  via `listHistory`.
- **Google Calendar**: `events.watch` → Pub/Sub push. The
  `processWatchNotification` method on `GoogleCalendarConnector`
  returns the channel id and resource id; the gateway persists them
  and re-`watch`es when the 7-day lease expires.

Polling is a backstop:

- Gmail: `users.history.list` with a stored `startHistoryId` (already
  shipped via `listHistory`).
- Google Calendar: `events.list` with a stored `syncToken`; on 410
  GONE the gateway wipes the token and full-syncs.

## 8. Out of scope for follow-ups

The stub slots are the *only* connector for these providers in
FAG-11. They return deterministic fixtures keyed by account id and
exist for tests + early demos. Real implementations are scheduled:

| Provider             | Issue    | Notes                                    |
| -------------------- | -------- | ---------------------------------------- |
| Outlook / Graph Mail | TBD      | Delta query + lifecycle notifications.   |
| Generic IMAP         | TBD      | IDLE, XOAUTH2, polling fallback.         |
| iCloud Mail          | TBD      | App-specific password + IMAP IDLE.       |
| WhatsApp Cloud       | TBD      | 24h CSW enforcement, wamid dedupe.       |
| Instagram            | TBD      | Business Login, conversation window.     |
| Telegram             | TBD      | `setWebhook` + `secret_token`.           |
| Discord              | TBD      | Sharded gateway, privileged intents.     |
| Slack                | TBD      | Events API + signing secret.             |
| Outlook Calendar     | TBD      | Graph subscription + delta query.        |
| iCloud CalDAV        | TBD      | App-specific password + sync-collection. |
| Generic CalDAV       | TBD      | `/.well-known/caldav` discovery.         |

## 9. Testing

`packages/connectors/tests/` has one file per layer:

- `models.test.ts` — every Zod schema, defaults, and rejections.
- `store.test.ts` — `InMemoryAccountStore`, `InMemoryIdempotencyStore`,
  `RateLimitBudget`, `ReauthTracker`.
- `capability.test.ts` — `tokenAuthorizes`, `featureFlagsFromEnv`.
- `oauth.test.ts` — PKCE + Google token exchange.
- `stub.test.ts` — fixture determinism + not-implemented rejection.
- `connectors.test.ts` — Gmail + Google Calendar with a mocked
  `fetch`. Covers happy path, 401/403/404, 410 GONE, and Pub/Sub
  decoding.
- `webhooks.test.ts` — webhook routing and auth verifier.
- `gateway.test.ts` — end-to-end dispatch through every layer. The
  test surfaces every error code, the rate-limit path, the
  idempotency replay, the reauth flip, the feature-flag gate, and
  the audit-log emission per call.

The Phase 1 coverage floor is 80% lines / 75% branches per the
project-wide vitest config. The connectors package ships at
**~96% lines, 88% branches** on its own; the audit log primitive
(`@fagaos/core`) remains the single critical path above 90%.

## 10. References

- FAG-5 — Design doc, the source of the normalised model and
  provider matrix.
- FAG-8 — Audit log primitive, wired into the gateway.
- FAG-9 — Runtime contract (control plane + agent manifest).
- FAG-10 — Unification of the FAG-8 monorepo and FAG-9 runtime
  contract layer. FAG-11 branches from FAG-8; FAG-10 will pick this
  branch up.
- `docs/architecture.md` — FagaOS core platform architecture.
- `docs/api/control-plane.openapi.yaml` — sibling OpenAPI spec for
  the control plane; the connector gateway spec lives next to it
  in `docs/api/connectors.openapi.yaml`.
