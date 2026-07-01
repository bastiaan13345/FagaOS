/**
 * Zod schemas + TypeScript types for the control-plane HTTP API.
 *
 * These mirror the canonical `docs/api/control-plane.openapi.yaml` so the
 * web app can validate every response at runtime. The AgentCard schema is
 * a permissive structural copy — the canonical schema lives in
 * @fagaos/agent-manifest and is used by the control plane. The web app
 * only needs to pass AgentCard payloads through to the API; the server
 * is the source of truth for the contract.
 */
import { z } from 'zod';

const IsoDateTime = z.string().min(1);

export const AgentCardSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string().optional(),
    version: z.string(),
    owner: z
      .object({
        id: z.string(),
        name: z.string().optional(),
      })
      .passthrough(),
    auth: z.unknown(),
    capabilities: z.array(z.object({ name: z.string() }).passthrough()).default([]),
    toolServers: z.array(z.unknown()).optional(),
    mcpEndpoints: z.array(z.unknown()).optional(),
  })
  .passthrough();

export const CapabilityCheckSchema = z.object({
  ok: z.boolean(),
  policyId: z.string().optional(),
  reason: z.string().optional(),
});

const ActorRefSchema = z.object({
  id: z.string(),
  type: z.enum(['user', 'agent', 'system']),
});

export const SessionStateSchema = z.enum([
  'pending',
  'running',
  'suspended',
  'completed',
  'killed',
  'crashed',
]);

export const SessionSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  agentVersion: z.string(),
  agentCardHash: z.string(),
  state: SessionStateSchema,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  createdBy: ActorRefSchema,
  input: z.record(z.unknown()).optional(),
  result: z.record(z.unknown()).nullable().optional(),
  terminalReason: z.string().nullable().optional(),
});

export const TaskStateSchema = z.enum([
  'queued',
  'claimed',
  'completed',
  'failed',
  'cancelled',
]);

export const TaskSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  tool: z.string(),
  arguments: z.record(z.unknown()).default({}),
  state: TaskStateSchema,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  scheduledAt: IsoDateTime,
  claimedAt: IsoDateTime.nullable().optional(),
  claimedBy: z.string().nullable().optional(),
  leaseExpiresAt: IsoDateTime.nullable().optional(),
  attempt: z.number().int().min(0),
  maxAttempts: z.number().int().min(1),
  result: z.record(z.unknown()).nullable().optional(),
  terminalReason: z.string().nullable().optional(),
  createdBy: ActorRefSchema,
  auditCorrelationId: z.string(),
  capabilityCheck: CapabilityCheckSchema,
});

export const ToolResultSchema = z.object({
  ok: z.boolean(),
  result: z.record(z.unknown()).nullable().optional(),
  error: z.string().nullable().optional(),
  durationMs: z.number().int().min(0),
  correlationId: z.string(),
});

export const AuditEntrySchema = z
  .object({
    id: z.string(),
    seq: z.number().int().min(0),
    ts: IsoDateTime,
    actor: z.object({
      id: z.string(),
      type: z.enum(['agent', 'user', 'system']),
    }),
    action: z.string(),
    resource: z.object({
      kind: z.string(),
      id: z.string(),
    }),
    data: z.record(z.unknown()),
    prevHash: z.string().regex(/^[0-9a-f]{64}$/),
    hash: z.string().regex(/^[0-9a-f]{64}$/),
    signedCheckpoint: z.object({
      algorithm: z.literal('ed25519-stub-v1'),
      payload: z.string(),
      signature: z.string(),
    }),
  })
  .passthrough();

export const OkSchema = z.object({ ok: z.literal(true) });

export const ErrorSchema = z.object({
  error: z.string(),
  message: z.string(),
});

export const HealthSchema = z
  .object({
    ok: z.boolean(),
    contract: z.string().optional(),
    service: z.string().optional(),
    uptimeSec: z.number().optional(),
  })
  .passthrough();

export const CreateSessionRequestSchema = z.object({
  agentId: z.string(),
  createdBy: ActorRefSchema,
  input: z.record(z.unknown()).optional(),
  agentCard: AgentCardSchema.optional(),
});

export const InvokeToolRequestSchema = z.object({
  arguments: z.record(z.unknown()).optional(),
});

export const KillRequestSchema = z.object({
  reason: z.string().optional(),
});

export const EnqueueTaskRequestSchema = z.object({
  sessionId: z.string(),
  tool: z.string(),
  arguments: z.record(z.unknown()).optional(),
  createdBy: ActorRefSchema,
  auditCorrelationId: z.string().optional(),
  maxAttempts: z.number().int().min(1).optional(),
  scheduledAt: IsoDateTime.optional(),
  capabilityCheck: CapabilityCheckSchema,
});

export const ClaimTaskRequestSchema = z.object({
  workerId: z.string(),
  leaseMs: z.number().int().min(1),
});

export const CompleteTaskRequestSchema = z.object({
  workerId: z.string(),
  result: z.record(z.unknown()).optional(),
});

export const FailTaskRequestSchema = z.object({
  workerId: z.string(),
  error: z.string(),
  retryDelayMs: z.number().int().min(0).optional(),
});

export const CancelTaskRequestSchema = z.object({
  reason: z.string().optional(),
  actor: ActorRefSchema.optional(),
});

export type AgentCard = z.infer<typeof AgentCardSchema>;
export type Session = z.infer<typeof SessionSchema>;
export type Task = z.infer<typeof TaskSchema>;
export type ToolResult = z.infer<typeof ToolResultSchema>;
export type AuditEntry = z.infer<typeof AuditEntrySchema>;
export type Health = z.infer<typeof HealthSchema>;
export type CreateSessionRequest = z.infer<typeof CreateSessionRequestSchema>;
export type InvokeToolRequest = z.infer<typeof InvokeToolRequestSchema>;
export type KillRequest = z.infer<typeof KillRequestSchema>;
export type EnqueueTaskRequest = z.infer<typeof EnqueueTaskRequestSchema>;
export type ClaimTaskRequest = z.infer<typeof ClaimTaskRequestSchema>;
export type CompleteTaskRequest = z.infer<typeof CompleteTaskRequestSchema>;
export type FailTaskRequest = z.infer<typeof FailTaskRequestSchema>;
export type CancelTaskRequest = z.infer<typeof CancelTaskRequestSchema>;

export const SessionListResponseSchema = z.object({ session: SessionSchema });
export const TaskResponseSchema = z.object({ task: TaskSchema });
export const ToolResultResponseSchema = z.object({ result: ToolResultSchema });
export const AuditLogResponseSchema = z.object({ entries: z.array(AuditEntrySchema) });
export const TaskClaimResponseSchema = z.object({
  claim: z
    .object({ task: TaskSchema })
    .nullable(),
});
export const TaskRecoverResponseSchema = z.object({ tasks: z.array(TaskSchema) });
