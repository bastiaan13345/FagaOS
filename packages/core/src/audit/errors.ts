/**
 * Custom errors for the audit log. Both inherit from a shared base so callers
 * can catch either with `instanceof AuditLogError`.
 */

export abstract class AuditLogError extends Error {
  abstract readonly code: string;
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** An entry was found whose prevHash does not match the previous entry's entryHash. */
export class AuditChainBrokenError extends AuditLogError {
  readonly code = 'AUDIT_CHAIN_BROKEN' as const;
  constructor(
    public readonly seq: number,
    public readonly expectedPrevHash: string,
    public readonly actualPrevHash: string,
  ) {
    super(
      `Audit chain broken at seq=${seq}: expected prevHash=${expectedPrevHash}, got ${actualPrevHash}`,
    );
  }
}

/** A stored entry's recomputed hash did not match its declared entryHash. */
export class AuditTamperError extends AuditLogError {
  readonly code = 'AUDIT_TAMPER_DETECTED' as const;
  constructor(
    public readonly seq: number,
    public readonly declaredHash: string,
    public readonly recomputedHash: string,
  ) {
    super(
      `Audit entry tampered at seq=${seq}: declared=${declaredHash}, recomputed=${recomputedHash}`,
    );
  }
}

/** A signature could not be verified. */
export class AuditCheckpointSignatureError extends AuditLogError {
  readonly code = 'AUDIT_CHECKPOINT_INVALID' as const;
  constructor(
    public readonly seq: number,
    public readonly keyId: string,
  ) {
    super(`Audit checkpoint signature invalid at seq=${seq} (keyId=${keyId})`);
  }
}

/** Caller tried to do something the log does not support, e.g. update an entry. */
export class AuditLogUnsupportedError extends AuditLogError {
  readonly code = 'AUDIT_UNSUPPORTED' as const;
  constructor(message: string) {
    super(message);
  }
}
