import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { SessionSchema, ToolInvocationRecordSchema, type Session, type ToolInvocationRecord } from './types.js';

export const ControlPlaneTaskStateSchema = z.enum([
  'queued',
  'claimed',
  'completed',
  'failed',
  'cancelled',
]);
export type ControlPlaneTaskState = z.infer<typeof ControlPlaneTaskStateSchema>;

export const CapabilityCheckOutcomeSchema = z.object({
  ok: z.boolean(),
  policyId: z.string().min(1).optional(),
  reason: z.string().min(1).optional(),
});
export type CapabilityCheckOutcome = z.infer<typeof CapabilityCheckOutcomeSchema>;

export const ControlPlaneTaskSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  tool: z.string().min(1),
  arguments: z.record(z.unknown()),
  state: ControlPlaneTaskStateSchema,
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  scheduledAt: z.string().min(1),
  claimedAt: z.string().min(1).nullable(),
  claimedBy: z.string().min(1).nullable(),
  leaseExpiresAt: z.string().min(1).nullable(),
  attempt: z.number().int().nonnegative(),
  maxAttempts: z.number().int().positive(),
  result: z.record(z.unknown()).nullable(),
  terminalReason: z.string().min(1).nullable(),
  createdBy: z.object({
    id: z.string().min(1),
    type: z.enum(['user', 'agent', 'system']),
  }),
  auditCorrelationId: z.string().min(1),
  capabilityCheck: CapabilityCheckOutcomeSchema,
});
export type ControlPlaneTask = z.infer<typeof ControlPlaneTaskSchema>;

const ControlPlaneRepositoryStateSchema = z.object({
  version: z.literal(1),
  sessions: z.array(SessionSchema),
  tasks: z.array(ControlPlaneTaskSchema),
  toolInvocations: z.array(ToolInvocationRecordSchema),
});

export interface ControlPlaneRepositoryState {
  version: 1;
  sessions: Session[];
  tasks: ControlPlaneTask[];
  toolInvocations: ToolInvocationRecord[];
}

export interface ControlPlaneRepository {
  getSession(id: string): Session | undefined;
  listSessions(): Session[];
  saveSession(session: Session): Promise<void>;
  deleteSession(id: string): Promise<void>;
  getTask(id: string): ControlPlaneTask | undefined;
  listTasks(): ControlPlaneTask[];
  saveTask(task: ControlPlaneTask): Promise<void>;
  listToolInvocations(): ToolInvocationRecord[];
  saveToolInvocation(record: ToolInvocationRecord): Promise<void>;
}

function emptyState(): ControlPlaneRepositoryState {
  return {
    version: 1,
    sessions: [],
    tasks: [],
    toolInvocations: [],
  };
}

function cloneState(state: ControlPlaneRepositoryState): ControlPlaneRepositoryState {
  return {
    version: 1,
    sessions: state.sessions.map((s) => ({ ...s, createdBy: { ...s.createdBy }, input: { ...s.input }, result: s.result ? { ...s.result } : null })),
    tasks: state.tasks.map((t) => ({
      ...t,
      arguments: { ...t.arguments },
      result: t.result ? { ...t.result } : null,
      createdBy: { ...t.createdBy },
      capabilityCheck: { ...t.capabilityCheck },
    })),
    toolInvocations: state.toolInvocations.map((r) => ({
      ...r,
      arguments: { ...r.arguments },
      result: r.result ? { ...r.result } : null,
    })),
  };
}

export class InMemoryControlPlaneRepository implements ControlPlaneRepository {
  protected state: ControlPlaneRepositoryState;

  constructor(initialState: ControlPlaneRepositoryState = emptyState()) {
    this.state = cloneState(initialState);
  }

  getSession(id: string): Session | undefined {
    const session = this.state.sessions.find((s) => s.id === id);
    return session ? { ...session, createdBy: { ...session.createdBy }, input: { ...session.input }, result: session.result ? { ...session.result } : null } : undefined;
  }

  listSessions(): Session[] {
    return cloneState(this.state).sessions;
  }

  async saveSession(session: Session): Promise<void> {
    const parsed = SessionSchema.parse(session);
    this.upsert('sessions', parsed);
    await this.flush();
  }

  async deleteSession(id: string): Promise<void> {
    this.state.sessions = this.state.sessions.filter((s) => s.id !== id);
    await this.flush();
  }

  getTask(id: string): ControlPlaneTask | undefined {
    const task = this.state.tasks.find((t) => t.id === id);
    if (!task) return undefined;
    return cloneState({ ...emptyState(), tasks: [task] }).tasks[0];
  }

  listTasks(): ControlPlaneTask[] {
    return cloneState(this.state).tasks;
  }

  async saveTask(task: ControlPlaneTask): Promise<void> {
    const parsed = ControlPlaneTaskSchema.parse(task);
    this.upsert('tasks', parsed);
    await this.flush();
  }

  listToolInvocations(): ToolInvocationRecord[] {
    return cloneState(this.state).toolInvocations;
  }

  async saveToolInvocation(record: ToolInvocationRecord): Promise<void> {
    const parsed = ToolInvocationRecordSchema.parse(record);
    this.state.toolInvocations = [...this.state.toolInvocations, parsed];
    await this.flush();
  }

  protected async flush(): Promise<void> {
    // In-memory repository has nothing to flush.
  }

  protected snapshot(): ControlPlaneRepositoryState {
    return cloneState(this.state);
  }

  private upsert<T extends { id: string }>(key: 'sessions' | 'tasks', value: T): void {
    const existing = this.state[key].findIndex((item) => item.id === value.id);
    if (existing >= 0) {
      this.state[key][existing] = value as never;
    } else {
      this.state[key] = [...this.state[key], value] as never;
    }
  }
}

export interface JsonFileControlPlaneRepositoryOptions {
  filePath: string;
}

export class JsonFileControlPlaneRepository extends InMemoryControlPlaneRepository {
  private readonly filePath: string;

  constructor(opts: JsonFileControlPlaneRepositoryOptions) {
    super(loadStateSync(opts.filePath));
    this.filePath = opts.filePath;
  }

  protected override async flush(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${randomUUID()}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(this.snapshot(), null, 2)}\n`, 'utf8');
    await rename(tempPath, this.filePath);
  }
}

function loadStateSync(filePath: string): ControlPlaneRepositoryState {
  try {
    if (!existsSync(filePath)) return emptyState();
    const raw = readFileSync(filePath, 'utf8');
    if (!raw.trim()) return emptyState();
    return ControlPlaneRepositoryStateSchema.parse(JSON.parse(raw));
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') return emptyState();
    throw e;
  }
}

export async function loadControlPlaneRepositoryState(
  filePath: string,
): Promise<ControlPlaneRepositoryState> {
  try {
    const raw = await readFile(filePath, 'utf8');
    if (!raw.trim()) return emptyState();
    return ControlPlaneRepositoryStateSchema.parse(JSON.parse(raw));
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') return emptyState();
    throw e;
  }
}
