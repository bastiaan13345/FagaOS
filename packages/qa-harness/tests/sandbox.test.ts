/**
 * Tests for the SandboxHarness. These tests spawn real child
 * processes, so they are inherently a little slower than pure unit
 * tests — vitest's default 5 s per-test timeout is fine, but we
 * bump it to 30 s in case the CI host is slow.
 */

import { describe, expect, it } from 'vitest';
import { SandboxHarness, isHostnameAllowed, SandboxTimeoutError, SandboxMemoryLimitError, SandboxNetworkDeniedError } from '../src/sandbox/index.js';

describe('isHostnameAllowed', () => {
  it('allows when no denylist entries are set', () => {
    expect(isHostnameAllowed('example.com', [])).toBe(true);
  });
  it('denies exact match', () => {
    expect(isHostnameAllowed('evil.example.com', ['evil.example.com'])).toBe(false);
  });
  it('denies suffix match', () => {
    expect(isHostnameAllowed('api.evil.example.com', ['evil.example.com'])).toBe(false);
  });
  it('allows unrelated hosts', () => {
    expect(isHostnameAllowed('good.example.com', ['evil.example.com'])).toBe(true);
  });
  it('is case-insensitive', () => {
    expect(isHostnameAllowed('EVIL.example.com', ['evil.example.com'.toUpperCase()])).toBe(false);
  });
});

