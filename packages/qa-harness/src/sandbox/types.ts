/**
 * Types for the sandbox correctness harness.
 *
 * The harness runs a function in a *child* Node.js process so that:
 *   - timeouts can hard-kill the process group (the parent can SIGKILL)
 *   - memory caps can be enforced via V8 `--max-old-space-size`
 *   - a network denylist can be enforced by *not* loading `net` /
 *     `node:net` adapters in the child and by giving the child a
 *     minimal `globalThis` that does not expose the parent's
 *     `fetch`/`http` clients
 *   - stdout/stderr/exit are captured exactly as the OS saw them
 *
 * The child speaks a tiny line-delimited JSON protocol with the parent
 * (see `harness.ts`). The function-under-test is serialised to a
 * generated module on disk, so we never `eval` user code in the parent.
 */

export interface SandboxOptions {
  /**
   * Wall-clock timeout in milliseconds for the function execution after
   * the child runner has completed its startup handshake. If exceeded,
   * the child process is killed and the result is `SandboxTimeoutError`.
   * Default: 5_000 ms. Must be > 0.
   */
  timeoutMs?: number;
  /**
   * Wall-clock timeout in milliseconds for the child runner to emit its
   * initial ready protocol message. Startup failures are reported as
   * protocol errors, keeping them distinct from function execution
   * timeouts. Default: 5_000 ms. Must be > 0.
   */
  startupTimeoutMs?: number;
  /**
   * V8 old-space heap cap, in MiB, passed to `--max-old-space-size`.
   * Use 0 to skip the heap cap. Default: 256 MiB.
   * The child will exit non-zero if it exceeds this; the harness
   * reports `SandboxMemoryLimitError` in that case.
   */
  memoryLimitMb?: number;
  /**
   * If true, the child is started with `process.noDeprecation = true`
   * and warnings are suppressed. Default: true.
   */
  suppressDeprecations?: boolean;
  /**
   * Hostnames the child is not allowed to contact. The harness enforces
   * this in two ways:
   *   1. The child's `globalThis` does not expose `fetch`, `http`, or
   *      `https` request builders. The child can only call the
   *      provided `hostFetch` helper, which checks the denylist.
   *   2. The child is run with a temp `NODE_OPTIONS=--no-warnings`
   *      and the `globalThis.__fagaosSandbox = true` flag.
   * Matching is by exact hostname or suffix (e.g. `evil.example.com`
   * matches `api.evil.example.com`). Default: empty (no restriction).
   */
  networkDenylist?: string[];
  /**
   * If true, capture stdout/stderr line-by-line. Default: true.
   * Set false to save memory on long-running sandboxes.
   */
  captureOutput?: boolean;
  /**
   * Maximum number of stdout/stderr lines to retain. Default: 1_000.
   * Excess lines are dropped with a `<<truncated>>` marker at the end.
   */
  maxLogLines?: number;
  /**
   * Working directory for the child. Default: `os.tmpdir()`.
   */
  cwd?: string;
  /**
   * Environment variables to expose to the child. The child does NOT
   * inherit the parent's `process.env` unless you opt in by passing
   * `inheritEnv: true` or by listing keys here.
   */
  env?: Record<string, string>;
  /** Forward the parent's environment to the child. Default: false. */
  inheritEnv?: boolean;
}

export type SandboxReason =
  | 'completed'
  | 'timeout'
  | 'memory-limit'
  | 'network-denied'
  | 'crashed'
  | 'protocol-error';

export interface SandboxLogLine {
  /** "stdout" or "stderr". */
  stream: 'stdout' | 'stderr';
  /** Monotonic sequence within the stream. */
  seq: number;
  /** Raw line text without trailing newline. */
  line: string;
}

interface SandboxResultBase {
  /** Why the sandboxed call ended. */
  reason: SandboxReason;
  /** Process exit code or signal, when applicable. */
  exitCode: number | null;
  /** Wall-clock duration of the call in ms. */
  durationMs: number;
  /** Captured stdout lines, in order. */
  stdout: SandboxLogLine[];
  /** Captured stderr lines, in order. */
  stderr: SandboxLogLine[];
  /** Network calls the child attempted, after denylist filtering. */
  networkCalls: NetworkCallRecord[];
}

export interface SandboxSuccess<T> extends SandboxResultBase {
  reason: 'completed';
  /** Decoded return value from the child. */
  value: T;
  /** No thrown error on the success path. */
  error?: undefined;
}

export interface SandboxFailure extends SandboxResultBase {
  reason: Exclude<SandboxReason, 'completed'> | 'completed';
  /** No return value on the failure path. */
  value?: undefined;
  /** Decoded thrown error from the child, or a synthetic one. */
  error: { name: string; message: string; stack?: string };
}

/** Result of a sandboxed call. Discriminated by `reason`. */
export type SandboxResult<T = unknown> = SandboxSuccess<T> | SandboxFailure;

export interface NetworkCallRecord {
  url: string;
  method: string;
  allowed: boolean;
  reason?: string;
  /** Unix-ms when the call was attempted. */
  at: number;
}
