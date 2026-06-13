/**
 * @fagaos/connectors — connector gateway for email, messaging, and calendar.
 *
 * Phase 1 (FAG-11) ships the connector skeleton: the normalised model,
 * the gateway surface (`ConnectorGateway`), stub connectors, and the
 * first two real read-only connectors (Gmail + Google Calendar) behind
 * feature flags.
 *
 * The package is the seam between the FagaOS agent runtime and the
 * outside world. The runtime only ever sees the normalised shapes in
 * `models/`, the capability check in `capability.ts`, and the gateway
 * surface in `gateway/`. Concrete provider details (OAuth flows,
 * Pub/Sub payloads, XOAUTH2 SASL, etc.) are confined to `connectors/`.
 *
 * See `docs/connectors.md` for the architecture and the OpenAPI spec
 * for the wire shape.
 */
export * from './models/index.js';
export * from './errors.js';
export * from './capability.js';
export * from './connector.js';
export * from './store/index.js';
export * from './features/index.js';
export * from './oauth/index.js';
export * from './webhooks/index.js';
export * from './gateway/index.js';
export * from './connectors/index.js';

/** Phase 0 contract surface retained for compatibility. */
export const CONNECTORS_NOT_IMPLEMENTED =
  'Concrete connector implementations ship in FAG-11 follow-ups (Outlook, IMAP, WhatsApp, Instagram, Telegram, Discord, Slack, iCloud, CalDAV).';