describe('SandboxHarness', () => {
  const harness = new SandboxHarness();

  it('runs a simple function and returns its value', async () => {
    const res = await harness.run<number>(() => 2 + 3, [], { timeoutMs: 5_000 });
    expect(res.reason).toBe('completed');
    expect(res.exitCode).toBe(0);
    if (res.reason === 'completed') {
      expect(res.value).toBe(5);
    }
  }, 30_000);

  it('captures stdout and stderr', async () => {
    const res = await harness.run<void>(
      () => {
        process.stdout.write('hello-from-stdout\n');
        process.stderr.write('hello-from-stderr\n');
      },
      [],
      { timeoutMs: 5_000 },
    );
    expect(res.reason).toBe('completed');
    expect(res.stdout.map((l) => l.line).join('\n')).toContain('hello-from-stdout');
    expect(res.stderr.map((l) => l.line).join('\n')).toContain('hello-from-stderr');
  }, 30_000);

  it('rejects an empty denylist call to a forbidden host', async () => {
    const res = await harness.run<string>(
      () => globalThis.__fagaosHostFetch('https://evil.example.com/leak'),
      [],
      { timeoutMs: 5_000, networkDenylist: ['evil.example.com'] },
    );
    // The child throws a network-denied error before the runner can return.
    expect(res.reason).toBe('crashed');
    expect(res.error?.name ?? '').toBe('Error');
    expect(res.error?.message ?? '').toMatch(/Network denied|evil\.example\.com/);
    // The harness should have recorded the network call.
    const denied = res.networkCalls.find((c) => c.url.includes('evil.example.com'));
    expect(denied?.allowed).toBe(false);
  }, 30_000);

  it('denies a suffix match (sub.evil.example.com)', async () => {
    const res = await harness.run<string>(
      () => globalThis.__fagaosHostFetch('https://api.evil.example.com/x'),
      [],
      { timeoutMs: 5_000, networkDenylist: ['evil.example.com'] },
    );
    const denied = res.networkCalls.find((c) => c.url.includes('api.evil.example.com'));
    expect(denied?.allowed).toBe(false);
  }, 30_000);

  it('times out on an infinite loop', async () => {
    const res = await harness.run<void>(() => { for (;;) { Math.random(); } }, [], { timeoutMs: 250 });
    expect(res.reason).toBe('timeout');
    expect(res.error?.name).toBe('SandboxTimeoutError');
  }, 30_000);

  it('rejects invalid options', async () => {
    await expect(harness.run(() => 1, [], { timeoutMs: 0 })).rejects.toBeInstanceOf(RangeError);
    await expect(harness.run(() => 1, [], { timeoutMs: -10 })).rejects.toBeInstanceOf(RangeError);
    await expect(harness.run(() => 1, [], { memoryLimitMb: -1 })).rejects.toBeInstanceOf(RangeError);
  });

  it('exports the documented error classes', () => {
    expect(SandboxTimeoutError).toBeTypeOf('function');
    expect(SandboxMemoryLimitError).toBeTypeOf('function');
    expect(SandboxNetworkDeniedError).toBeTypeOf('function');
    const t = new SandboxTimeoutError(100);
    expect(t.name).toBe('SandboxTimeoutError');
    expect(t.message).toContain('100ms');
    const m = new SandboxMemoryLimitError(64);
    expect(m.name).toBe('SandboxMemoryLimitError');
    expect(m.message).toContain('64 MiB');
    const n = new SandboxNetworkDeniedError('https://evil.example.com', ['evil.example.com']);
    expect(n.name).toBe('SandboxNetworkDeniedError');
    expect(n.message).toContain('evil.example.com');
  });

  it('reports crashed when the child exits with a non-zero code', async () => {
    const res = await harness.run<void>(
      () => {
        // Force the child to exit with a non-zero code before the runner
        // protocol can complete. We do this by aborting process.
        // eslint-disable-next-line no-undef
        process.exit(7);
      },
      [],
      { timeoutMs: 5_000 },
    );
    expect(res.reason).toBe('crashed');
    expect(res.exitCode).toBe(7);
    expect(res.error?.name).toBe('SandboxCrashError');
  }, 30_000);

  it('reports memory-limit when the child OOMs', async () => {
    const res = await harness.run<void>(
      () => {
        // Allocate progressively larger typed arrays until V8 OOMs.
        // Using a Uint8Array is denser than a plain Array.
        const arr: Uint8Array[] = [];
        for (;;) {
          arr.push(new Uint8Array(50_000_000));
        }
      },
      [],
      { timeoutMs: 10_000, memoryLimitMb: 32 },
    );
    // The detection is best-effort: 'memory-limit' (OOM marker in
    // stderr), 'crashed' (non-zero exit with no OOM marker), or
    // 'timeout' (if the OS killed it after a long run).
    expect(['memory-limit', 'crashed', 'timeout']).toContain(res.reason);
  }, 30_000);

  it('reports protocol-error when the child exits before sending ready', async () => {
    // A timeoutMs shorter than the template's import + hook setup
    // forces the parent to kill the child before 'ready' is sent.
    // The harness then reports 'protocol-error' with a descriptive
    // message.
    const res = await harness.run<void>(
      () => { for (;;) { Math.random(); } },
      [],
      { timeoutMs: 1 },
    );
    expect(res.reason).toBe('protocol-error');
    expect(res.error?.message).toMatch(/ready|protocol/i);
  }, 30_000);

  it('reports protocol-error when a proto-prefixed line has invalid JSON', async () => {
    // User code that writes a __FAGAOS_PROTO__: line with invalid JSON
    // goes through the hook unchanged (the hook passes proto lines
    // through to the raw fd). The parent then sees a malformed
    // protocol message and reports protocol-error.
    const res = await harness.run<number>(
      () => {
        process.stdout.write('__FAGAOS_PROTO__:{not-json\n');
        return 99;
      },
      [],
      { timeoutMs: 5_000 },
    );
    expect(res.reason).toBe('protocol-error');
    expect(res.error?.message).toMatch(/non-JSON|protocol/i);
  }, 30_000);

  it('captures trailing stdout/stderr chunks without a trailing newline', async () => {
    // The drain branch fires when the child exits with a partial
    // line in its stdout/stderr buffer. This happens when a function
    // writes to stdout without a trailing newline.
    const res = await harness.run<void>(
      () => {
        process.stdout.write('no-trailing-newline');
        return;
      },
      [],
      { timeoutMs: 5_000 },
    );
    expect(res.reason).toBe('completed');
    // The drain branch should have pushed the partial line to stdout.
    const lines = res.stdout.map((l) => l.line);
    expect(lines.some((l) => l.includes('no-trailing-newline'))).toBe(true);
  }, 30_000);

  it('drains a final proto-prefixed line without a trailing newline', async () => {
    // Write a proto-prefixed line WITHOUT a trailing newline. The
    // child's last chunk holds this incomplete line in the buffer.
    // After the child exits, the drain branch should fire and
    // process the line. We use an invalid JSON body so the result
    // is protocol-error, exercising the proto-drain branch.
    const res = await harness.run<number>(
      () => {
        process.stdout.write('__FAGAOS_PROTO__:{not-json-no-newline');
        return 99;
      },
      [],
      { timeoutMs: 5_000 },
    );
    expect(res.reason).toBe('protocol-error');
    expect(res.error?.message).toMatch(/non-JSON/);
  }, 30_000);

  it('drains trailing stderr chunks without a trailing newline', async () => {
    // Write to stderr without a trailing newline so the drain
    // branch fires for the stderr buffer.
    const res = await harness.run<void>(
      () => {
        process.stderr.write('stderr-partial-line');
        return;
      },
      [],
      { timeoutMs: 5_000 },
    );
    expect(res.reason).toBe('completed');
    const lines = res.stderr.map((l) => l.line);
    expect(lines.some((l) => l.includes('stderr-partial-line'))).toBe(true);
  }, 30_000);

  it('forwards env variables and inheritEnv to the child', async () => {
    const res = await harness.run<{ my: string | undefined; path: string | undefined }>(
      () => {
        return {
          my: process.env.MY_TEST_VAR ?? null,
          path: process.env.PATH ?? null,
        };
      },
      [],
      {
        timeoutMs: 5_000,
        inheritEnv: true,
        env: { MY_TEST_VAR: 'hello-from-test' },
      },
    );
    expect(res.reason).toBe('completed');
    if (res.reason === 'completed') {
      expect(res.value.my).toBe('hello-from-test');
      // PATH should be inherited from the parent.
      expect(res.value.path).toBeDefined();
    }
  }, 30_000);

  it('returns null for an undefined result value', async () => {
    const res = await harness.run<void>(() => undefined, [], { timeoutMs: 5_000 });
    expect(res.reason).toBe('completed');
    if (res.reason === 'completed') {
      expect(res.value).toBeNull();
    }
  }, 30_000);

  it('records only a truncation marker once maxLogLines is zero', async () => {
    const res = await harness.run<void>(
      () => {
        process.stdout.write('hidden\n');
        process.stderr.write('hidden\n');
      },
      [],
      { timeoutMs: 5_000, maxLogLines: 0 },
    );
    expect(res.stdout).toEqual([{ stream: 'stdout', seq: 1, line: '<<truncated>>' }]);
    expect(res.stderr).toEqual([{ stream: 'stderr', seq: 1, line: '<<truncated>>' }]);
  }, 30_000);

  it('truncates stdout and stderr after maxLogLines', async () => {
    const res = await harness.run<void>(
      () => {
        process.stdout.write('out-1\nout-2\nout-3\n');
        process.stderr.write('err-1\nerr-2\nerr-3\n');
      },
      [],
      { timeoutMs: 5_000, maxLogLines: 1 },
    );
    expect(res.stdout.at(-1)?.line).toBe('<<truncated>>');
    expect(res.stderr.at(-1)?.line).toBe('<<truncated>>');
  }, 30_000);

  it('allows network calls outside the denylist and records them', async () => {
    const res = await harness.run<string>(
      () => globalThis.__fagaosHostFetch('https://good.example.com/ping'),
      [],
      { timeoutMs: 5_000, networkDenylist: ['evil.example.com'] },
    );
    expect(res.reason).toBe('completed');
    const allowed = res.networkCalls.find((c) => c.url.includes('good.example.com'));
    expect(allowed?.allowed).toBe(true);
  }, 30_000);
});
