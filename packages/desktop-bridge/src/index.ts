import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { CoreAuditActor, CoreAuditLog } from '@fagaos/audit-log';

const STUB_SCREENSHOT_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

export type DesktopBridgeOperation =
  | 'session.create'
  | 'session.inspect'
  | 'session.terminate'
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
  inspectSession(sessionId: string): Promise<DesktopSession>;
  terminateSession(sessionId: string): Promise<void>;
  captureScreenshot(input: { sessionId: string }): Promise<ScreenshotResult>;
  clickMouse(input: { sessionId: string; x: number; y: number; button?: MouseButton }): Promise<CommandResult>;
  typeKeyboard(input: { sessionId: string; text: string }): Promise<CommandResult>;
  readClipboard(input: { sessionId: string }): Promise<{ text: string }>;
  writeClipboard(input: { sessionId: string; text: string }): Promise<CommandResult>;
  navigateBrowser(input: { sessionId: string; url: string }): Promise<BrowserNavigationResult>;
  readDropFile(input: { sessionId: string; relativePath: string }): Promise<{ contents: string }>;
  writeDropFile(input: { sessionId: string; relativePath: string; contents: string }): Promise<void>;
}

export type MouseButton = 'left' | 'middle' | 'right';

export interface BrowserAdapter {
  navigate(input: { session: DesktopSession; url: string }): Promise<BrowserNavigationResult>;
}

export interface ChromeDevToolsTransport {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
}

export interface LocalDesktopBridgeOptions {
  auditLog: CoreAuditLog;
  actor: CoreAuditActor;
  capabilityVerifier: CapabilityVerifier;
  sandboxRoot?: string;
  networkPolicy?: NetworkPolicy;
  browserAdapter?: BrowserAdapter;
  defaultTimeoutMs?: number;
  now?: () => number;
}

interface SessionRecord {
  session: DesktopSession;
  clipboard: string;
  timer: ReturnType<typeof setTimeout>;
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
  private readonly sandboxRoot: string;
  private readonly defaultTimeoutMs: number;
  private readonly now: () => number;
  private readonly sessions = new Map<string, SessionRecord>();

  constructor(options: LocalDesktopBridgeOptions) {
    this.auditLog = options.auditLog;
    this.actor = options.actor;
    this.capabilityVerifier = options.capabilityVerifier;
    this.networkPolicy = options.networkPolicy ?? denyAllNetworkPolicy;
    this.browserAdapter = options.browserAdapter ?? new StubBrowserAdapter();
    this.sandboxRoot = options.sandboxRoot ?? join(tmpdir(), 'fagaos-desktop-bridge');
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 30_000;
    this.now = options.now ?? Date.now;
  }

  async createSession(input: CreateSessionInput): Promise<DesktopSession> {
    const appId = requireNonEmpty(input.appId, 'appId');
    await this.requireCapability('session.create', { appId });
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
    const timer = setTimeout(() => {
      void this.timeoutSession(id);
    }, timeoutMs);
    this.sessions.set(id, { session, clipboard: '', timer });
    await this.audit('session.create', 'ok', session, { appId, profileDir, dropDir, timeoutMs });
    return copySession(session);
  }

  async inspectSession(sessionId: string): Promise<DesktopSession> {
    const record = await this.requireRecord(sessionId, 'session.inspect', { allowTerminated: true });
    if (record.session.status === 'timed_out') {
      throw new TimeoutError(`session ${sessionId} timed out`);
    }
    await this.audit('session.inspect', 'ok', record.session, { appId: record.session.appId });
    return copySession(record.session);
  }

  async terminateSession(sessionId: string): Promise<void> {
    const record = await this.requireRecord(sessionId, 'session.terminate', { allowTerminated: true });
    await this.cleanupRecord(record, 'terminated');
    await this.audit('session.terminate', 'ok', record.session, { appId: record.session.appId });
  }

  async captureScreenshot({ sessionId }: { sessionId: string }): Promise<ScreenshotResult> {
    const record = await this.requireActiveRecord(sessionId, 'screenshot.capture');
    await this.audit('screenshot.capture', 'ok', record.session, { appId: record.session.appId });
    return {
      mimeType: 'image/png',
      width: 1,
      height: 1,
      dataBase64: STUB_SCREENSHOT_PNG_BASE64,
    };
  }

