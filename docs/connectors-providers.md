# FagaOS Connector Provider Matrix — Phase 2

This document is the operations companion to `packages/connectors`.
It describes every provider the gateway can route to, the OAuth
or credential shape the connector expects, the webhook deployment
recipe, the per-provider rate-limit budget, the failure/recovery
behaviour the agent should know about, and the staging fixtures we
test against.

> Status: **Phase 2 (FAG-25)**. Read-only + write paths for Gmail
> and Google Calendar are production-capable; the rest of the matrix
> is wire-format-complete and unit-tested, with staging-account
> validation in flight under the dependent follow-up issues.

## 1. Provider matrix

| Provider            | Provider id          | Mail surface    | Calendar surface       | Push / sync                       | Idempotency / dedup              | Rate limit (per account)           |
| ------------------- | -------------------- | --------------- | ---------------------- | --------------------------------- | -------------------------------- | ---------------------------------- |
| Gmail               | `gmail`              | `mail.*`        | (n/a — use GCal)       | Pub/Sub push + `users.history`    | `users.messages.send` returns threadId; client supplies key | 250/min (1 unit / read, 5 / send)  |
| Google Calendar     | `google_calendar`    | (n/a — Gmail)   | `calendar.events.*`    | Pub/Sub push + `syncToken`        | ETag on `events.patch`; connector rejects `412` → `idempotency_conflict` | 250/min                          |
| Outlook (mail)      | `outlook`            | `mail.*`        | (n/a — GCal)           | Graph subscriptions (delta)       | `idempotency_key`; 24h replay    | 60/min (1 / read, 5 / send)        |
| Outlook (calendar)  | `outlook_calendar`   | (n/a — Outlook) | `calendar.events.*`    | Graph subscriptions (delta)       | ETag on `PATCH` → `idempotency_conflict` | 60/min                          |
| Generic IMAP        | `imap`               | `mail.*`        | (n/a)                  | IMAP IDLE                         | Client supplies key              | 30/min                            |
| iCloud (mail)       | `icloud` (mail)      | `mail.*`        | (n/a)                  | iCloud IMAP IDLE                  | Client supplies key              | 30/min                            |
| iCloud (CalDAV)     | `icloud` (calendar)  | (n/a)           | `calendar.events.*`    | CalDAV `sync-collection`          | ETag on `PUT` → `idempotency_conflict` | 30/min                       |
| Generic CalDAV      | `caldav`             | (n/a)           | `calendar.events.*`    | CalDAV `sync-collection`          | ETag on `PUT` → `idempotency_conflict` | 30/min                       |
| WhatsApp Cloud      | `whatsapp`           | (n/a)           | (n/a)                  | Meta webhook (24h CSW)            | `messages[].id` is `wamid.*`     | 80/min (1 / list, 5 / send)        |
| Instagram           | `instagram`          | (n/a)           | (n/a)                  | Meta webhook (24h CSW)            | `message_id` from webhook        | 60/min (5 / send)                  |
| Telegram            | `telegram`           | (n/a)           | (n/a)                  | `setWebhook` + secret token       | `update_id` for dedup            | 30/s (one message per second per chat) |
| Discord             | `discord`            | (n/a)           | (n/a)                  | Interactions Endpoint (Ed25519)   | `message_id` returned by API     | 5/s (global)                      |
| Slack               | `slack`              | (n/a)           | (n/a)                  | Events API (HMAC-SHA256)          | `ts` of the message              | 60/min (workspace tier)            |

The connector ids map 1:1 to the `Provider` enum in
`packages/connectors/src/models/schemas.ts`. The gateway routes
`account.provider` → `ConnectorGateway.connectors[provider]`.

## 2. Per-provider deep-dive

The rest of this document walks through each provider in the order
agents typically use them. The shape of each section is identical:

- **Setup** — link a workspace account (consent URL, scopes).
- **Webhook deployment** — endpoint, secret, signature algorithm.
- **Rate-limit policy** — exact numbers from
  `store/rate-limit-policy.ts` and the user-facing retry semantics.
- **Reauth handling** — what flips the reauth flag and how the
  control plane re-prompts the user.
- **Failure modes** — known 4xx/5xx → `ConnectorError` mapping.
- **Staging fixtures** — what the Phase 1 QA harness uses to
  exercise the connector.

### 2.1 Gmail (`gmail`)

#### Setup

The consent URL is built by
`oauth/google_production_oauth.ts > productionAuthorizationUrl`:

