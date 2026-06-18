import { Buffer } from 'node:buffer';
import { constants, promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { CoreAuditActor, CoreAuditLog } from '@fagaos/audit-log';

const STUB_SCREENSHOT_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

export type DesktopBridgeOperation =
  | 'session.create'
  | 'session.inspect'
  | 'session.terminate'
  | 'session.stream.open'
  | 'screenshot.capture'
  | 'mouse.click'
  | 'keyboard.type'
  | 'clipboard.read'
  | 'clipboard.write'
  | 'browser.navigate'
  | 'file.readDrop'
  | 'file.writeDrop';

export interface BridgeCapabilityRequest {
  operation: DesktopBridgeOperation;
  actor: CoreAuditActor;
  sessionId?: string;
  appId?: string;
  resource?: Record<string, unknown>;
}

export interface BridgeCapabilityDecision {
  allow: boolean;
  reason?: string;
}

export type CapabilityVerifier = (
  request: BridgeCapabilityRequest,
) => Promise<BridgeCapabilityDecision> | BridgeCapabilityDecision;

export interface BrowserNetworkRequest {
  session: DesktopSession;
  url: URL;
}

export interface BrowserNetworkDecision {
  allow: boolean;
  reason?: string;
}

export type NetworkPolicy = (
  request: BrowserNetworkRequest,
) => Promise<BrowserNetworkDecision> | BrowserNetworkDecision;

export interface DesktopSession {
  id: string;
  appId: string;
  status: 'active' | 'terminated' | 'timed_out';
  profileDir: string;
  dropDir: string;
  createdAt: number;
  expiresAt: number;
}

export interface CreateSessionInput {
  appId: string;
  timeoutMs?: number;
  auditCorrelationId?: string;
}

export interface BrowserInspection {
  endpoint?: string;
  profileDir: string;
  streamStatus: 'available' | 'unavailable';
}

export interface RemoteWorkerLease {
  id: string;
  target: SupportedRuntimeTarget;
  endpoint?: string;
}

export interface DesktopSessionInspection extends DesktopSession {
  browser?: BrowserInspection;
  worker?: RemoteWorkerLease;
}

export interface InspectionStream {
  kind: 'browser.inspectionStream' | 'desktop.inspectionStream';
  url: string;
  expiresAt: number;
}

export interface ScreenshotResult {
  mimeType: 'image/png';
  width: number;
  height: number;
  dataBase64: string;
}

export interface CommandResult {
  ok: true;
  kind: 'mouse.click' | 'keyboard.type' | 'clipboard.write';
}

export interface BrowserNavigationResult {
  ok: true;
  url: string;
  title: string;
}

export interface DesktopBridge {
  createSession(input: CreateSessionInput): Promise<DesktopSession>;
  inspectSession(sessionId: string, options?: BridgeOperationOptions): Promise<DesktopSessionInspection>;
  terminateSession(sessionId: string, options?: BridgeOperationOptions): Promise<void>;
  captureScreenshot(input: { sessionId: string } & BridgeOperationOptions): Promise<ScreenshotResult>;
  clickMouse(input: { sessionId: string; x: number; y: number; button?: MouseButton } & BridgeOperationOptions): Promise<CommandResult>;
  typeKeyboard(input: { sessionId: string; text: string } & BridgeOperationOptions): Promise<CommandResult>;
  readClipboard(input: { sessionId: string } & BridgeOperationOptions): Promise<{ text: string }>;
  writeClipboard(input: { sessionId: string; text: string } & BridgeOperationOptions): Promise<CommandResult>;
  navigateBrowser(input: { sessionId: string; url: string } & BridgeOperationOptions): Promise<BrowserNavigationResult>;
  openInspectionStream(input: { sessionId: string } & BridgeOperationOptions): Promise<InspectionStream>;
  readDropFile(input: { sessionId: string; relativePath: string } & BridgeOperationOptions): Promise<{ contents: string }>;
  writeDropFile(input: { sessionId: string; relativePath: string; contents: string } & BridgeOperationOptions): Promise<void>;
}

export type MouseButton = 'left' | 'middle' | 'right';

export interface BridgeOperationOptions {
  auditCorrelationId?: string;
}

export type SupportedRuntimeTarget = 'linux-x11-cdp' | 'macos-xctest-cdp' | 'windows-uia-cdp';

export interface DesktopRuntimeAdapter {
  createSession?(input: { session: DesktopSession; worker?: RemoteWorkerLease }): Promise<void>;
  captureScreenshot?(input: { session: DesktopSession; worker?: RemoteWorkerLease }): Promise<ScreenshotResult>;
  clickMouse?(input: {
    session: DesktopSession;
    worker?: RemoteWorkerLease;
    x: number;
    y: number;
    button: MouseButton;
  }): Promise<CommandResult>;
  typeKeyboard?(input: { session: DesktopSession; worker?: RemoteWorkerLease; text: string }): Promise<CommandResult>;
  readClipboard?(input: { session: DesktopSession; worker?: RemoteWorkerLease }): Promise<{ text: string }>;
  writeClipboard?(input: { session: DesktopSession; worker?: RemoteWorkerLease; text: string }): Promise<CommandResult>;
  terminateSession?(input: { session: DesktopSession; worker?: RemoteWorkerLease }): Promise<void>;
}

export interface RemoteWorkerProvisioner {
  provision(input: { session: DesktopSession }): Promise<RemoteWorkerLease>;
  release(input: { session: DesktopSession; worker: RemoteWorkerLease }): Promise<void>;
}

export interface BrowserAdapter {
  createSession?(input: { session: DesktopSession; worker?: RemoteWorkerLease }): Promise<void>;
  inspectSession?(input: { session: DesktopSession; worker?: RemoteWorkerLease }): Promise<BrowserInspection>;
  openInspectionStream?(input: { session: DesktopSession; worker?: RemoteWorkerLease }): Promise<InspectionStream>;
  navigate(input: { session: DesktopSession; url: string }): Promise<BrowserNavigationResult>;
  teardownSession?(input: { session: DesktopSession; worker?: RemoteWorkerLease }): Promise<void>;
}

export interface ChromeDevToolsTransport {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
}

export interface LocalDesktopBridgeOptions {
  auditLog: CoreAuditLog;
  actor: CoreAuditActor;
  capabilityVerifier: CapabilityVerifier;
  mode?: 'test' | 'production';
  sandboxRoot?: string;
  networkPolicy?: NetworkPolicy;
  browserAdapter?: BrowserAdapter;
  desktopAdapter?: DesktopRuntimeAdapter;
  remoteWorkerProvisioner?: RemoteWorkerProvisioner;
  defaultTimeoutMs?: number;
  now?: () => number;
}

interface SessionRecord {
  session: DesktopSession;
  worker?: RemoteWorkerLease;
  clipboard: string;
  timer: ReturnType<typeof setTimeout>;
}

interface OperationResourceInput extends BridgeOperationOptions {
  x?: number;
  y?: number;
  button?: MouseButton;
  text?: string;
  contents?: string;
  relativePath?: string;
  url?: URL;
}

export interface HostCommand {
  command: string;
  args: string[];
  stdin?: string;
}

export interface HostCommandResult {
  stdout?: string | Uint8Array;
}

export type HostCommandRunner = (command: HostCommand) => Promise<HostCommandResult>;

export interface HostDesktopAdapterOptions {
  target: SupportedRuntimeTarget;
  commandRunner: HostCommandRunner;
}

export class DesktopBridgeError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

export class CapabilityDeniedError extends DesktopBridgeError {
  constructor(message: string) {
    super(message, 'CAPABILITY_DENIED');
  }
}

export class TimeoutError extends DesktopBridgeError {
  constructor(message: string) {
    super(message, 'SESSION_TIMEOUT');
  }
}

export class ValidationError extends DesktopBridgeError {
  constructor(message: string) {
    super(message, 'VALIDATION_ERROR');
  }
}

export class NetworkDeniedError extends DesktopBridgeError {
  constructor(message: string) {
    super(message, 'NETWORK_DENIED');
  }
}

export class CleanupError extends DesktopBridgeError {
  constructor(readonly failures: Error[]) {
    super(
      `cleanup failed: ${failures.map((failure) => failure.message).join('; ')}`,
      'CLEANUP_FAILED',
    );
  }
}

export function createAllowListCapabilityVerifier(
  allowedOperations: Iterable<DesktopBridgeOperation | string>,
): CapabilityVerifier {
  const allowed = new Set(allowedOperations);
  return ({ operation }) => (
    allowed.has(operation)
      ? { allow: true }
      : { allow: false, reason: 'capability_not_granted' }
  );
}

export const denyAllNetworkPolicy: NetworkPolicy = () => ({
  allow: false,
  reason: 'network_denied_by_default',
});

export class StubBrowserAdapter implements BrowserAdapter {
  async inspectSession({ session }: { session: DesktopSession }): Promise<BrowserInspection> {
    return {
      profileDir: session.profileDir,
      streamStatus: 'unavailable',
    };
  }

  async navigate({ url }: { session: DesktopSession; url: string }): Promise<BrowserNavigationResult> {
    return {
      ok: true,
      url,
      title: `Stub page for ${url}`,
    };
  }
}

export class ChromeDevToolsBrowserAdapter implements BrowserAdapter {
  constructor(private readonly transport: ChromeDevToolsTransport) {}

  async navigate({ url }: { session: DesktopSession; url: string }): Promise<BrowserNavigationResult> {
    await this.transport.send('Page.enable');
    await this.transport.send('Page.navigate', { url });
    const titleResult = await this.transport.send('Runtime.evaluate', {
      expression: 'document.title',
      returnByValue: true,
    });
    return {
      ok: true,
      url,
      title: readRuntimeString(titleResult) ?? `CDP page for ${url}`,
    };
  }
}

export class LocalDesktopBridge implements DesktopBridge {
  private readonly auditLog: CoreAuditLog;
  private readonly actor: CoreAuditActor;
  private readonly capabilityVerifier: CapabilityVerifier;
  private readonly networkPolicy: NetworkPolicy;
  private readonly browserAdapter: BrowserAdapter;
  private readonly desktopAdapter: DesktopRuntimeAdapter;
  private readonly mode: 'test' | 'production';
  private readonly remoteWorkerProvisioner: RemoteWorkerProvisioner | undefined;
  private readonly sandboxRoot: string;
  private readonly defaultTimeoutMs: number;
  private readonly now: () => number;
  private readonly sessions = new Map<string, SessionRecord>();

  constructor(options: LocalDesktopBridgeOptions) {
    this.auditLog = options.auditLog;
    this.actor = options.actor;
    this.capabilityVerifier = options.capabilityVerifier;
    this.mode = options.mode ?? 'test';
    this.networkPolicy = options.networkPolicy ?? denyAllNetworkPolicy;
    if (this.mode === 'production' && !options.browserAdapter) {
      throw new ValidationError('production mode requires an explicit browserAdapter');
    }
    this.browserAdapter = options.browserAdapter ?? new StubBrowserAdapter();
    this.desktopAdapter = options.desktopAdapter ?? {};
    this.remoteWorkerProvisioner = options.remoteWorkerProvisioner;
    this.sandboxRoot = options.sandboxRoot ?? join(tmpdir(), 'fagaos-desktop-bridge');
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 30_000;
    this.now = options.now ?? Date.now;
  }

  async createSession(input: CreateSessionInput): Promise<DesktopSession> {
    const appId = requireNonEmpty(input.appId, 'appId');
    const resource = operationResource(input);
    await this.requireCapability('session.create', compactObject({ appId, resource }));
    const id = `desk_${randomUUID()}`;
    const sessionRoot = join(this.sandboxRoot, id);
    const profileDir = join(sessionRoot, 'profile');
    const dropDir = join(sessionRoot, 'drop');
    await fs.mkdir(profileDir, { recursive: true });
    await fs.mkdir(dropDir, { recursive: true });
    const createdAt = this.now();
    const timeoutMs = input.timeoutMs ?? this.defaultTimeoutMs;
    const session: DesktopSession = {
      id,
      appId,
      status: 'active',
      profileDir,
      dropDir,
      createdAt,
      expiresAt: createdAt + timeoutMs,
    };
    let worker: RemoteWorkerLease | undefined;
    try {
      worker = await this.remoteWorkerProvisioner?.provision({ session: copySession(session) });
      await this.desktopAdapter.createSession?.(sessionContext(session, worker));
      await this.browserAdapter.createSession?.(sessionContext(session, worker));
    } catch (error) {
      await this.cleanupUnrecordedSession(session, worker);
      throw error;
    }
    const timer = setTimeout(() => {
      void this.timeoutSession(id);
    }, timeoutMs);
    this.sessions.set(id, createSessionRecord({ session, worker, timer }));
    await this.audit('session.create', 'ok', session, {
      appId,
      profileDir,
      dropDir,
      timeoutMs,
      workerId: worker?.id,
      auditCorrelationId: input.auditCorrelationId,
    });
    return copySession(session);
  }

  async inspectSession(sessionId: string, options: BridgeOperationOptions = {}): Promise<DesktopSessionInspection> {
    const record = await this.requireRecord(sessionId, 'session.inspect', { allowTerminated: true }, operationResource(options));
    if (record.session.status === 'timed_out') {
      throw new TimeoutError(`session ${sessionId} timed out`);
    }
    const browser = await this.browserAdapter.inspectSession?.(sessionContext(record.session, record.worker));
    await this.audit('session.inspect', 'ok', record.session, {
      appId: record.session.appId,
      workerId: record.worker?.id,
      auditCorrelationId: options.auditCorrelationId,
    });
    return {
      ...copySession(record.session),
      ...(browser ? { browser } : {}),
      ...(record.worker ? { worker: record.worker } : {}),
    };
  }

  async terminateSession(sessionId: string, options: BridgeOperationOptions = {}): Promise<void> {
    const record = await this.requireRecord(sessionId, 'session.terminate', { allowTerminated: true }, operationResource(options));
    await this.cleanupRecord(record, 'terminated');
    await this.audit('session.terminate', 'ok', record.session, {
      appId: record.session.appId,
      workerId: record.worker?.id,
      auditCorrelationId: options.auditCorrelationId,
    });
  }

  async captureScreenshot(input: { sessionId: string } & BridgeOperationOptions): Promise<ScreenshotResult> {
    const record = await this.requireActiveRecord(input.sessionId, 'screenshot.capture', operationResource(input));
    const captureScreenshot = this.requireDesktopAdapterMethod('captureScreenshot', 'screenshot.capture');
    const result = await captureScreenshot?.({
      session: copySession(record.session),
      ...(record.worker ? { worker: record.worker } : {}),
    }) ?? {
      mimeType: 'image/png',
      width: 1,
      height: 1,
      dataBase64: STUB_SCREENSHOT_PNG_BASE64,
    };
    await this.audit('screenshot.capture', 'ok', record.session, {
      appId: record.session.appId,
      adapter: this.desktopAdapter.captureScreenshot ? 'runtime' : 'deterministic',
      auditCorrelationId: input.auditCorrelationId,
    });
    return result;
  }

  async clickMouse(input: { sessionId: string; x: number; y: number; button?: MouseButton } & BridgeOperationOptions): Promise<CommandResult> {
    assertNonNegativeInteger(input.x, 'x');
    assertNonNegativeInteger(input.y, 'y');
    const button = input.button ?? 'left';
    if (!['left', 'middle', 'right'].includes(button)) {
      throw new ValidationError('button must be left, middle, or right');
    }
    const record = await this.requireActiveRecord(input.sessionId, 'mouse.click', operationResource({
      ...input,
      button,
    }));
    const clickMouse = this.requireDesktopAdapterMethod('clickMouse', 'mouse.click');
    const result = await clickMouse?.({
      session: copySession(record.session),
      ...(record.worker ? { worker: record.worker } : {}),
      x: input.x,
      y: input.y,
      button,
    }) ?? { ok: true, kind: 'mouse.click' as const };
    await this.audit('mouse.click', 'ok', record.session, {
      x: input.x,
      y: input.y,
      button,
      adapter: this.desktopAdapter.clickMouse ? 'runtime' : 'deterministic',
      auditCorrelationId: input.auditCorrelationId,
    });
    return result;
  }

  async typeKeyboard(input: { sessionId: string; text: string } & BridgeOperationOptions): Promise<CommandResult> {
    requireNonEmpty(input.text, 'text');
    const record = await this.requireActiveRecord(input.sessionId, 'keyboard.type', operationResource(input));
    const typeKeyboard = this.requireDesktopAdapterMethod('typeKeyboard', 'keyboard.type');
    const result = await typeKeyboard?.({
      session: copySession(record.session),
      ...(record.worker ? { worker: record.worker } : {}),
      text: input.text,
    }) ?? { ok: true, kind: 'keyboard.type' as const };
    await this.audit('keyboard.type', 'ok', record.session, {
      length: input.text.length,
      adapter: this.desktopAdapter.typeKeyboard ? 'runtime' : 'deterministic',
      auditCorrelationId: input.auditCorrelationId,
    });
    return result;
  }

  async readClipboard(input: { sessionId: string } & BridgeOperationOptions): Promise<{ text: string }> {
    const record = await this.requireActiveRecord(input.sessionId, 'clipboard.read', operationResource(input));
    const readClipboard = this.requireDesktopAdapterMethod('readClipboard', 'clipboard.read');
    const result = await readClipboard?.(sessionContext(record.session, record.worker)) ?? { text: record.clipboard };
    await this.audit('clipboard.read', 'ok', record.session, {
      length: result.text.length,
      adapter: this.desktopAdapter.readClipboard ? 'runtime' : 'deterministic',
      auditCorrelationId: input.auditCorrelationId,
    });
    return result;
  }

  async writeClipboard(input: { sessionId: string; text: string } & BridgeOperationOptions): Promise<CommandResult> {
    const record = await this.requireActiveRecord(input.sessionId, 'clipboard.write', operationResource(input));
    record.clipboard = input.text;
    const writeClipboard = this.requireDesktopAdapterMethod('writeClipboard', 'clipboard.write');
    const result = await writeClipboard?.({
      session: copySession(record.session),
      ...(record.worker ? { worker: record.worker } : {}),
      text: input.text,
    }) ?? { ok: true, kind: 'clipboard.write' as const };
    await this.audit('clipboard.write', 'ok', record.session, {
      length: input.text.length,
      adapter: this.desktopAdapter.writeClipboard ? 'runtime' : 'deterministic',
      auditCorrelationId: input.auditCorrelationId,
    });
    return result;
  }

  async navigateBrowser(input: { sessionId: string; url: string } & BridgeOperationOptions): Promise<BrowserNavigationResult> {
    const url = new URL(input.url);
    const record = await this.requireActiveRecord(input.sessionId, 'browser.navigate', operationResource({
      ...input,
      url,
    }));
    const decision = await this.networkPolicy({ session: copySession(record.session), url });
    if (!decision.allow) {
      await this.audit('browser.navigate', 'deny', record.session, {
        url: url.toString(),
        reason: decision.reason ?? 'network_denied',
        auditCorrelationId: input.auditCorrelationId,
      });
      throw new NetworkDeniedError(`network denied for ${url.toString()}`);
    }
    const result = await this.browserAdapter.navigate({ session: copySession(record.session), url: url.toString() });
    await this.audit('browser.navigate', 'ok', record.session, {
      url: result.url,
      workerId: record.worker?.id,
      auditCorrelationId: input.auditCorrelationId,
    });
    return result;
  }

  async openInspectionStream(input: { sessionId: string } & BridgeOperationOptions): Promise<InspectionStream> {
    const record = await this.requireActiveRecord(input.sessionId, 'session.stream.open', operationResource(input));
    if (!this.browserAdapter.openInspectionStream) {
      throw new ValidationError('inspection stream is unavailable for this browser adapter');
    }
    const stream = await this.browserAdapter.openInspectionStream(sessionContext(record.session, record.worker));
    await this.audit('session.stream.open', 'ok', record.session, {
      kind: stream.kind,
      workerId: record.worker?.id,
      auditCorrelationId: input.auditCorrelationId,
    });
    return stream;
  }

  async readDropFile(input: { sessionId: string; relativePath: string } & BridgeOperationOptions): Promise<{ contents: string }> {
    const record = await this.requireActiveRecord(input.sessionId, 'file.readDrop', operationResource(input));
    const path = await resolveExistingDropPath(record.session.dropDir, input.relativePath);
    const file = await openDropFileNoFollow(path, 'r');
    let contents: string;
    try {
      contents = await file.readFile('utf8');
    } finally {
      await file.close();
    }
    await this.audit('file.readDrop', 'ok', record.session, {
      relativePath: input.relativePath,
      auditCorrelationId: input.auditCorrelationId,
    });
    return { contents };
  }

  async writeDropFile(input: { sessionId: string; relativePath: string; contents: string } & BridgeOperationOptions): Promise<void> {
    const record = await this.requireActiveRecord(input.sessionId, 'file.writeDrop', operationResource(input));
    const path = resolveLexicalDropPath(record.session.dropDir, input.relativePath);
    await ensureDropParentPath(record.session.dropDir, dirname(path));
    const file = await openDropFileNoFollow(path, 'w');
    try {
      await file.writeFile(input.contents, 'utf8');
    } finally {
      await file.close();
    }
    await this.audit('file.writeDrop', 'ok', record.session, {
      relativePath: input.relativePath,
      length: input.contents.length,
      auditCorrelationId: input.auditCorrelationId,
    });
  }

  private async requireActiveRecord(
    sessionId: string,
    operation: DesktopBridgeOperation,
    resource?: Record<string, unknown>,
  ): Promise<SessionRecord> {
    const record = await this.requireRecord(sessionId, operation, {}, resource);
    if (record.session.status === 'timed_out') {
      throw new TimeoutError(`session ${sessionId} timed out`);
    }
    if (record.session.status !== 'active') {
      throw new ValidationError(`session ${sessionId} is ${record.session.status}`);
    }
    if (record.session.expiresAt <= this.now()) {
      await this.timeoutSession(sessionId);
      throw new TimeoutError(`session ${sessionId} timed out`);
    }
    return record;
  }

  private async requireRecord(
    sessionId: string,
    operation: DesktopBridgeOperation,
    options: { allowTerminated?: boolean } = {},
    resource?: Record<string, unknown>,
  ): Promise<SessionRecord> {
    const record = this.sessions.get(sessionId);
    await this.requireCapability(operation, compactObject({ sessionId, appId: record?.session.appId, resource }));
    if (!record) {
      throw new ValidationError(`unknown session ${sessionId}`);
    }
    if (!options.allowTerminated && record.session.status === 'terminated') {
      throw new ValidationError(`session ${sessionId} is terminated`);
    }
    return record;
  }

  private async requireCapability(
    operation: DesktopBridgeOperation,
    input: { sessionId?: string; appId?: string; resource?: Record<string, unknown> } = {},
  ): Promise<void> {
    const decision = await this.capabilityVerifier({
      operation,
      actor: this.actor,
      ...input,
    });
    if (!decision.allow) {
      await this.audit(operation, 'deny', input.sessionId, {
        appId: input.appId,
        reason: decision.reason ?? 'capability_denied',
      });
      throw new CapabilityDeniedError(`capability denied for ${operation}`);
    }
  }

  private async timeoutSession(sessionId: string): Promise<void> {
    const record = this.sessions.get(sessionId);
    if (!record || record.session.status !== 'active') {
      return;
    }
    try {
      await this.cleanupRecord(record, 'timed_out');
    } catch (error) {
      await this.audit('session.terminate', 'error', record.session, {
        appId: record.session.appId,
        reason: formatCleanupError(error),
      });
      return;
    }
    await this.audit('session.terminate', 'error', record.session, {
      appId: record.session.appId,
      reason: 'timeout',
    });
  }

  private async cleanupRecord(record: SessionRecord, status: 'terminated' | 'timed_out'): Promise<void> {
    if (record.session.status !== 'active') {
      return;
    }
    clearTimeout(record.timer);
    record.session.status = status;
    const failures = await collectCleanupFailures([
      () => this.browserAdapter.teardownSession?.(sessionContext(record.session, record.worker)),
      () => this.desktopAdapter.terminateSession?.(sessionContext(record.session, record.worker)),
      () => record.worker
        ? this.remoteWorkerProvisioner?.release({ session: copySession(record.session), worker: record.worker })
        : undefined,
      () => fs.rm(resolve(record.session.profileDir, '..'), { recursive: true, force: true }),
    ]);
    if (failures.length > 0) {
      throw new CleanupError(failures);
    }
  }

  private async cleanupUnrecordedSession(
    session: DesktopSession,
    worker: RemoteWorkerLease | undefined,
  ): Promise<void> {
    const failures = await collectCleanupFailures([
      () => this.browserAdapter.teardownSession?.(sessionContext(session, worker)),
      () => this.desktopAdapter.terminateSession?.(sessionContext(session, worker)),
      () => worker
        ? this.remoteWorkerProvisioner?.release({ session: copySession(session), worker })
        : undefined,
      () => fs.rm(resolve(session.profileDir, '..'), { recursive: true, force: true }),
    ]);
    if (failures.length > 0) {
      await this.audit('session.create', 'error', session, {
        appId: session.appId,
        reason: formatCleanupError(new CleanupError(failures)),
      });
    }
  }

  private requireDesktopAdapterMethod<K extends keyof DesktopRuntimeAdapter>(
    method: K,
    operation: DesktopBridgeOperation,
  ): DesktopRuntimeAdapter[K] | undefined {
    const adapterMethod = this.desktopAdapter[method];
    if (!adapterMethod && this.mode === 'production') {
      throw new ValidationError(`production mode requires desktop adapter support for ${operation}`);
    }
    return adapterMethod;
  }

  private async audit(
    operation: DesktopBridgeOperation,
    outcome: 'allow' | 'deny' | 'ok' | 'error',
    sessionOrId: DesktopSession | string | undefined,
    payload: Record<string, unknown> = {},
  ): Promise<void> {
    const sessionId = typeof sessionOrId === 'string' ? sessionOrId : sessionOrId?.id;
    const appId = typeof sessionOrId === 'string' ? undefined : sessionOrId?.appId;
    await this.auditLog.append({
      actor: this.actor,
      action: { name: `desktopBridge.${operation}`, outcome },
      resource: { type: 'desktopBridge.session', id: sessionId ?? 'unbound' },
      payload: compactObject({
        ...payload,
        appId: payload.appId ?? appId,
      }),
    });
  }
}

export function createHostDesktopAdapter(options: HostDesktopAdapterOptions): DesktopRuntimeAdapter {
  if (options.target !== 'linux-x11-cdp') {
    return createUnsupportedHostDesktopAdapter(options.target);
  }
  return {
    async captureScreenshot() {
      const result = await options.commandRunner({ command: 'import', args: ['-window', 'root', 'png:-'] });
      const stdout = result.stdout ?? new Uint8Array();
      return {
        mimeType: 'image/png',
        width: 0,
        height: 0,
        dataBase64: Buffer.from(stdout).toString('base64'),
      };
    },
    async clickMouse({ x, y, button }) {
      await options.commandRunner({
        command: 'xdotool',
        args: ['mousemove', String(x), String(y), 'click', linuxMouseButton(button)],
      });
      return { ok: true, kind: 'mouse.click' };
    },
    async typeKeyboard({ text }) {
      await options.commandRunner({ command: 'xdotool', args: ['type', '--clearmodifiers', text] });
      return { ok: true, kind: 'keyboard.type' };
    },
    async writeClipboard({ text }) {
      await options.commandRunner({ command: 'xclip', args: ['-selection', 'clipboard'], stdin: text });
      return { ok: true, kind: 'clipboard.write' };
    },
    async readClipboard() {
      const result = await options.commandRunner({ command: 'xclip', args: ['-selection', 'clipboard', '-o'] });
      return { text: typeof result.stdout === 'string' ? result.stdout : Buffer.from(result.stdout ?? '').toString('utf8') };
    },
  };
}

function copySession(session: DesktopSession): DesktopSession {
  return { ...session };
}

function sessionContext(
  session: DesktopSession,
  worker: RemoteWorkerLease | undefined,
): { session: DesktopSession; worker?: RemoteWorkerLease } {
  return {
    session: copySession(session),
    ...(worker ? { worker } : {}),
  };
}

function createSessionRecord(input: {
  session: DesktopSession;
  worker: RemoteWorkerLease | undefined;
  timer: ReturnType<typeof setTimeout>;
}): SessionRecord {
  return {
    session: input.session,
    clipboard: '',
    timer: input.timer,
    ...(input.worker ? { worker: input.worker } : {}),
  };
}

function operationResource(options: OperationResourceInput): Record<string, unknown> | undefined {
  const resource = compactObject({
    auditCorrelationId: options.auditCorrelationId,
    x: options.x,
    y: options.y,
    button: options.button,
    textLength: typeof options.text === 'string' ? options.text.length : undefined,
    contentsLength: typeof options.contents === 'string' ? options.contents.length : undefined,
    relativePath: typeof options.relativePath === 'string' ? options.relativePath : undefined,
    ...(options.url instanceof URL
      ? {
          url: options.url.toString(),
          origin: options.url.origin,
          protocol: options.url.protocol,
          hostname: options.url.hostname,
        }
      : {}),
  });
  return Object.keys(resource).length > 0 ? resource : undefined;
}

function linuxMouseButton(button: MouseButton): string {
  return ({ left: '1', middle: '2', right: '3' })[button];
}

function createUnsupportedHostDesktopAdapter(target: SupportedRuntimeTarget): DesktopRuntimeAdapter {
  const unsupported = async (): Promise<never> => {
    throw new ValidationError(`host desktop adapter target ${target} is not implemented`);
  };
  return {
    createSession: unsupported,
    captureScreenshot: unsupported,
    clickMouse: unsupported,
    typeKeyboard: unsupported,
    readClipboard: unsupported,
    writeClipboard: unsupported,
    terminateSession: unsupported,
  };
}

function requireNonEmpty(value: string, field: string): string {
  if (value.trim().length === 0) {
    throw new ValidationError(`${field} must not be empty`);
  }
  return value;
}

function assertNonNegativeInteger(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new ValidationError(`${field} must be a non-negative integer`);
  }
}

