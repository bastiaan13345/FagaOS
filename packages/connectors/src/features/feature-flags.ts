/**
 * Feature flags for connector registration.
 *
 * Real connectors (Gmail, Google Calendar) sit behind a flag. In a
 * production deployment the flag is read from environment / control
 * plane; for Phase 1 the registry accepts a simple `FeatureFlags`
 * object and defaults to "off" for every flag.
 *
 * The set of flags is locked at module load time. The values are
 * read-only from the gateway's perspective: changing them at runtime
 * is a control-plane operation, not a hot-reload.
 *
 * Each flag is also exposed through a runtime check
 * (`isEnabled('gmail', 'mail.list')`) so individual operations can
 * fail fast with a clear `feature_disabled` error before any
 * credential material is touched.
 */
import { z } from 'zod';

export const FeatureFlagSchema = z.enum([
  'gmail',
  'google_calendar',
  'stub_email',
  'stub_calendar',
]);
export type FeatureFlag = z.infer<typeof FeatureFlagSchema>;

const FlagMapSchema = z
  .object({
    gmail: z.boolean().default(false),
    google_calendar: z.boolean().default(false),
    stub_email: z.boolean().default(true),
    stub_calendar: z.boolean().default(true),
  })
  .strict();
export type FeatureFlags = z.infer<typeof FlagMapSchema>;

const TRUE_FLAGS: ReadonlySet<string> = new Set(['1', 'true', 'yes', 'on']);

/**
 * Build a `FeatureFlags` object from raw environment variables. The
 * `FAGAOS_FEATURE_<flag>` env var is consulted for each flag; a value
 * of `1`, `true`, `yes`, or `on` enables it. The stubs default to
 * enabled; the real connectors default to disabled. This matches the
 * Phase 1 stance: tests run on the stubs, the first end-to-end demo
 * flips the real flags on.
 */
export function featureFlagsFromEnv(env: NodeJS.ProcessEnv = process.env): FeatureFlags {
  function read(flag: FeatureFlag, fallback: boolean): boolean {
    const raw = env[`FAGAOS_FEATURE_${flag.toUpperCase()}`];
    if (raw === undefined) return fallback;
    return TRUE_FLAGS.has(raw.toLowerCase());
  }
  return FlagMapSchema.parse({
    gmail: read('gmail', false),
    google_calendar: read('google_calendar', false),
    stub_email: read('stub_email', true),
    stub_calendar: read('stub_calendar', true),
  });
}

/** In-memory holder. Construct once at boot and inject into the gateway. */
export class FeatureFlagRegistry {
  private readonly flags: FeatureFlags;

  constructor(initial: FeatureFlags | NodeJS.ProcessEnv = {}) {
    if (typeof (initial as NodeJS.ProcessEnv)['FAGAOS_FEATURE_GMAIL'] !== 'undefined' ||
        (initial as NodeJS.ProcessEnv)['FAGAOS_FEATURE_STUB_EMAIL'] !== undefined) {
      this.flags = featureFlagsFromEnv(initial as NodeJS.ProcessEnv);
    } else {
      this.flags = FlagMapSchema.parse(initial);
    }
  }

  isEnabled(flag: FeatureFlag): boolean {
    return this.flags[flag];
  }

  snapshot(): FeatureFlags {
    // Defensive copy so callers cannot mutate the registry.
    return { ...this.flags };
  }
}
