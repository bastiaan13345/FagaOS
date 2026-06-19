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

export const ApprovalStateSchema = z.enum([
  'requested',
  'viewed',
  'approved',
  'denied',
  'edited',
  'expired',
  'cancelled',
  'superseded',
  'executed',
  'failed',
]);
export type ApprovalState = z.infer<typeof ApprovalStateSchema>;

export const ApprovalEvidenceSchema = z.object({
  kind: z.string().min(1),
  id: z.string().min(1),
  summary: z.string().min(1),
});
export type ApprovalEvidence = z.infer<typeof ApprovalEvidenceSchema>;

export const ApprovalResourceSchema = z.object({
  kind: z.string().min(1),
  id: z.string().min(1),
});
export type ApprovalResource = z.infer<typeof ApprovalResourceSchema>;

export const ApprovalDecisionSchema = z.object({
  actor: ActorSchema,
  decidedAt: z.string().min(1),
  reason: z.string().min(1).nullable(),
});
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;

export const ApprovalRequestSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  taskId: z.string().min(1).nullable(),
  toolCallId: z.string().min(1).nullable(),
  state: ApprovalStateSchema,
  requestedBy: ActorSchema,
  riskReason: z.string().min(1),
  proposedAction: z.string().min(1),
  editedAction: z.string().min(1).nullable(),
  sourceEvidence: z.array(ApprovalEvidenceSchema),
  affectedResource: ApprovalResourceSchema,
  timeoutAt: z.string().min(1),
  policyRule: z.string().min(1),
  auditCorrelationId: z.string().min(1),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  decision: ApprovalDecisionSchema.nullable(),
  supersededBy: z.string().min(1).nullable(),
  escalationReason: z.string().min(1).nullable(),
});
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;

export const NotificationSeveritySchema = z.enum(['info', 'warning', 'error', 'critical']);
export type NotificationSeverity = z.infer<typeof NotificationSeveritySchema>;

export const NotificationTopicSchema = z.enum([
  'approvals',
  'failures',
  'reauth_needs',
  'policy_denials',
  'long_running_stalls',
  'human_takeover_requests',
]);
export type NotificationTopic = z.infer<typeof NotificationTopicSchema>;

export const NotificationChannelSchema = z.enum(['local_dev']);
export type NotificationChannel = z.infer<typeof NotificationChannelSchema>;

export const NotificationPreferenceSchema = z.object({
  topic: NotificationTopicSchema,
  severity: NotificationSeveritySchema,
  channels: z.array(NotificationChannelSchema).min(1),
  enabled: z.boolean(),
});
export type NotificationPreference = z.infer<typeof NotificationPreferenceSchema>;

export const LocalNotificationSchema = z.object({
  id: z.string().min(1),
  topic: NotificationTopicSchema,
  channel: NotificationChannelSchema,
  severity: NotificationSeveritySchema,
  title: z.string().min(1),
  body: z.string().min(1),
  dedupeKey: z.string().min(1),
  resource: ApprovalResourceSchema,
  approvalId: z.string().min(1).nullable(),
  auditCorrelationId: z.string().min(1),
  createdAt: z.string().min(1),
});
export type LocalNotification = z.infer<typeof LocalNotificationSchema>;