function resolveLexicalDropPath(dropDir: string, unsafeRelativePath: string): string {
  requireNonEmpty(unsafeRelativePath, 'relativePath');
  const root = resolve(dropDir);
  const candidate = resolve(root, unsafeRelativePath);
  assertContainedPath(root, candidate);
  return candidate;
}

async function resolveExistingDropPath(dropDir: string, unsafeRelativePath: string): Promise<string> {
  const candidate = resolveLexicalDropPath(dropDir, unsafeRelativePath);
  const realRoot = await fs.realpath(dropDir);
  const realCandidate = await fs.realpath(candidate);
  assertContainedPath(realRoot, realCandidate);
  return candidate;
}

async function ensureDropParentPath(dropDir: string, parentPath: string): Promise<void> {
  const root = resolve(dropDir);
  assertContainedPath(root, resolve(parentPath));
  await fs.mkdir(parentPath, { recursive: true });
  const realRoot = await fs.realpath(root);
  const realParent = await fs.realpath(parentPath);
  assertContainedPath(realRoot, realParent);
}

async function openDropFileNoFollow(path: string, mode: 'r' | 'w'): Promise<FileHandle> {
  try {
    return await fs.open(
      path,
      mode === 'r'
        ? constants.O_RDONLY | constants.O_NOFOLLOW
        : constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
      0o600,
    );
  } catch (error) {
    if (isNodeError(error) && error.code === 'ELOOP') {
      throw new ValidationError('drop folder paths must stay inside the drop folder');
    }
    throw error;
  }
}

function assertContainedPath(root: string, candidate: string): void {
  const rel = relative(root, candidate);
  if (rel.startsWith('..') || resolve(rel) === rel) {
    throw new ValidationError('drop folder paths must stay inside the drop folder');
  }
}

async function collectCleanupFailures(
  cleanupSteps: Array<() => Promise<unknown> | unknown>,
): Promise<Error[]> {
  const failures: Error[] = [];
  for (const cleanupStep of cleanupSteps) {
    try {
      await cleanupStep();
    } catch (error) {
      failures.push(toError(error));
    }
  }
  return failures;
}

function formatCleanupError(error: unknown): string {
  return toError(error).message;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function compactObject(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

function readRuntimeString(result: unknown): string | null {
  if (!isRecord(result)) {
    return null;
  }
  const runtimeResult = result.result;
  if (!isRecord(runtimeResult)) {
    return null;
  }
  return typeof runtimeResult.value === 'string' ? runtimeResult.value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