```ts
import { generatePkce, productionAuthorizationUrl } from '@fagaos/connectors/oauth';

const pkce = generatePkce();
const url = productionAuthorizationUrl({
  provider: 'gmail',
  client_id: process.env.GOOGLE_CLIENT_ID!,
  redirect_uri: 'https://app.fagaos.local/integrations/google/callback',
  state: csrf,
  pkce,
  // access_type defaults to 'offline' so the user grants a refresh
  // token; prompt defaults to 'consent' so a re-link always
  // mints a fresh refresh token.
});
```

Scopes the production link requests
(see `GOOGLE_PRODUCTION_SCOPES.gmail`):

- `https://www.googleapis.com/auth/gmail.readonly` — list + get
- `https://www.googleapis.com/auth/gmail.send` — send / reply / forward
- `https://www.googleapis.com/auth/gmail.modify` — label / mark read
- `openid`, `email`, `profile` — for the OIDC `id_token` used as the
  account `handle` and `user_id`.

#### Token refresh

The `GoogleTokenProvider` passed to the connector does the refresh
in the credential vault. The refresh path uses
`oauth/google.ts > exchangeRefreshToken`. A `400 invalid_grant`
raises `ConnectorError` with code `reauth_required`; the gateway
flips the reauth flag in the tracker so subsequent calls are
refused.

#### Webhook

