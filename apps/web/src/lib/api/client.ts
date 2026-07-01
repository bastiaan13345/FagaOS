/**
 * Typed HTTP client for the FagaOS control-plane API.
 *
 * The client targets `docs/api/control-plane.openapi.yaml`. Every request
 * funnels through `request()`, which validates the response with a Zod
 * schema and throws a `ControlPlaneApiError` on any non-2xx, network, or
 * schema mismatch so the React server components can render a typed error
 * state instead of a string.
 *
 * The base URL is configurable via the `FAGAOS_CONTROL_PLANE_URL`
 * environment variable (read by `getDefaultBaseUrl()`); callers may also
 * pass an explicit `baseUrl` to `createControlPlaneClient()`.
 */
import { z, type ZodTypeAny } from 'zod';
import {
  AuditLogResponseSchema,
  CancelTaskRequestSchema,
  ClaimTaskRequestSchema,
  CompleteTaskRequestSchema,
  CreateSessionRequestSchema,
  EnqueueTaskRequestSchema,
  ErrorSchema,
  FailTaskRequestSchema,
  HealthSchema,
  InvokeToolRequestSchema,
  KillRequestSchema,
  OkSchema,
  SessionListResponseSchema,
  TaskClaimResponseSchema,
  TaskRecoverResponseSchema,
  TaskResponseSchema,
  ToolResultResponseSchema,
  type AgentCard,
  type AuditEntry,
  type CancelTaskRequest,
  type ClaimTaskRequest,
  type CompleteTaskRequest,
  type CreateSessionRequest,
  type EnqueueTaskRequest,
  type FailTaskRequest,
  type Health,
  type InvokeToolRequest,
  type KillRequest,
  type Session,
  type Task,
  type ToolResult,
} from './types';

export class ControlPlaneApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly path: string;
  override readonly cause?: unknown;

  constructor(opts: {
    code: string;
    message: string;
    status: number;
    path: string;
    cause?: unknown;
  }) {
    super(opts.message);
    this.name = 'ControlPlaneApiError';
    this.code = opts.code;
    this.status = opts.status;
    this.path = opts.path;
    if (opts.cause !== undefined) {
      this.cause = opts.cause;
    }
  }
}

export interface ControlPlaneClientConfig {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  /** Optional request timeout in milliseconds. */
  timeoutMs?: number;
}

export interface ControlPlaneClient {
  baseUrl: string;
  health(): Promise<Health>;
  createSession(input: CreateSessionRequest): Promise<Session>;
  getSession(id: string): Promise<Session>;
  deleteSession(id: string): Promise<void>;
  invokeTool(sessionId: string, tool: string, input: InvokeToolRequest): Promise<ToolResult>;
  killSession(id: string, input?: KillRequest): Promise<void>;
  getSessionAuditLog(id: string, opts?: { sinceSeq?: number; limit?: number }): Promise<AuditEntry[]>;
  registerCard(card: AgentCard): Promise<void>;
  enqueueTask(input: EnqueueTaskRequest): Promise<Task>;
  claimTask(input: ClaimTaskRequest): Promise<Task | null>;
  recoverTasks(): Promise<Task[]>;
  getTask(id: string): Promise<Task>;
  heartbeatTask(id: string, input: ClaimTaskRequest): Promise<Task>;
  completeTask(id: string, input: CompleteTaskRequest): Promise<Task>;
  failTask(id: string, input: FailTaskRequest): Promise<Task>;
  cancelTask(id: string, input?: CancelTaskRequest): Promise<Task>;
}

const DEFAULT_TIMEOUT_MS = 10_000;

export function getDefaultBaseUrl(): string {
  const fromEnv = process.env['FAGAOS_CONTROL_PLANE_URL'];
  if (typeof fromEnv === 'string' && fromEnv.length > 0) {
    return normaliseBaseUrl(fromEnv);
  }
  return 'http://127.0.0.1:8080';
}

