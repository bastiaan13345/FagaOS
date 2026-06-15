import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { InMemoryAuditLog } from '@fagaos/audit-log';
import {
  CapabilityDeniedError,
  ChromeDevToolsBrowserAdapter,
  LocalDesktopBridge,
  TimeoutError,
  createAllowListCapabilityVerifier,
  denyAllNetworkPolicy,
} from '../src/index.js';

const actor = { id: 'agent:test', label: 'test agent', capabilityId: 'cap:test' };

async function makeRoot(): Promise<string> {
  return fs.mkdtemp(join(tmpdir(), 'fagaos-desktop-bridge-'));
}

describe('LocalDesktopBridge session lifecycle', () => {
  it('creates, inspects, and terminates an isolated session', async () => {
    const auditLog = new InMemoryAuditLog();
    const bridge = new LocalDesktopBridge({
      auditLog,
      actor,
      capabilityVerifier: createAllowListCapabilityVerifier([
        'session.create',
        'session.inspect',
        'session.terminate',
      ]),
      sandboxRoot: await makeRoot(),
    });

    const session = await bridge.createSession({ appId: 'browser' });
    const inspected = await bridge.inspectSession(session.id);

    expect(inspected.id).toBe(session.id);
    expect(inspected.appId).toBe('browser');
    expect(inspected.status).toBe('active');
    expect(inspected.profileDir).toContain(session.id);
    await expect(fs.stat(inspected.profileDir)).resolves.toMatchObject({ isDirectory: expect.any(Function) });

    await bridge.terminateSession(session.id);
    expect((await bridge.inspectSession(session.id)).status).toBe('terminated');
    await expect(fs.stat(inspected.profileDir)).rejects.toMatchObject({ code: 'ENOENT' });

    expect((await auditLog.query()).map((entry) => entry.action.name)).toEqual([
      'desktopBridge.session.create',
      'desktopBridge.session.inspect',
      'desktopBridge.session.terminate',
      'desktopBridge.session.inspect',
    ]);
  });
});

describe('LocalDesktopBridge capability and audit behavior', () => {
  it('denies operations without a matching capability and records the denial', async () => {
    const auditLog = new InMemoryAuditLog();
    const bridge = new LocalDesktopBridge({
      auditLog,
      actor,
      capabilityVerifier: createAllowListCapabilityVerifier(['session.create']),
      sandboxRoot: await makeRoot(),
    });
    const session = await bridge.createSession({ appId: 'browser' });

    await expect(bridge.captureScreenshot({ sessionId: session.id })).rejects.toBeInstanceOf(CapabilityDeniedError);

    const denial = (await auditLog.query()).find(
      (entry) => entry.action.name === 'desktopBridge.screenshot.capture',
    );
    expect(denial?.action.outcome).toBe('deny');
    expect(denial?.payload).toMatchObject({ reason: 'capability_not_granted' });
  });

  it('records successful bridge actions with session and resource context', async () => {
    const auditLog = new InMemoryAuditLog();
    const bridge = new LocalDesktopBridge({
      auditLog,
      actor,
      capabilityVerifier: createAllowListCapabilityVerifier(['session.create', 'screenshot.capture']),
      sandboxRoot: await makeRoot(),
    });
    const session = await bridge.createSession({ appId: 'browser' });

    await bridge.captureScreenshot({ sessionId: session.id });

    const screenshot = (await auditLog.query()).find(
      (entry) => entry.action.name === 'desktopBridge.screenshot.capture',
    );
    expect(screenshot?.action.outcome).toBe('ok');
    expect(screenshot?.resource).toEqual({ type: 'desktopBridge.session', id: session.id });
    expect(screenshot?.payload).toMatchObject({ appId: 'browser' });
  });
});

