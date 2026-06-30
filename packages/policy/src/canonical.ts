/**
 * Canonical JSON for signing/verification.
 *
 * Two semantically identical capability token bodies must produce the
 * same signature. We sort object keys recursively before stringifying.
 * The function is total over JSON-serialisable values and never
 * reads from global state. Buffers (used for raw secret material
 * inside SecretMaterial) round-trip through their `toJSON()` form so
 * the canonical output is a plain string.
 *
 * Note: this is structurally identical to `canonicalize` in
 * `packages/core/src/audit/hash.ts`; we keep an independent copy
 * here so the policy package does not need to depend on core
 * (which would create a circular reference through the audit log).
 */
export function canonicalize(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function canonicalValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Buffer.isBuffer(value)) return value.toString('hex');
  if (Array.isArray(value)) return value.map(canonicalValue);
  const obj = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = canonicalValue(obj[key]);
  }
  return sorted;
}
