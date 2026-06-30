# FagaOS Connector Gateway — Architecture

This document is the architectural companion to `packages/connectors`. It
covers the FAG-11 deliverables in `FAG-5` (the integrations design) and
how the gateway surface, normalised model, capability model, and
connector implementations fit together.

> Status: **Phase 2 (FAG-25)**. Gmail and Google Calendar are
> production-capable (read + write). The remaining 11 providers
> (Outlook, IMAP, iCloud, WhatsApp, Instagram, Telegram, Discord,
> Slack, Outlook Calendar, iCloud CalDAV, CalDAV) ship with full
> wire-format coverage and unit tests, behind feature flags, with
> staging-account validation in flight under the dependent
> follow-up issues. See `docs/connectors-providers.md` for the
> per-provider deep-dive.

## 1. Goals and non-goals

**Goals**

- A single agent-facing API: `mail.list`, `mail.get`, `mail.send`,
  `mail.reply`, `mail.forward`, `dm.conversations.list`, `dm.send`,
  `calendar.calendars.list`, `calendar.events.list`,
  `calendar.events.get`, `calendar.events.create`,
  `calendar.events.update`, `calendar.events.delete`. Agents see
  the normalised `Message` / `Event` / `Conversation` shapes from
  `FAG-5 §4`.
- A connector per provider. Phase 2 ships real wire-format
  implementations for every provider in the FAG-5 matrix.
- Server-side credentials. Connectors receive an access token from
  the gateway; the refresh token never leaves the credential vault.
- Per-account rate-limit budget and 24-hour idempotency store.
- Reauth-status tracking: a refresh failure flips the account to
  `reauth_required` and the gateway refuses to dispatch.
- Per-provider webhook signature verification (HMAC-SHA256 for
  Meta/Slack, Ed25519 for Discord, OIDC bearer for Google, etc.).
- Every gateway call emits an `AuditLog` entry.

**Non-goals (this issue)**

- Product UI for account linking (FAG-32 owns the link flow; the
  gateway only exposes `productionAuthorizationUrl`).
- Human escalation workflow (FAG-25 leaves the reauth flow to the
  control plane; FAG-22 ships the PR flow; FAG-13 owns the
  policy engine).

## 2. Package layout

```
packages/connectors/
├── src/
│   ├── models/             # Zod schemas + inferred types (single source of truth)
│   ├── capability.ts       # Capability + CapabilityToken + tokenAuthorizes
│   ├── connector.ts        # Connector interface + request/result envelopes
│   ├── errors.ts           # ConnectorError taxonomy
│   ├── features/           # FeatureFlagRegistry (per-provider flags)
│   ├── oauth/              # PKCE + Google + Microsoft Graph helpers
│   ├── store/              # AccountStore, IdempotencyStore, RateLimitBudget,
│   │                       # RateLimitPolicy, ReauthTracker
│   ├── connectors/         # Concrete connector implementations
│   │   ├── stub/           # StubEmailConnector, StubCalendarConnector
│   │   ├── gmail/          # GmailConnector (real, read + write)
│   │   ├── google-calendar/# GoogleCalendarConnector (real, read + write)
│   │   ├── outlook/        # OutlookConnector (mail) + Graph token provider
│   │   ├── outlook-calendar/ # OutlookCalendarConnector
│   │   ├── imap/           # ImapConnector (generic, XOAUTH2-capable)
│   │   ├── caldav/         # CalDavConnector (RFC 4791)
│   │   ├── icloud/         # iCloud helpers (IMAP + CalDAV)
│   │   ├── whatsapp/       # WhatsApp Cloud connector
│   │   ├── instagram/      # Instagram (Messenger) connector
│   │   ├── telegram/       # Telegram bot connector
│   │   ├── discord/        # Discord bot connector
│   │   └── slack/          # Slack bot connector
│   ├── webhooks/           # Pub/Sub + signature verifiers for every provider
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
  mailReply(input: MailReplyInput): Promise<MailReplyResult>;
  mailForward(input: MailForwardInput): Promise<MailForwardResult>;
  dmConversationsList(input: DmConversationsListInput): Promise<DmConversationsListResult>;
  dmSend(input: DmSendInput): Promise<DmSendResult>;
  calendarCalendarsList(input: CalendarsListInput): Promise<CalendarsListResult>;
  calendarEventsList(input: EventsListInput): Promise<EventsListResult>;
  calendarEventGet(input: EventGetInput): Promise<EventGetResult>;
  calendarEventCreate(input: EventCreateInput): Promise<EventCreateResult>;
  calendarEventUpdate(input: EventUpdateInput): Promise<EventUpdateResult>;
  calendarEventDelete(input: EventDeleteInput): Promise<void>;
}
```