describe('LocalDesktopBridge desktop and browser commands', () => {
  it('returns a deterministic screenshot stub', async () => {
    const bridge = await makeBridge([
      'session.create',
      'screenshot.capture',
    ]);
    const session = await bridge.createSession({ appId: 'browser' });

    const screenshot = await bridge.captureScreenshot({ sessionId: session.id });

    expect(screenshot.mimeType).toBe('image/png');
    expect(screenshot.width).toBe(1);
    expect(screenshot.height).toBe(1);
    expect(screenshot.dataBase64).toBe(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    );
  });

  it('validates mouse and keyboard commands before dispatch', async () => {
    const bridge = await makeBridge([
      'session.create',
      'mouse.click',
      'keyboard.type',
    ]);
    const session = await bridge.createSession({ appId: 'browser' });

    await expect(bridge.clickMouse({ sessionId: session.id, x: -1, y: 10 })).rejects.toThrow(
      'x must be a non-negative integer',
    );
    await expect(bridge.typeKeyboard({ sessionId: session.id, text: '' })).rejects.toThrow(
      'text must not be empty',
    );

    await expect(bridge.clickMouse({ sessionId: session.id, x: 1, y: 2 })).resolves.toMatchObject({
      ok: true,
      kind: 'mouse.click',
    });
    await expect(bridge.typeKeyboard({ sessionId: session.id, text: 'hello' })).resolves.toMatchObject({
      ok: true,
      kind: 'keyboard.type',
    });
  });

  it('reads and writes clipboard text through the bridge', async () => {
    const bridge = await makeBridge([
      'session.create',
      'clipboard.write',
      'clipboard.read',
    ]);
    const session = await bridge.createSession({ appId: 'browser' });

    await bridge.writeClipboard({ sessionId: session.id, text: 'bridge text' });

    await expect(bridge.readClipboard({ sessionId: session.id })).resolves.toEqual({
      text: 'bridge text',
    });
  });

  it('uses the browser navigation adapter behind the bridge', async () => {
    const bridge = await makeBridge([
      'session.create',
      'browser.navigate',
    ]);
    const session = await bridge.createSession({ appId: 'browser' });

    await expect(bridge.navigateBrowser({ sessionId: session.id, url: 'https://example.com/path' })).resolves.toEqual({
      ok: true,
      url: 'https://example.com/path',
      title: 'Stub page for https://example.com/path',
    });
  });

  it('provides a Chrome DevTools Protocol navigation adapter skeleton', async () => {
    const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
    const adapter = new ChromeDevToolsBrowserAdapter({
      send: async (method, params) => {
        calls.push({ method, params });
        if (method === 'Runtime.evaluate') {
          return { result: { value: 'CDP page' } };
        }
        return {};
      },
    });
    const bridge = await makeBridge(['session.create', 'browser.navigate'], { browserAdapter: adapter });
    const session = await bridge.createSession({ appId: 'browser' });

    await expect(bridge.navigateBrowser({ sessionId: session.id, url: 'https://example.com/path' })).resolves.toEqual({
      ok: true,
      url: 'https://example.com/path',
      title: 'CDP page',
    });
    expect(calls).toEqual([
      { method: 'Page.enable', params: undefined },
      { method: 'Page.navigate', params: { url: 'https://example.com/path' } },
      { method: 'Runtime.evaluate', params: { expression: 'document.title', returnByValue: true } },
    ]);
  });
});

describe('LocalDesktopBridge sandbox boundaries', () => {
  it('allows file exchange only through the session drop folder', async () => {
    const bridge = await makeBridge([
      'session.create',
      'file.writeDrop',
      'file.readDrop',
    ]);
    const session = await bridge.createSession({ appId: 'browser' });

    await bridge.writeDropFile({ sessionId: session.id, relativePath: 'out/result.txt', contents: 'ok' });

    await expect(bridge.readDropFile({ sessionId: session.id, relativePath: 'out/result.txt' })).resolves.toEqual({
      contents: 'ok',
    });
    await expect(
      bridge.writeDropFile({ sessionId: session.id, relativePath: '../profile/leak.txt', contents: 'no' }),
    ).rejects.toThrow('drop folder paths must stay inside the drop folder');
  });

  it('rejects browser navigation when the network policy denies the URL', async () => {
    const bridge = await makeBridge([
      'session.create',
      'browser.navigate',
    ]);
    const session = await bridge.createSession({ appId: 'browser' });

    await expect(bridge.navigateBrowser({ sessionId: session.id, url: 'https://example.com' })).rejects.toThrow(
      'network denied',
    );
  });

  it('cleans up timed-out sessions', async () => {
    const bridge = await makeBridge(['session.create', 'session.inspect'], { defaultTimeoutMs: 5 });
    const session = await bridge.createSession({ appId: 'browser' });

    await new Promise((resolve) => setTimeout(resolve, 15));

    await expect(bridge.inspectSession(session.id)).rejects.toBeInstanceOf(TimeoutError);
    await expect(fs.stat(session.profileDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

async function makeBridge(
  capabilities: string[],
  options: { browserAdapter?: ChromeDevToolsBrowserAdapter; defaultTimeoutMs?: number } = {},
): Promise<LocalDesktopBridge> {
  return new LocalDesktopBridge({
    auditLog: new InMemoryAuditLog(),
    actor,
    capabilityVerifier: createAllowListCapabilityVerifier(capabilities),
    networkPolicy: capabilities.includes('browser.navigate')
      ? ({ url }) => ({ allow: url.hostname === 'example.com' && url.pathname === '/path' })
      : denyAllNetworkPolicy,
    browserAdapter: options.browserAdapter,
    sandboxRoot: await makeRoot(),
    defaultTimeoutMs: options.defaultTimeoutMs,
  });
}