Pub/Sub push. The connector's `processPubSubMessage` decodes the
envelope; the gateway verifies the OIDC bearer with
`webhooks/signatures > verifyGoogleOidcBearer` (audience = the
gateway's push endpoint) and on success calls
`gmailConnector.listHistory(accountId, startHistoryId)`. The
resulting `history_id` is the new `startHistoryId`.

The connector itself does **not** call `users.watch`. The FagaOS
control plane issues the watch request and persists the
`historyId` per account. The 7-day `expiration` triggers a
re-watch.

#### Rate-limit policy

- 250 units / 60s sliding window per account.
- `mail.send` costs 5 units (Google's `users.messages.send` counts
  against a separate per-user send quota).
- The connector reads `users.messages.list` (1 unit) and
  `users.messages.get` per message (1 unit each). For inbox-style
  lists the gateway batches with a `maxResults` cap.

#### Reauth

- `invalid_grant` on refresh → `reauth_required` flag in the
  tracker. The next gateway call returns `reauth_required` to the
  agent; the FagaOS control plane surfaces a "re-link" prompt.
- The connector is constructed with `read_only: false` only in
  production builds that mint the `gmail.send` scope. The
  capability check in the gateway is the second layer (an agent
  with only `mail.read` cannot trigger `mail.send`).

#### Failure modes

| Provider code         | Connector code           | Notes                                             |
| --------------------- | ------------------------ | ------------------------------------------------- |
| `401`/`403`           | `unauthorized`           | Token expired or revoked. Triggers reauth flow.   |
| `404`                 | `not_found`              | Message id does not exist (deleted or wrong thread). |
| `429`                 | `rate_limited`           | Google's per-user quota. The connector surfaces the `retry-after` hint. |
| `5xx`                 | `provider_error`         | Retried with exponential backoff by the gateway.  |

#### Staging fixtures

- The Phase 1 QA harness uses a `fetch` mock that replays canned
  `users.messages.list` / `get` / `send` envelopes.
- Phase 2 adds a staging-account fixture in
  `tests/connector-write-ops.test.ts` that exercises the
  `mail.send` / `mail.reply` / `mail.forward` write path against a
  mocked Gmail.

### 2.2 Google Calendar (`google_calendar`)

#### Setup

Same consent URL as Gmail, but the scope bundle is
`GOOGLE_PRODUCTION_SCOPES.google_calendar`:

- `calendar.calendarlist.readonly` — list calendars
- `calendar.events.readonly` — list/get events
- `calendar.events.owned` — create/update/delete
- `openid`, `email`, `profile`

#### Token refresh

Identical to Gmail. Refresh failures raise `reauth_required` and
flip the flag.

#### Webhook

Pub/Sub push from `events.watch`. The connector's
`processWatchNotification` decodes the envelope; the gateway
treats the notification as "run `events.list` with the stored
`syncToken`". The `events.watch` channel expires every 7 days;
the control plane re-watches before expiry.

#### Rate-limit policy

- 250 units / 60s per account.
- Read endpoints cost 1 unit; `events.insert` / `events.patch` /
  `events.delete` cost 5 each (Google's calendar API counts
  writes against a separate quota).

#### Reauth

Same as Gmail.

#### Failure modes

- `404` → `not_found` (event or calendar deleted).
- `410 GONE` → `reauth_required` (sync token expired; the gateway
  wipes the token and the next call performs a full sync).
- `412 Precondition Failed` on `events.patch` → `idempotency_conflict`
  (the etag did not match; the agent should re-fetch and retry).
- `429` → `rate_limited` with the provider's `retry-after` hint.

### 2.3 Outlook (mail + calendar) — Microsoft Graph

#### Setup

The consent URL is built by
`oauth/microsoft_graph.ts > graphAuthorizationUrl`. The
`tenant` parameter defaults to `common` (multi-tenant + personal
accounts). Production deployments targeting a single tenant
should pass the tenant id.

Scopes (see `GRAPH_PRODUCTION_SCOPES`):

- Mail: `Mail.Read`, `Mail.ReadWrite`, `Mail.Send`, `offline_access`
- Calendar: `Calendars.Read`, `Calendars.ReadWrite`, `offline_access`
- Both: `openid`, `profile`, `email`, `User.Read`

The credential vault uses `graphExchangeAuthorizationCode` for the
code → token exchange and `graphRefreshToken` for refresh.
Graph refresh tokens are rotated on every refresh; the vault
**must** update its stored refresh token on every successful
refresh response.

#### Webhook

Microsoft Graph change notifications are managed with a
`subscription` resource. The control plane creates the
subscription on account link and renews it before the expiry
(Graph subscriptions last up to 3 days for mail, 1 day for
calendar). The connector's `processLifecycle` decodes the
`lifecycleEvent` (`reauthorizationRequired` /
`subscriptionRemoved` / `missed`); the gateway reacts by
re-creating the subscription or alerting the user.

Signature verification: Graph does not sign the webhook body. The
gateway must verify the `clientState` field with
`verifyGraphClientState`. For the initial subscription creation,
Graph echoes the `validationToken` query parameter back; the
control plane responds with `text/plain` of the token.

#### Rate-limit policy

- 60 units / 60s per account.
- `mail.send` / `events.create` cost 5 units each (Graph has a
  per-app throttle tier).
- `429` responses include a `Retry-After` header which the
  connector surfaces as `rate_limited.retry_after_ms`.

#### Reauth

`400 invalid_grant` on refresh → `reauth_required` and the
gateway refuses subsequent calls until the user re-links.

#### Failure modes

- `401`/`403` → `unauthorized`. The vault invalidates the access
  token and the next call refreshes.
- `404` → `not_found`.
- `410 Gone` on a delta query → `reauth_required` (full re-sync
  required).
- `429` → `rate_limited`.
- `5xx` → `provider_error`.

### 2.4 Generic IMAP (`imap`)

#### Setup

IMAP is wire-protocol. The connector takes an
`ImapClient` factory and a credential resolver. Production wires
`imapflow` (https://github.com/postalsys/imapflow) and points it
at the workspace-supplied host/port/credentials.

For iCloud specifically, `connectors/icloud/index.ts > icloudImapCredentials`
returns the canonical iCloud configuration
(`imap.mail.me.com:993`, TLS, app-specific password).

#### Webhook

IMAP IDLE. The connector surfaces a `connectIdle` method that
issues an `IMAP IDLE` command and returns when the server
notifies a change. The gateway translates the notification to a
`mail.list` with the stored `modseq` and merges deltas.

#### Rate-limit policy

- 30 units / 60s per account.
- `mail.send` (via SMTP) costs 5 units. The connector does **not**
  bundle an SMTP client; the gateway wires an SMTP client
  factory at construction time (production: `smtp-connection`
  or `nodemailer`).

#### Reauth

The connector raises `reauth_required` on `AUTHENTICATIONFAILED`
or `LOGIN Failed` server responses. The credential vault
surfaces the error to the control plane; the agent presents a
re-link prompt.

#### Failure modes

- `AUTHENTICATIONFAILED` → `reauth_required`.
- `SELECT` failure on a missing mailbox → `not_found`.
- Network/DNS failure → `provider_unavailable` (gateway retries
  with backoff).

### 2.5 CalDAV (`caldav`) and iCloud CalDAV (`icloud` calendar)

#### Setup

CalDAV is wire-protocol. The connector takes a `CalDavRequestFn`
and a credential resolver. Production wires `tsdav` or
`dav-http.js` and points it at the workspace-supplied principal
URL.

For iCloud, `connectors/icloud/index.ts > icloudCalDavCredentials`
returns the iCloud configuration
(`https://caldav.icloud.com:443/<apple-id>/principal/`).

#### Webhook

CalDAV `sync-collection` (RFC 6578). The connector issues a
`REPORT` with the stored `sync-token`; the server returns the
`multistatus` and a new `sync-token` for the next call.

#### Rate-limit policy

- 30 units / 60s per account.
- `events.create` / `events.update` / `events.delete` cost 5
  units each.

#### Reauth

`401`/`403` on `PROPFIND` for the principal URL → `unauthorized`
on the first call, `reauth_required` after the credential vault
rejects the password on retry. The iCloud app-specific password
flow is the only path that does not require a re-link when the
user rotates the password.

#### Failure modes

- `401`/`403` → `unauthorized`.
- `404` on `events.get` → `not_found`.
- `410 Gone` on a `sync-collection` REPORT → `reauth_required`
  (the sync token expired; the next call performs a full sync).
- `412 Precondition Failed` on `PUT` → `idempotency_conflict` (the
  etag did not match).

### 2.6 WhatsApp Cloud (`whatsapp`)

#### Setup

The Meta Business Suite issues a system-user access token. The
control plane stores the token in the credential vault. The
connector is constructed with the workspace's WhatsApp Business
phone number id.

#### Webhook

Meta webhook. The gateway verifies the signature with
`webhooks/signatures > verifyMetaSignature` (HMAC-SHA256,
`X-Hub-Signature-256: sha256=<hex>`). The legacy `sha1` form is
accepted only when `allow_sha1` is true on the verifier.

#### Rate-limit policy

- 80 units / 60s per account.
- `dm.send` costs 5 units.
- A failed `dm.send` **outside** the 24h CSW must be re-issued as
  a template message; the connector does not enforce the
  window itself — the gateway checks
  `Conversation.window_open_until` and returns
  `provider_error` if the window is closed.

#### Reauth

A `401` on the API call (system-user token expired or revoked)
→ `unauthorized`. The credential vault attempts a refresh; if
the refresh fails, the gateway flips the reauth flag.

#### Failure modes

- `400` with `error.code = 100` (rate limit) → `rate_limited`
  (Meta returns a per-second budget; the gateway respects the
  per-minute budget and surfaces `429` for short bursts).
- `400` with `error.code = 131049` (CSW closed) → `provider_error`
  with a hint to retry with a template.

### 2.7 Instagram (`instagram`)

Same shape as WhatsApp: same webhook signature, same Meta
Platform, same 24h CSW. The connector is constructed with the
Instagram page id (not the phone number id).

### 2.8 Telegram (`telegram`)

#### Setup

`@BotFather` issues a bot token. The credential vault stores it.
The connector calls `getUpdates` to enumerate known chats (the
Telegram API does not provide a chat list endpoint).

#### Webhook

`setWebhook` is called with a `secret_token` (chosen by the
control plane). The gateway verifies the
`X-Telegram-Bot-Api-Secret-Token` header with
`verifyTelegramSecretToken`. The
`processUpdate` method decodes the payload and returns the
parsed update.

#### Rate-limit policy

Telegram publishes a per-chat rate limit of "no more than one
message per second per chat". The connector's policy is
`30 units / 1s` to give the gateway a buffer; `dm.send` cost is
1.

#### Reauth

The bot token does not expire unless revoked. The credential
vault checks the bot's `getMe` result on every refresh attempt;
a failure → `reauth_required` with a hint to re-issue the token
via `@BotFather`.

### 2.9 Discord (`discord`)

#### Setup

The Discord developer portal issues a bot token. The connector
calls `users/@me/channels` to enumerate DM channels.

#### Webhook

Discord Interactions Endpoint URL is signed with Ed25519. The
gateway verifies with `verifyDiscordSignature` (see the
`webhooks/signatures > verifyDiscordSignature` reference for
the Node `crypto` verify path). The `processInteraction` method
decodes the payload; the gateway must respond to a
`type: 1` (PING) interaction with `{ type: 1 }` (PONG) within
3 seconds.

#### Rate-limit policy

Discord publishes a global rate limit of `5/s` per route. The
connector's policy is `5 units / 1s`.

#### Reauth

A `401` on any call → `unauthorized`. Discord bot tokens do not
refresh; the user must re-issue the token in the developer
portal and the gateway surfaces `reauth_required`.

### 2.10 Slack (`slack`)

#### Setup

A Slack app's "Bot User OAuth Token" (`xoxb-...`) is stored in
the credential vault. The required scopes are documented in
`connectors/slack/index.ts` (`chat:write`, `im:history`,
`im:read`, `channels:read`, `groups:read`, `mpim:read`,
`users:read`).

#### Webhook

Slack Events API. The gateway verifies the `X-Slack-Signature`
and `X-Slack-Request-Timestamp` headers with
`webhooks/signatures > verifySlackSignature`. The signature is
`v0=<base64>` of HMAC-SHA256 over `v0:<ts>:<raw body>`. The
timestamp must be within 5 minutes of `now` to defeat replays.

The Slack Events API also has a one-time `url_verification`
challenge. The control plane responds with `{ challenge:
<value> }` in plain text on the first request.

#### Rate-limit policy

60 units / 60s per workspace.

#### Reauth

A `401 invalid_auth` on any call → `reauth_required`. Slack
tokens are rotated; the control plane prompts the user to
re-install the app.

## 3. Cross-cutting concerns

### 3.1 Rate-limit policies

The per-provider policies live in
`store/rate-limit-policy.ts > DEFAULT_RATE_LIMIT_POLICIES`.
The gateway merges any operator overrides from
`ConnectorGatewayOptions.rate_limit_policies` and constructs one
`RateLimitBudget` per account on first dispatch.

The audit entry for a `rate_limited` denial includes the
`retry_after_ms` and the `cost` the connector requested.

### 3.2 Reauth tracking

The `ReauthTracker` is a per-process map of `account_id` →
`ReauthInfo { at, reason }`. The gateway refuses to dispatch a
call when the account is in `reauth_required` state. The
connector is responsible for flipping the flag via
`ReauthTracker.markReauthRequired(accountId, reason)` on a
detected `invalid_grant` / equivalent.

The FagaOS control plane reads the reauth state on a periodic
`control-plane/accounts/list` to render the re-link prompt.
The flag is cleared with `ReauthTracker.clear(accountId)` after
a successful re-link.

### 3.3 Webhook signature verification

`webhooks/signatures.ts` is the single source of truth for
signature verification. Every transport MUST call the matching
verifier before handing the parsed body to the connector. The
verifiers raise `ConnectorError` with code
`webhook_signature_invalid` on failure; the transport returns
`401` to the upstream and emits a `deny` audit entry.

### 3.4 Idempotency

The gateway stores the response under the supplied
`idempotency_key` for 24h. A replay with the same key and
the same request body returns the stored response and emits an
audit entry marked `replay: true`. A replay with the same key
and a different body returns `idempotency_conflict`.

For providers that support provider-side idempotency keys
(Stripe, Slack `chat.postMessage`), the connector MUST pass the
gateway's `idempotency_key` through to the provider so the
provider can dedupe retries on its own side.

## 4. Staging-account validation

The Phase 1 QA harness (`packages/qa-harness`) exercises every
connector against a mocked `fetch`. Phase 2 adds per-provider
**staging-account** fixtures:

| Provider            | Staging account type         | Credential             | Reset cadence          |
| ------------------- | ---------------------------- | ---------------------- | ---------------------- |
| Gmail               | Workspace Google account     | OAuth refresh token    | Per test run           |
| Google Calendar     | Same Google account          | Same refresh token     | Per test run           |
| Outlook (mail)      | M365 dev tenant account      | OAuth refresh token    | Weekly                 |
| Outlook (calendar)  | Same M365 dev tenant account | Same refresh token     | Weekly                 |
| IMAP / iCloud       | Dovecot in Docker            | Test user + password   | Per test run           |
| CalDAV / iCloud     | Radicale in Docker           | Test user + password   | Per test run           |
| WhatsApp Cloud      | Meta test business           | System user token      | Per test run           |
| Instagram           | Meta test business           | Page token             | Per test run           |
| Telegram            | `@BotFather` test bot        | Bot token              | Per test run           |
| Discord             | Discord test application     | Bot token              | Per test run           |
| Slack               | Slack test workspace         | `xoxb-` bot token      | Per test run           |

The staging account wiring lives in
`packages/qa-harness/tests/connectors/`. A test run provisions
the fixture, links it to a workspace, runs the connector
contract suite, and tears the fixture down.

## 5. Open follow-up issues

- `FAG-21` durable control-plane state — already in `done`. The
  reauth flag and the sync-token are persisted by the
  `ReauthTracker` and the gateway; Phase 3 will move both to
  the durable control plane.
- `FAG-24` policy, secrets, capability hardening — `in_progress`.
  The capability check (`tokenAuthorizes`) is the only
  authorisation layer; the policy engine slots in here.
- `FAG-26` desktop browser productionization — `in_review`.
  Affects the iCloud app-specific-password flow only.
- `FAG-22` PR flow rebase (FAG-111) — `todo`. Blocks the FAG-25
  PR from merging into `main`; not a code-level blocker.
- `FAG-32` onboarding — `blocked`. The "first time the user
  links Gmail" UI consumes the `productionAuthorizationUrl`
  helper directly.
- `FAG-33` UI read model — `blocked`. The "accounts list" view
  reads from the durable account store (FAG-21).