Errors are `ConnectorError` with a stable `code` (see
`docs/connectors-providers.md` for the per-provider mapping).

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
7. **Rate-limit budget** — `RateLimitBudget.consume(cost)`. The cost
   is the per-operation weight from `RateLimitPolicy`. Denied →
   `rate_limited` + `deny` audit + `retry_after_ms` + `cost`.
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

## 6. Auth

The OAuth helpers in `src/oauth/` cover every provider in the matrix:

- `pkce.ts` — RFC 7636 PKCE pair + URL builder.
- `google.ts` + `google_production_oauth.ts` — Google consent URL
  with the production scope bundle, code exchange, refresh.
- `microsoft_graph.ts` — Microsoft identity platform (multi-tenant
  consent, code exchange, refresh, lifecycle event decoding).

The connector never holds the refresh token. It asks the gateway
for an access token through a `*TokenProvider` interface that the
gateway wires to the credential vault.

## 7. Push and sync

The webhook layer is per-provider. Each connector exposes
`process*Notification` methods that the transport-agnostic
`webhooks/index.ts > processWebhook` dispatches. The signature
verifiers in `webhooks/signatures.ts` are the security boundary
for every ingress.

Push channels:

- **Gmail**: `users.watch` → Pub/Sub push. The `processPubSubMessage`
  method on `GmailConnector` decodes the envelope; the gateway
  verifies the OIDC bearer with `verifyGoogleOidcBearer` and calls
  `gmailConnector.listHistory(accountId, startHistoryId)`.
- **Google Calendar**: `events.watch` → Pub/Sub push. The
  `processWatchNotification` method on `GoogleCalendarConnector`
  returns the channel id and resource id; the gateway persists them
  and re-`watch`es when the 7-day lease expires.
- **Outlook**: Graph change notifications. The control plane
  creates a `subscription` resource on account link; the gateway
  verifies `clientState` with `verifyGraphClientState` and reacts
  to `processLifecycle` (`reauthorizationRequired` /
  `subscriptionRemoved` / `missed`).
- **Meta (WhatsApp / Instagram)**: HMAC-SHA256 (`verifyMetaSignature`).
- **Telegram**: `secret_token` header (`verifyTelegramSecretToken`).
- **Discord**: Ed25519 (`verifyDiscordSignature`).
- **Slack**: HMAC-SHA256 + 5-minute timestamp tolerance
  (`verifySlackSignature`).

Polling is a backstop:

- Gmail: `users.history.list` with a stored `startHistoryId` (already
  shipped via `listHistory`).
- Google Calendar: `events.list` with a stored `syncToken`; on 410
  GONE the gateway wipes the token and full-syncs.
- Outlook: `delta` queries with a stored `deltaLink`.
- CalDAV: `REPORT` with a stored `sync-token`.

## 8. Provider matrix

See `docs/connectors-providers.md` for the per-provider deep-dive
(setup, scopes, webhook deployment, rate-limit, reauth, failure
modes, staging fixtures). The short version:

| Provider            | Mail surface          | Calendar surface       | Status               |
| ------------------- | --------------------- | ---------------------- | -------------------- |
| Gmail               | `mail.*` (read/write) | (n/a)                  | Production-capable   |
| Google Calendar     | (n/a)                 | `calendar.events.*`    | Production-capable   |
| Outlook (mail)      | `mail.*` (read/write) | (n/a)                  | Wire-format complete |
| Outlook (calendar)  | (n/a)                 | `calendar.events.*`    | Wire-format complete |
| Generic IMAP        | `mail.*` (read/write) | (n/a)                  | Wire-format complete |
| iCloud (mail)       | `mail.*` (read/write) | (n/a)                  | Wire-format complete |
| iCloud (CalDAV)     | (n/a)                 | `calendar.events.*`    | Wire-format complete |
| Generic CalDAV      | (n/a)                 | `calendar.events.*`    | Wire-format complete |
| WhatsApp Cloud      | (n/a)                 | (n/a)                  | Wire-format complete |
| Instagram           | (n/a)                 | (n/a)                  | Wire-format complete |
| Telegram            | (n/a)                 | (n/a)                  | Wire-format complete |
| Discord             | (n/a)                 | (n/a)                  | Wire-format complete |
| Slack               | (n/a)                 | (n/a)                  | Wire-format complete |

Every provider is feature-flagged off by default; the operator
flips the relevant `FAGAOS_FEATURE_<provider>` env var to enable
it for a workspace. The gateway refuses to dispatch a call when
the flag is off and the connector is the only registered
implementation (the stub fallback handles demos).

## 9. Testing

`packages/connectors/tests/` has one file per layer:

- `models.test.ts` — every Zod schema, defaults, and rejections.
- `store.test.ts` — `InMemoryAccountStore`, `InMemoryIdempotencyStore`,
  `RateLimitBudget`, `ReauthTracker`.
- `rate-limit-policy.test.ts` — per-provider policy resolution.
- `capability.test.ts` — `tokenAuthorizes`, `featureFlagsFromEnv`.
- `oauth.test.ts` — PKCE + Google token exchange.
- `microsoft-graph-oauth.test.ts` — Microsoft Graph OAuth.
- `stub.test.ts` — fixture determinism + not-implemented rejection.
- `connectors.test.ts` — Gmail + Google Calendar with a mocked
  `fetch`. Covers happy path, 401/403/404, 410 GONE, and Pub/Sub
  decoding.
- `connector-write-ops.test.ts` — Gmail + Google Calendar write
  paths (`mail.send` / `mail.reply` / `mail.forward`,
  `calendar.events.create` / `update` / `delete`).
- `messaging-connectors.test.ts` — every messaging connector
  (WhatsApp, Instagram, Telegram, Discord, Slack).
- `webhooks.test.ts` — webhook routing and auth verifier.
- `webhook-signatures.test.ts` — every provider signature verifier
  with constant-time-comparison fixtures.
- `gateway.test.ts` — end-to-end dispatch through every layer. The
  test surfaces every error code, the rate-limit path, the
  idempotency replay, the reauth flip, the feature-flag gate, and
  the audit-log emission per call.

The Phase 1 coverage floor is 80% lines / 75% branches per the
project-wide vitest config. The connectors package ships above
that floor; the audit log primitive (`@fagaos/core`) remains the
single critical path above 90%.

## 10. References

- FAG-5 — Design doc, the source of the normalised model and
  provider matrix.
- FAG-8 — Audit log primitive, wired into the gateway.
- FAG-9 — Runtime contract (control plane + agent manifest).
- FAG-10 — Unification of the FAG-8 monorepo and FAG-9 runtime
  contract layer. FAG-11 branches from FAG-8; FAG-10 picked up
  the branch in main.
- FAG-11 — Connector gateway skeleton (Phase 1).
- FAG-12 — QA harness and connector contract suite.
- FAG-13 — Policy engine and capability token minting.
- FAG-21 — Durable control-plane state and scheduler lifecycle.
- FAG-22 — Repository, PR flow, and deployment packaging.
- FAG-24 — Policy, secrets, and capability hardening.
- FAG-25 — **This issue.** Production connector expansion and write
  operations.
- `docs/connectors-providers.md` — per-provider deep-dive.
- `docs/architecture.md` — FagaOS core platform architecture.
- `docs/api/control-plane.openapi.yaml` — sibling OpenAPI spec for
  the control plane; the connector gateway spec lives next to it
  in `docs/api/connectors.openapi.yaml`.