  async clickMouse(input: { sessionId: string; x: number; y: number; button?: MouseButton }): Promise<CommandResult> {
    const record = await this.requireActiveRecord(input.sessionId, 'mouse.click');
    assertNonNegativeInteger(input.x, 'x');
    assertNonNegativeInteger(input.y, 'y');
    const button = input.button ?? 'left';
    if (!['left', 'middle', 'right'].includes(button)) {
      throw new ValidationError('button must be left, middle, or right');
    }
    await this.audit('mouse.click', 'ok', record.session, { x: input.x, y: input.y, button });
    return { ok: true, kind: 'mouse.click' };
  }

  async typeKeyboard(input: { sessionId: string; text: string }): Promise<CommandResult> {
    const record = await this.requireActiveRecord(input.sessionId, 'keyboard.type');
    requireNonEmpty(input.text, 'text');
    await this.audit('keyboard.type', 'ok', record.session, { length: input.text.length });
    return { ok: true, kind: 'keyboard.type' };
  }

  async readClipboard({ sessionId }: { sessionId: string }): Promise<{ text: string }> {
    const record = await this.requireActiveRecord(sessionId, 'clipboard.read');
    await this.audit('clipboard.read', 'ok', record.session, { length: record.clipboard.length });
    return { text: record.clipboard };
  }

  async writeClipboard(input: { sessionId: string; text: string }): Promise<CommandResult> {
    const record = await this.requireActiveRecord(input.sessionId, 'clipboard.write');
    record.clipboard = input.text;
    await this.audit('clipboard.write', 'ok', record.session, { length: input.text.length });
    return { ok: true, kind: 'clipboard.write' };
  }

  async navigateBrowser(input: { sessionId: string; url: string }): Promise<BrowserNavigationResult> {
    const record = await this.requireActiveRecord(input.sessionId, 'browser.navigate');
    const url = new URL(input.url);
    const decision = await this.networkPolicy({ session: copySession(record.session), url });
    if (!decision.allow) {
      await this.audit('browser.navigate', 'deny', record.session, {
        url: url.toString(),
        reason: decision.reason ?? 'network_denied',
      });
      throw new NetworkDeniedError(`network denied for ${url.toString()}`);
    }
    const result = await this.browserAdapter.navigate({ session: copySession(record.session), url: url.toString() });
    await this.audit('browser.navigate', 'ok', record.session, { url: result.url });
    return result;
  }

  async readDropFile(input: { sessionId: string; relativePath: string }): Promise<{ contents: string }> {
    const record = await this.requireActiveRecord(input.sessionId, 'file.readDrop');
    const path = resolveDropPath(record.session.dropDir, input.relativePath);
    const contents = await fs.readFile(path, 'utf8');
    await this.audit('file.readDrop', 'ok', record.session, { relativePath: input.relativePath });
    return { contents };
  }

  async writeDropFile(input: { sessionId: string; relativePath: string; contents: string }): Promise<void> {
    const record = await this.requireActiveRecord(input.sessionId, 'file.writeDrop');
    const path = resolveDropPath(record.session.dropDir, input.relativePath);
    await fs.mkdir(resolve(path, '..'), { recursive: true });
    await fs.writeFile(path, input.contents, 'utf8');
    await this.audit('file.writeDrop', 'ok', record.session, {
      relativePath: input.relativePath,
      length: input.contents.length,
    });
  }

  private async requireActiveRecord(
    sessionId: string,
    operation: DesktopBridgeOperation,
  ): Promise<SessionRecord> {
    const record = await this.requireRecord(sessionId, operation);
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
  ): Promise<SessionRecord> {
    const record = this.sessions.get(sessionId);
    await this.requireCapability(operation, compactObject({ sessionId, appId: record?.session.appId }));
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
    await this.cleanupRecord(record, 'timed_out');
    await this.audit('session.terminate', 'error', record.session, {
      appId: record.session.appId,
      reason: 'timeout',
    });
  }

  private async cleanupRecord(record: SessionRecord, status: 'terminated' | 'timed_out'): Promise<void> {
    clearTimeout(record.timer);
    record.session.status = status;
    await fs.rm(resolve(record.session.profileDir, '..'), { recursive: true, force: true });
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

function copySession(session: DesktopSession): DesktopSession {
  return { ...session };
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

function resolveDropPath(dropDir: string, unsafeRelativePath: string): string {
  requireNonEmpty(unsafeRelativePath, 'relativePath');
  const root = resolve(dropDir);
  const candidate = resolve(root, unsafeRelativePath);
  const rel = relative(root, candidate);
  if (rel.startsWith('..') || resolve(rel) === rel) {
    throw new ValidationError('drop folder paths must stay inside the drop folder');
  }
  return candidate;
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
