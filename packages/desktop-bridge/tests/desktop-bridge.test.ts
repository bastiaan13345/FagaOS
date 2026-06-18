import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { InMemoryAuditLog } from '@fagaos/audit-log';
import {
  type BrowserAdapter,
  CapabilityDeniedError,
  ChromeDevToolsBrowserAdapter,
  type DesktopRuntimeAdapter,
  LocalDesktopBridge,
  TimeoutError,
  type RemoteWorkerProvisioner,
  createAllowListCapabilityVerifier,
  createHostDesktopAdapter,
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

  it('cleans up provisioned resources when adapter session creation fails', async () => {
    const root = await makeRoot();
    const released: string[] = [];
    const provisioner: RemoteWorkerProvisioner = {
      provision: async ({ session }) => ({
        id: `worker-${session.id}`,
        target: 'linux-x11-cdp',
      }),
      release: async ({ session, worker }) => {
        released.push(`${worker.id}:${session.id}`);
      },
    };
    const bridge = new LocalDesktopBridge({
      auditLog: new InMemoryAuditLog(),
      actor,
      capabilityVerifier: createAllowListCapabilityVerifier(['session.create']),
      sandboxRoot: root,
      remoteWorkerProvisioner: provisioner,
      desktopAdapter: {
        createSession: async () => {
          throw new Error('desktop launch failed');
        },
      },
    });

    await expect(bridge.createSession({ appId: 'browser' })).rejects.toThrow('desktop launch failed');

    expect(released).toHaveLength(1);
    await expect(fs.readdir(root)).resolves.toEqual([]);
  });

  it('runs every cleanup step before surfacing teardown failures', async () => {
    const calls: string[] = [];
    const provisioner: RemoteWorkerProvisioner = {
      provision: async ({ session }) => ({
        id: `worker-${session.id}`,
        target: 'linux-x11-cdp',
      }),
      release: async ({ session, worker }) => {
        calls.push(`release:${worker.id}:${session.id}`);
      },
    };
    const bridge = new LocalDesktopBridge({
      auditLog: new InMemoryAuditLog(),
      actor,
      capabilityVerifier: createAllowListCapabilityVerifier([
        'session.create',
        'session.terminate',
        'session.inspect',
      ]),
      sandboxRoot: await makeRoot(),
      remoteWorkerProvisioner: provisioner,
      browserAdapter: {
        navigate: async ({ url }) => ({ ok: true, url, title: 'runtime browser' }),
        teardownSession: async ({ session }) => {
          calls.push(`browser-teardown:${session.id}`);
          throw new Error('browser teardown failed');
        },
      },
      desktopAdapter: {
        terminateSession: async ({ session }) => {
          calls.push(`desktop-terminate:${session.id}`);
        },
      },
    });
    const session = await bridge.createSession({ appId: 'browser' });

    await expect(bridge.terminateSession(session.id)).rejects.toThrow('cleanup failed');

    expect(calls).toEqual([
      `browser-teardown:${session.id}`,
      `desktop-terminate:${session.id}`,
      `release:worker-${session.id}:${session.id}`,
    ]);
    await expect(fs.stat(session.profileDir)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(bridge.inspectSession(session.id)).resolves.toMatchObject({ status: 'terminated' });
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

  it('passes operation-specific resource context to capability checks before dispatch', async () => {
    const seenResources: Array<{ operation: string; resource: Record<string, unknown> | undefined }> = [];
    const browserAdapter: BrowserAdapter = {
      navigate: async ({ url }) => ({ ok: true, url, title: 'runtime browser' }),
    };
    const bridge = new LocalDesktopBridge({
      auditLog: new InMemoryAuditLog(),
      actor,
      browserAdapter,
      capabilityVerifier: (request) => {
        seenResources.push({ operation: request.operation, resource: request.resource });
        return { allow: true };
      },
      networkPolicy: ({ url }) => ({ allow: url.hostname === 'example.com' }),
      sandboxRoot: await makeRoot(),
    });
    const session = await bridge.createSession({ appId: 'browser', auditCorrelationId: 'corr-create' });

    await bridge.clickMouse({ sessionId: session.id, x: 12, y: 34, button: 'right', auditCorrelationId: 'corr-click' });
    await bridge.writeClipboard({ sessionId: session.id, text: 'copy text', auditCorrelationId: 'corr-clip-write' });
    await bridge.navigateBrowser({ sessionId: session.id, url: 'https://example.com/path', auditCorrelationId: 'corr-nav' });
    await bridge.writeDropFile({
      sessionId: session.id,
      relativePath: 'out/result.txt',
      contents: 'file text',
      auditCorrelationId: 'corr-drop-write',
    });

    expect(seenResources).toEqual(expect.arrayContaining([
      {
        operation: 'mouse.click',
        resource: {
          auditCorrelationId: 'corr-click',
          x: 12,
          y: 34,
          button: 'right',
        },
      },
      {
        operation: 'clipboard.write',
        resource: {
          auditCorrelationId: 'corr-clip-write',
          textLength: 9,
        },
      },
      {
        operation: 'browser.navigate',
        resource: {
          auditCorrelationId: 'corr-nav',
          url: 'https://example.com/path',
          origin: 'https://example.com',
          protocol: 'https:',
          hostname: 'example.com',
        },
      },
      {
        operation: 'file.writeDrop',
        resource: {
          auditCorrelationId: 'corr-drop-write',
          relativePath: 'out/result.txt',
          contentsLength: 9,
        },
      },
    ]));
  });

  it('lets capability policy deny navigation by requested URL before network dispatch', async () => {
    let networkChecks = 0;
    let adapterCalls = 0;
    const bridge = new LocalDesktopBridge({
      auditLog: new InMemoryAuditLog(),
      actor,
      browserAdapter: {
        navigate: async ({ url }) => {
          adapterCalls += 1;
          return { ok: true, url, title: 'runtime browser' };
        },
      },
      capabilityVerifier: (request) => (
        request.operation === 'browser.navigate' && request.resource?.hostname === 'blocked.example'
          ? { allow: false, reason: 'blocked_host' }
          : { allow: true }
      ),
      networkPolicy: () => {
        networkChecks += 1;
        return { allow: true };
      },
      sandboxRoot: await makeRoot(),
    });
    const session = await bridge.createSession({ appId: 'browser' });

    await expect(bridge.navigateBrowser({ sessionId: session.id, url: 'https://blocked.example/path' }))
      .rejects.toBeInstanceOf(CapabilityDeniedError);

    expect(networkChecks).toBe(0);
    expect(adapterCalls).toBe(0);
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

  it('rejects drop file reads through symlinks that resolve outside the drop folder', async () => {
    const bridge = await makeBridge([
      'session.create',
      'file.readDrop',
    ]);
    const session = await bridge.createSession({ appId: 'browser' });
    const outside = join(await makeRoot(), 'secret.txt');
    await fs.writeFile(outside, 'secret', 'utf8');
    await fs.symlink(outside, join(session.dropDir, 'linked-secret.txt'));

    await expect(
      bridge.readDropFile({ sessionId: session.id, relativePath: 'linked-secret.txt' }),
    ).rejects.toThrow('drop folder paths must stay inside the drop folder');
  });

  it('rejects drop file writes through symlinks without modifying the target', async () => {
    const bridge = await makeBridge([
      'session.create',
      'file.writeDrop',
    ]);
    const session = await bridge.createSession({ appId: 'browser' });
    const outside = join(await makeRoot(), 'secret.txt');
    await fs.writeFile(outside, 'original', 'utf8');
    await fs.symlink(outside, join(session.dropDir, 'linked-secret.txt'));

    await expect(
      bridge.writeDropFile({ sessionId: session.id, relativePath: 'linked-secret.txt', contents: 'changed' }),
    ).rejects.toThrow('drop folder paths must stay inside the drop folder');
    await expect(fs.readFile(outside, 'utf8')).resolves.toBe('original');
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

describe('LocalDesktopBridge production runtime seams', () => {
  it('requires explicit runtime adapters in production mode', async () => {
    expect(() => new LocalDesktopBridge({
      auditLog: new InMemoryAuditLog(),
      actor,
      capabilityVerifier: createAllowListCapabilityVerifier(['session.create']),
      sandboxRoot: '/tmp/fagaos-production-test',
      mode: 'production',
    })).toThrow('production mode requires an explicit browserAdapter');
  });

  it('does not fall back to deterministic desktop results in production mode', async () => {
    const bridge = new LocalDesktopBridge({
      auditLog: new InMemoryAuditLog(),
      actor,
      capabilityVerifier: createAllowListCapabilityVerifier(['session.create', 'screenshot.capture']),
      sandboxRoot: await makeRoot(),
      mode: 'production',
      browserAdapter: {
        navigate: async ({ url }) => ({ ok: true, url, title: 'runtime browser' }),
      },
      desktopAdapter: {},
    });
    const session = await bridge.createSession({ appId: 'browser' });

    await expect(bridge.captureScreenshot({ sessionId: session.id })).rejects.toThrow(
      'production mode requires desktop adapter support for screenshot.capture',
    );
  });

  it('dispatches desktop operations through an injected runtime adapter and audits correlation ids', async () => {
    const auditLog = new InMemoryAuditLog();
    const calls: string[] = [];
    const desktopAdapter: DesktopRuntimeAdapter = {
      createSession: async ({ session }) => {
        calls.push(`create:${session.id}`);
      },
      captureScreenshot: async ({ session }) => {
        calls.push(`screenshot:${session.id}`);
        return {
          mimeType: 'image/png',
          width: 2,
          height: 1,
          dataBase64: 'runtime-png',
        };
      },
      clickMouse: async ({ x, y, button }) => {
        calls.push(`click:${x}:${y}:${button}`);
        return { ok: true, kind: 'mouse.click' };
      },
      typeKeyboard: async ({ text }) => {
        calls.push(`type:${text}`);
        return { ok: true, kind: 'keyboard.type' };
      },
      writeClipboard: async ({ text }) => {
        calls.push(`clip-write:${text}`);
        return { ok: true, kind: 'clipboard.write' };
      },
      readClipboard: async () => {
        calls.push('clip-read');
        return { text: 'from-runtime' };
      },
      terminateSession: async ({ session }) => {
        calls.push(`terminate:${session.id}`);
      },
    };
    const seenCapabilities: string[] = [];
    const bridge = new LocalDesktopBridge({
      auditLog,
      actor,
      desktopAdapter,
      capabilityVerifier: (request) => {
        seenCapabilities.push(`${request.operation}:${request.resource?.auditCorrelationId ?? 'none'}`);
        return { allow: true };
      },
      sandboxRoot: await makeRoot(),
    });

    const session = await bridge.createSession({ appId: 'browser', auditCorrelationId: 'corr-create' });
    await expect(
      bridge.captureScreenshot({ sessionId: session.id, auditCorrelationId: 'corr-shot' }),
    ).resolves.toMatchObject({ width: 2, dataBase64: 'runtime-png' });
    await bridge.clickMouse({ sessionId: session.id, x: 12, y: 34, button: 'right', auditCorrelationId: 'corr-click' });
    await bridge.typeKeyboard({ sessionId: session.id, text: 'hello', auditCorrelationId: 'corr-type' });
    await bridge.writeClipboard({ sessionId: session.id, text: 'copy', auditCorrelationId: 'corr-clip-write' });
    await expect(
      bridge.readClipboard({ sessionId: session.id, auditCorrelationId: 'corr-clip-read' }),
    ).resolves.toEqual({ text: 'from-runtime' });
    await bridge.terminateSession(session.id, { auditCorrelationId: 'corr-term' });

    expect(calls).toEqual([
      `create:${session.id}`,
      `screenshot:${session.id}`,
      'click:12:34:right',
      'type:hello',
      'clip-write:copy',
      'clip-read',
      `terminate:${session.id}`,
    ]);
    expect(seenCapabilities).toContain('screenshot.capture:corr-shot');
    const screenshotAudit = (await auditLog.query()).find(
      (entry) => entry.action.name === 'desktopBridge.screenshot.capture',
    );
    expect(screenshotAudit?.payload).toMatchObject({
      auditCorrelationId: 'corr-shot',
      adapter: 'runtime',
    });
  });

  it('runs browser profile lifecycle hooks and exposes inspection streams without owning the transport', async () => {
    const browserCalls: string[] = [];
    const browserAdapter: BrowserAdapter = {
      createSession: async ({ session }) => {
        browserCalls.push(`browser-create:${session.profileDir}`);
      },
      inspectSession: async ({ session }) => ({
        endpoint: `cdp://${session.id}`,
        profileDir: session.profileDir,
        streamStatus: 'available',
      }),
      openInspectionStream: async ({ session }) => ({
        kind: 'browser.inspectionStream',
        url: `wss://stream.local/${session.id}`,
        expiresAt: session.expiresAt,
      }),
      navigate: async ({ url }) => ({
        ok: true,
        url,
        title: 'runtime browser',
      }),
      teardownSession: async ({ session }) => {
        browserCalls.push(`browser-teardown:${session.id}`);
      },
    };
    const bridge = await makeBridge([
      'session.create',
      'session.inspect',
      'session.stream.open',
      'browser.navigate',
      'session.terminate',
    ], { browserAdapter });
    const session = await bridge.createSession({ appId: 'browser' });

    await expect(bridge.inspectSession(session.id)).resolves.toMatchObject({
      browser: {
        endpoint: `cdp://${session.id}`,
        profileDir: session.profileDir,
        streamStatus: 'available',
      },
    });
    await expect(bridge.openInspectionStream({ sessionId: session.id })).resolves.toMatchObject({
      kind: 'browser.inspectionStream',
      url: `wss://stream.local/${session.id}`,
    });
    await expect(bridge.navigateBrowser({ sessionId: session.id, url: 'https://example.com/path' })).resolves.toEqual({
      ok: true,
      url: 'https://example.com/path',
      title: 'runtime browser',
    });
    await bridge.terminateSession(session.id);

    expect(browserCalls).toEqual([
      `browser-create:${session.profileDir}`,
      `browser-teardown:${session.id}`,
    ]);
  });

  it('keeps remote worker provisioning as an injected lifecycle seam', async () => {
    const provisioned: string[] = [];
    const released: string[] = [];
    const provisioner: RemoteWorkerProvisioner = {
      provision: async ({ session }) => {
        provisioned.push(session.id);
        return {
          id: `worker-${session.id}`,
          target: 'linux-x11-cdp',
          endpoint: `ssh://${session.id}`,
        };
      },
      release: async ({ worker, session }) => {
        released.push(`${worker.id}:${session.id}`);
      },
    };
    const bridge = await makeBridge(['session.create', 'session.inspect', 'session.terminate'], { provisioner });

    const session = await bridge.createSession({ appId: 'browser' });

    await expect(bridge.inspectSession(session.id)).resolves.toMatchObject({
      worker: {
        id: `worker-${session.id}`,
        target: 'linux-x11-cdp',
      },
    });
    await bridge.terminateSession(session.id);
    expect(provisioned).toEqual([session.id]);
    expect(released).toEqual([`worker-${session.id}:${session.id}`]);
  });
});

describe('host desktop adapter command paths', () => {
  it('maps linux desktop operations to host command runner calls', async () => {
    const commands: Array<{ command: string; args: string[]; stdin?: string }> = [];
    const adapter = createHostDesktopAdapter({
      target: 'linux-x11-cdp',
      commandRunner: async (command) => {
        commands.push(command);
        return { stdout: command.command === 'xclip' ? 'clipboard text' : STUB_SCREENSHOT_BYTES };
      },
    });
    const session = await makeRuntimeSession();

    await expect(adapter.captureScreenshot({ session })).resolves.toMatchObject({
      mimeType: 'image/png',
      dataBase64: Buffer.from(STUB_SCREENSHOT_BYTES).toString('base64'),
    });
    await adapter.clickMouse({ session, x: 10, y: 20, button: 'left' });
    await adapter.typeKeyboard({ session, text: 'hello' });
    await adapter.writeClipboard({ session, text: 'copy' });
    await expect(adapter.readClipboard({ session })).resolves.toEqual({ text: 'clipboard text' });

    expect(commands).toEqual([
      { command: 'import', args: ['-window', 'root', 'png:-'] },
      { command: 'xdotool', args: ['mousemove', '10', '20', 'click', '1'] },
      { command: 'xdotool', args: ['type', '--clearmodifiers', 'hello'] },
      { command: 'xclip', args: ['-selection', 'clipboard'], stdin: 'copy' },
      { command: 'xclip', args: ['-selection', 'clipboard', '-o'] },
    ]);
  });
});

async function makeBridge(
  capabilities: string[],
  options: {
    browserAdapter?: BrowserAdapter;
    defaultTimeoutMs?: number;
    provisioner?: RemoteWorkerProvisioner;
  } = {},
): Promise<LocalDesktopBridge> {
  return new LocalDesktopBridge({
    auditLog: new InMemoryAuditLog(),
    actor,
    capabilityVerifier: createAllowListCapabilityVerifier(capabilities),
    networkPolicy: capabilities.includes('browser.navigate')
      ? ({ url }) => ({ allow: url.hostname === 'example.com' && url.pathname === '/path' })
      : denyAllNetworkPolicy,
    browserAdapter: options.browserAdapter,
    remoteWorkerProvisioner: options.provisioner,
    sandboxRoot: await makeRoot(),
    defaultTimeoutMs: options.defaultTimeoutMs,
  });
}

async function makeRuntimeSession() {
  const root = await makeRoot();
  return {
    id: 'desk_test',
    appId: 'browser',
    status: 'active' as const,
    profileDir: join(root, 'profile'),
    dropDir: join(root, 'drop'),
    createdAt: 0,
    expiresAt: 60_000,
  };
}

const STUB_SCREENSHOT_BYTES = new Uint8Array([137, 80, 78, 71]);
