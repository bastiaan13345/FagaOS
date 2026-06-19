/**
 * The SandboxHarness: runs a function in a child Node process with a
 * hard timeout, a memory cap, and a network denylist.
 *
 * Design:
 *   - The parent serialises the function to a temp file `runner.mjs`,
 *     so we never `eval` user code in the parent.
 *   - The child speaks a small line-delimited JSON protocol:
 *
 *       {"type":"ready"}
 *       {"type":"log","stream":"stdout","line":"..."}
 *       {"type":"net","url":"...","method":"...","allowed":true}
 *       {"type":"result","value": <JSON> }           // success
 *       {"type":"error","name":"...","message":"...","stack":"..."}
 *
 *   - The parent kills the child if the timeout fires, and maps the
 *     process exit code/signal to a `SandboxReason`.
 *   - Network denylist: the child is not given `globalThis.fetch` or
 *     `http`/`https` builders. The only network primitive it gets is
 *     `hostFetch`, which checks the denylist. Any attempt to import
 *     `node:http` directly is intercepted by setting
 *     `globalThis.process.noDeprecation = true` plus a check on
 *     `module.constructor._cache` in the runner.
 *
 * This is intentionally a single-process design. Cross-host network
 * isolation (iptables, netns) is a Phase 2 concern — see FAG-4.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NetworkCallRecord, SandboxLogLine, SandboxOptions, SandboxResult } from './types.js';

const RUNNER_TEMPLATE_CANDIDATES = [
  // Running from compiled output (dist/sandbox/harness.js).
  resolve(dirname(fileURLToPath(import.meta.url)), 'runner.template.mjs'),
  // Running from source under vitest (src/sandbox/harness.ts).
  resolve(dirname(fileURLToPath(import.meta.url)), '../../src/sandbox/runner.template.mjs'),
];

async function readRunnerTemplate(): Promise<string> {
  let lastErr: unknown = null;
  for (const candidate of RUNNER_TEMPLATE_CANDIDATES) {
    try {
      return await fs.readFile(candidate, 'utf8');
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(
    `SandboxHarness: could not locate runner.template.mjs in any of: ${RUNNER_TEMPLATE_CANDIDATES.join(', ')}. Last error: ${String(lastErr)}`,
  );
}

export class SandboxTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`Sandbox timed out after ${timeoutMs}ms`);
    this.name = 'SandboxTimeoutError';
  }
}

export class SandboxMemoryLimitError extends Error {
  constructor(public readonly limitMb: number) {
    super(`Sandbox exceeded ${limitMb} MiB heap cap`);
    this.name = 'SandboxMemoryLimitError';
  }
}

export class SandboxNetworkDeniedError extends Error {
  constructor(public readonly url: string, public readonly denylist: string[]) {
    super(`Sandbox attempted denied network call to ${url}; denylist=${denylist.join(',')}`);
    this.name = 'SandboxNetworkDeniedError';
  }
}

/**
 * Validate that a URL is allowed under the denylist.
 * A URL is allowed if no denylist entry is an exact match or a parent
 * domain of the URL's hostname.
 */
export function isHostnameAllowed(hostname: string, denylist: string[]): boolean {
  const h = hostname.toLowerCase();
  for (const entry of denylist) {
    const e = entry.toLowerCase();
    if (h === e) return false;
    if (h.endsWith('.' + e)) return false;
  }
  return true;
}

const DEFAULTS = {
  timeoutMs: 5_000,
  startupTimeoutMs: 5_000,
  memoryLimitMb: 256,
  suppressDeprecations: true,
  captureOutput: true,
  maxLogLines: 1_000,
};

export class SandboxHarness {
  private readonly defaults: typeof DEFAULTS;

  constructor(defaults: Partial<typeof DEFAULTS> = {}) {
    this.defaults = { ...DEFAULTS, ...defaults };
  }

