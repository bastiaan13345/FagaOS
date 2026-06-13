/**
 * @fagaos/core — orchestration, scheduling, capability broker, and the audit log primitive.
 *
 * Phase 0 scope (FAG-8): audit log only. The orchestrator, scheduler, and broker
 * land in later phases. See ../../../docs/architecture.md for the full design.
 */

export { AuditLog, InMemoryAuditLog, FileBackedAuditLog } from './audit/log.js';
export type {
  AuditEntry,
  AuditCheckpoint,
  AuditActor,
  AuditAction,
  AuditResource,
  AuditQuery,
  AuditVerifyResult,
  CheckpointSigner,
} from './audit/types.js';
export { GENESIS_PREV_HASH } from './audit/types.js';
export { HmacCheckpointSigner, hashEntry, hashChain } from './audit/hash.js';
export { AuditTamperError, AuditChainBrokenError, AuditCheckpointSignatureError } from './audit/errors.js';