function normaliseBaseUrl(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

function buildUrl(baseUrl: string, path: string): string {
  if (path.startsWith('http://') || path.startsWith('https://')) {
    return path;
  }
  const normalisedPath = path.startsWith('/') ? path : `/${path}`;
  return `${normaliseBaseUrl(baseUrl)}${normalisedPath}`;
}

async function parseErrorBody(res: Response): Promise<{ code: string; message: string }> {
  let payload: unknown = null;
  try {
    payload = await res.json();
  } catch {
    // Non-JSON error body — fall through to a generic message.
  }
  const parsed = ErrorSchema.safeParse(payload);
  if (parsed.success) {
    return { code: parsed.data.error, message: parsed.data.message };
  }
  return {
    code: res.status >= 500 ? 'server_error' : 'request_failed',
    message: res.statusText || `HTTP ${res.status}`,
  };
}

interface RequestOptions<TSchema extends ZodTypeAny> {
  method: 'GET' | 'POST' | 'DELETE';
  path: string;
  schema: TSchema;
  body?: unknown;
  query?: Record<string, string | number | undefined>;
}

async function request<TSchema extends ZodTypeAny>(
  config: ControlPlaneClientConfig,
  options: RequestOptions<TSchema>,
): Promise<z.infer<TSchema>> {
  const fetchImpl = config.fetchImpl ?? fetch;
  const url = new URL(buildUrl(config.baseUrl, options.path));
  if (options.query) {
    for (const [key, value] of Object.entries(options.query)) {
      if (value === undefined) continue;
      url.searchParams.set(key, String(value));
    }
  }

  const headers: Record<string, string> = {
    accept: 'application/json',
  };
  let body: BodyInit | undefined;
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(options.body);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const init: RequestInit = {
    method: options.method,
    headers,
    signal: controller.signal,
  };
  if (body !== undefined) {
    init.body = body;
  }
  let res: Response;
  try {
    res = await fetchImpl(url, init);
  } catch (err) {
    clearTimeout(timer);
    throw new ControlPlaneApiError({
      code: 'network_error',
      message: err instanceof Error ? err.message : 'network request failed',
      status: 0,
      path: options.path,
      cause: err,
    });
  }
  clearTimeout(timer);

  if (!res.ok) {
    const errorBody = await parseErrorBody(res);
    throw new ControlPlaneApiError({
      code: errorBody.code,
      message: errorBody.message,
      status: res.status,
      path: options.path,
    });
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch (err) {
    throw new ControlPlaneApiError({
      code: 'invalid_json',
      message: 'control-plane returned a non-JSON success body',
      status: res.status,
      path: options.path,
      cause: err,
    });
  }

  const parsed = options.schema.safeParse(json);
  if (!parsed.success) {
    throw new ControlPlaneApiError({
      code: 'schema_mismatch',
      message: `control-plane response did not match expected schema: ${parsed.error.message}`,
      status: res.status,
      path: options.path,
      cause: parsed.error,
    });
  }
  return parsed.data;
}

export function createControlPlaneClient(config: ControlPlaneClientConfig): ControlPlaneClient {
  const baseUrl = normaliseBaseUrl(config.baseUrl);

  return {
    baseUrl,

    async health() {
      const data = await request(config, {
        method: 'GET',
        path: '/healthz',
        schema: HealthSchema,
      });
      return data;
    },

    async createSession(input) {
      const parsed = CreateSessionRequestSchema.parse(input);
      const data = await request(config, {
        method: 'POST',
        path: '/sessions',
        schema: SessionListResponseSchema,
        body: parsed,
      });
      return data.session;
    },

    async getSession(id) {
      const data = await request(config, {
        method: 'GET',
        path: `/sessions/${encodeURIComponent(id)}`,
        schema: SessionListResponseSchema,
      });
      return data.session;
    },

    async deleteSession(id) {
      await request(config, {
        method: 'DELETE',
        path: `/sessions/${encodeURIComponent(id)}`,
        schema: OkSchema,
      });
    },

    async invokeTool(sessionId, tool, input) {
      const parsed = InvokeToolRequestSchema.parse(input);
      const data = await request(config, {
        method: 'POST',
        path: `/sessions/${encodeURIComponent(sessionId)}/tools/${encodeURIComponent(tool)}`,
        schema: ToolResultResponseSchema,
        body: parsed,
      });
      return data.result;
    },

    async killSession(id, input) {
      const parsed = KillRequestSchema.parse(input ?? {});
      await request(config, {
        method: 'POST',
        path: `/sessions/${encodeURIComponent(id)}/kill`,
        schema: OkSchema,
        body: parsed,
      });
    },

    async getSessionAuditLog(id, opts) {
      const data = await request(config, {
        method: 'GET',
        path: `/sessions/${encodeURIComponent(id)}/log`,
        schema: AuditLogResponseSchema,
        query: {
          sinceSeq: opts?.sinceSeq,
          limit: opts?.limit,
        },
      });
      return data.entries;
    },

    async registerCard(card) {
      await request(config, {
        method: 'POST',
        path: '/cards',
        schema: OkSchema,
        body: card,
      });
    },

    async enqueueTask(input) {
      const parsed = EnqueueTaskRequestSchema.parse(input);
      const data = await request(config, {
        method: 'POST',
        path: '/tasks',
        schema: TaskResponseSchema,
        body: parsed,
      });
      return data.task;
    },

    async claimTask(input) {
      const parsed = ClaimTaskRequestSchema.parse(input);
      const data = await request(config, {
        method: 'POST',
        path: '/tasks/claim',
        schema: TaskClaimResponseSchema,
        body: parsed,
      });
      return data.claim ? data.claim.task : null;
    },

    async recoverTasks() {
      const data = await request(config, {
        method: 'POST',
        path: '/tasks/recover',
        schema: TaskRecoverResponseSchema,
      });
      return data.tasks;
    },

    async getTask(id) {
      const data = await request(config, {
        method: 'GET',
        path: `/tasks/${encodeURIComponent(id)}`,
        schema: TaskResponseSchema,
      });
      return data.task;
    },

    async heartbeatTask(id, input) {
      const parsed = ClaimTaskRequestSchema.parse(input);
      const data = await request(config, {
        method: 'POST',
        path: `/tasks/${encodeURIComponent(id)}/heartbeat`,
        schema: TaskResponseSchema,
        body: parsed,
      });
      return data.task;
    },

    async completeTask(id, input) {
      const parsed = CompleteTaskRequestSchema.parse(input);
      const data = await request(config, {
        method: 'POST',
        path: `/tasks/${encodeURIComponent(id)}/complete`,
        schema: TaskResponseSchema,
        body: parsed,
      });
      return data.task;
    },

    async failTask(id, input) {
      const parsed = FailTaskRequestSchema.parse(input);
      const data = await request(config, {
        method: 'POST',
        path: `/tasks/${encodeURIComponent(id)}/fail`,
        schema: TaskResponseSchema,
        body: parsed,
      });
      return data.task;
    },

    async cancelTask(id, input) {
      const parsed = CancelTaskRequestSchema.parse(input ?? {});
      const data = await request(config, {
        method: 'POST',
        path: `/tasks/${encodeURIComponent(id)}/cancel`,
        schema: TaskResponseSchema,
        body: parsed,
      });
      return data.task;
    },
  };
}

let cachedClient: ControlPlaneClient | null = null;

export function getControlPlaneClient(): ControlPlaneClient {
  if (cachedClient) return cachedClient;
  cachedClient = createControlPlaneClient({ baseUrl: getDefaultBaseUrl() });
  return cachedClient;
}

/** Reset the cached singleton — exposed for tests that mutate env vars. */
export function _resetControlPlaneClientForTests(): void {
  cachedClient = null;
}