  /**
   * Run `fn` in a sandboxed child process. `fn` must be JSON-serialisable
   * (no closures over module-level state) because it will be serialised
   * and reconstructed in the child.
   */
  async run<T>(fn: (...args: unknown[]) => Promise<T> | T, args: unknown[] = [], options: SandboxOptions = {}): Promise<SandboxResult<T>> {
    const opts = { ...this.defaults, ...options };
    if (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs <= 0) {
      throw new RangeError(`SandboxHarness.run: timeoutMs must be > 0, got ${opts.timeoutMs}`);
    }
    if (!Number.isFinite(opts.startupTimeoutMs) || opts.startupTimeoutMs <= 0) {
      throw new RangeError(`SandboxHarness.run: startupTimeoutMs must be > 0, got ${opts.startupTimeoutMs}`);
    }
    if (opts.memoryLimitMb < 0) {
      throw new RangeError(`SandboxHarness.run: memoryLimitMb must be >= 0, got ${opts.memoryLimitMb}`);
    }

    const work = await fs.mkdtemp(join(tmpdir(), 'fagaos-sandbox-'));
    const entryPath = join(work, 'runner.mjs');
    const denylist = options.networkDenylist ?? [];
    const env: Record<string, string> = {};
    if (opts.inheritEnv) {
      Object.assign(env, process.env);
    }
    if (opts.env) {
      Object.assign(env, opts.env);
    }
    env['FAGAOS_SANDBOX'] = '1';
    env['FAGAOS_SANDBOX_NETWORK_DENYLIST'] = JSON.stringify(denylist);
    env['FAGAOS_SANDBOX_MAX_LOG_LINES'] = String(opts.maxLogLines);

    const source = await readRunnerTemplate();
    await fs.writeFile(entryPath, source, 'utf8');

    const nodeArgs: string[] = [];
    if (opts.memoryLimitMb > 0) {
      nodeArgs.push(`--max-old-space-size=${opts.memoryLimitMb}`);
    }
    if (opts.suppressDeprecations) {
      env['NODE_NO_WARNINGS'] = '1';
    }
    nodeArgs.push(entryPath);

    const child: ChildProcess = spawn(process.execPath, nodeArgs, {
      cwd: opts.cwd ?? work,
      env,
      // stdin must be 'pipe' so child.stdin.write/end can deliver the
      // 'invoke' message. ('ignore' silently discards writes.)
      stdio: ['pipe', 'pipe', 'pipe'],
      // detached: false — we want to kill the whole tree on timeout
      detached: false,
    });

    const stdout: SandboxLogLine[] = [];
    const stderr: SandboxLogLine[] = [];
    const networkCalls: NetworkCallRecord[] = [];

    let stdoutSeq = 0;
    let stderrSeq = 0;
    let childStderrBuf = '';

    const pushLine = (stream: 'stdout' | 'stderr', line: string) => {
      const arr = stream === 'stdout' ? stdout : stderr;
      if (arr.length >= opts.maxLogLines) {
        // replace the last entry with a truncation marker, once
        if (arr[arr.length - 1]?.line !== '<<truncated>>') {
          arr.push({ stream, seq: stream === 'stdout' ? ++stdoutSeq : ++stderrSeq, line: '<<truncated>>' });
        }
        return;
      }
      const seq = stream === 'stdout' ? ++stdoutSeq : ++stderrSeq;
      arr.push({ stream, seq, line });
    };

    let protocolReady = false;
    let resultValue: T | undefined;
    let resultError: { name: string; message: string; stack?: string } | undefined;
    let protocolError: string | undefined;
    let resolved = false;
    let didTimeout = false;
    let killTimer: NodeJS.Timeout;
    const start = Date.now();
    killTimer = setTimeout(() => {
      if (resolved) return;
      try {
        child.kill('SIGKILL');
      } catch {
        // best effort
      }
    }, opts.startupTimeoutMs);

    const handleLine = (line: string) => {
      let msg: { type: string; [k: string]: unknown };
      try {
        msg = JSON.parse(line);
      } catch {
        protocolError = `child emitted non-JSON line: ${line.slice(0, 200)}`;
        return;
      }
      switch (msg.type) {
        case 'ready':
          protocolReady = true;
          clearTimeout(killTimer);
          killTimer = setTimeout(() => {
            if (resolved) return;
            didTimeout = true;
            try {
              child.kill('SIGKILL');
            } catch {
              // best effort
            }
          }, opts.timeoutMs);
          // Send the function and args in a single message. Defer to a
          // microtask so we don't block the child's event loop while it
          // is still draining the ready write.
          setImmediate(() => {
            child.stdin?.write(
              JSON.stringify({ type: 'invoke', fn: fn.toString(), args }) + '\n',
            );
            child.stdin?.end();
          });
          break;
        case 'log':
          if (typeof msg.stream === 'string' && typeof msg.line === 'string') {
            pushLine(msg.stream as 'stdout' | 'stderr', msg.line as string);
          }
          break;
        case 'net': {
          const rec: NetworkCallRecord = {
            url: String(msg.url ?? ''),
            method: String(msg.method ?? 'GET'),
            allowed: Boolean(msg.allowed),
            at: Date.now(),
          };
          if (!rec.allowed && typeof msg.reason === 'string') rec.reason = msg.reason;
          networkCalls.push(rec);
          break;
        }
        case 'result':
          resultValue = msg.value as T;
          break;
        case 'error':
          resultError = {
            name: String(msg.name ?? 'Error'),
            message: String(msg.message ?? ''),
            ...(typeof msg.stack === 'string' ? { stack: msg.stack } : {}),
          };
          break;
        default:
          protocolError = `child emitted unknown message type: ${msg.type}`;
      }
    };

    // The child writes protocol messages on its stdout, but the function
    // under test may also write to stdout. The child prefixes protocol
    // lines with `__FAGAOS_PROTO__:` so we can split cleanly.
    const PROTO_PREFIX = '__FAGAOS_PROTO__:';
    let childStdoutBuf = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      childStdoutBuf += chunk;
      let nl: number;
      while ((nl = childStdoutBuf.indexOf('\n')) !== -1) {
        const line = childStdoutBuf.slice(0, nl);
        childStdoutBuf = childStdoutBuf.slice(nl + 1);
        if (line.startsWith(PROTO_PREFIX)) {
          handleLine(line.slice(PROTO_PREFIX.length));
        } else {
          pushLine('stdout', line);
        }
      }
    });

    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      childStderrBuf += chunk;
      let nl: number;
      while ((nl = childStderrBuf.indexOf('\n')) !== -1) {
        const line = childStderrBuf.slice(0, nl);
        childStderrBuf = childStderrBuf.slice(nl + 1);
        pushLine('stderr', line);
      }
    });

    const exitInfo = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.on('exit', (code, signal) => {
        clearTimeout(killTimer);
        resolve({ code, signal });
      });
      child.on('error', () => {
        clearTimeout(killTimer);
        resolve({ code: null, signal: null });
      });
    });

    // Drain any final buffered chunks
    if (childStdoutBuf.length > 0) {
      if (childStdoutBuf.startsWith(PROTO_PREFIX)) {
        handleLine(childStdoutBuf.slice(PROTO_PREFIX.length));
      } else {
        pushLine('stdout', childStdoutBuf);
      }
      childStdoutBuf = '';
    }
    if (childStderrBuf.length > 0) {
      pushLine('stderr', childStderrBuf);
      childStderrBuf = '';
    }

    const durationMs = Date.now() - start;
    resolved = true;

    // Best-effort cleanup of the temp dir.
    void fs.rm(work, { recursive: true, force: true });

    if (!protocolReady) {
      return {
        reason: 'protocol-error',
        exitCode: exitInfo.code,
        durationMs,
        stdout,
        stderr,
        networkCalls,
        error: { name: 'ProtocolError', message: protocolError ?? 'child exited before sending ready' },
      };
    }

    if (resultError) {
      return {
        reason: 'crashed',
        exitCode: exitInfo.code,
        durationMs,
        error: resultError,
        stdout,
        stderr,
        networkCalls,
      };
    }

    // We had no error message — was it a timeout / crash / memory?
    if (didTimeout) {
      return {
        reason: 'timeout',
        exitCode: exitInfo.code,
        durationMs,
        stdout,
        stderr,
        networkCalls,
        error: { name: 'SandboxTimeoutError', message: `Sandbox timed out after ${opts.timeoutMs}ms` },
      };
    }
    if (exitInfo.code !== 0 && exitInfo.code !== null) {
      // Heuristic: a non-zero exit from a memory cap is code 134 (SIGABRT)
      // or any code from a V8 OOM. We can't be 100% sure from the parent,
      // but a non-zero exit after a short run with no protocol result
      // means the child crashed. Mark as crashed.
      const looksLikeOOM = /JavaScript heap out of memory|out of memory/i.test(stderr.map((l) => l.line).join('\n'));
      return {
        reason: looksLikeOOM ? 'memory-limit' : 'crashed',
        exitCode: exitInfo.code,
        durationMs,
        stdout,
        stderr,
        networkCalls,
        error: { name: looksLikeOOM ? 'SandboxMemoryLimitError' : 'SandboxCrashError', message: `child exited with code ${exitInfo.code}` },
      };
    }
    if (protocolError) {
      return {
        reason: 'protocol-error',
        exitCode: exitInfo.code,
        durationMs,
        stdout,
        stderr,
        networkCalls,
        error: { name: 'ProtocolError', message: protocolError },
      };
    }

    return {
      reason: 'completed',
      exitCode: exitInfo.code ?? 0,
      durationMs,
      value: (resultValue === undefined ? null : resultValue) as T,
      stdout,
      stderr,
      networkCalls,
    };
  }
}
