import { z } from 'zod';

export const ActorSchema = z.object({
  id: z.string().min(1),
  type: z.enum(['user', 'agent', 'system']),
});
export type Actor = z.infer<typeof ActorSchema>;

export const SessionStateSchema = z.enum([
  'pending',
  'running',
  'suspended',
  'completed',
  'killed',
  'crashed',
]);
export type SessionState = z.infer<typeof SessionStateSchema>;

export const SessionSchema = z.object({
  id: z.string().min(1),
  agentId: z.string().min(1),
  agentVersion: z.string().min(1),
  agentCardHash: z.string().min(1),
  state: SessionStateSchema,
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  createdBy: ActorSchema,
  input: z.record(z.unknown()),
  result: z.record(z.unknown()).nullable(),
  terminalReason: z.string().min(1).nullable(),
});
export type Session = z.infer<typeof SessionSchema>;
export type SessionId = string;

export const ToolInvocationRecordSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  tool: z.string().min(1),
  arguments: z.record(z.unknown()),
  ok: z.boolean(),
  result: z.record(z.unknown()).nullable(),
  error: z.string().nullable(),
  durationMs: z.number().nonnegative(),
  correlationId: z.string().min(1),
  createdAt: z.string().min(1),
  auditCorrelationId: z.string().min(1),
});
export type ToolInvocationRecord = z.infer<typeof ToolInvocationRecordSchema>;
