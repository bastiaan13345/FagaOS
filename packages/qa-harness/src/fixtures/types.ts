/**
 * Common shape for provider webhook/update fixtures.
 */
export interface WebhookFixture {
  /** Provider id, e.g. "gmail" or "telegram". */
  provider: 'gmail' | 'graph' | 'meta' | 'telegram' | 'discord';
  /** The exact raw body bytes (UTF-8) the provider would send. */
  rawBody: string;
  /** Headers the provider would send, for completeness. */
  headers: Record<string, string>;
  /** Parsed shape for convenience in tests. */
  parsed: unknown;
}
