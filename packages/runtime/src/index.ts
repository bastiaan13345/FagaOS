/**
 * @fagaos/runtime — sandboxed execution plane.
 *
 * Phase 0 (FAG-8) ships the interface only. Phase 1 will implement:
 *   - WASM runner (Wasmtime) for LLM-generated code, network-off, 30s cap
 *   - per-agent OS process under dedicated user with seccomp-bpf profile
 *   - gVisor container for untrusted MCP servers
 * See docs/architecture.md §6 for the full four-layer sandbox design.
 */

export interface SandboxLimits {
  /** Wall-clock cap in milliseconds. */
  wallTimeMs: number;
  /** Maximum memory in bytes. */
  memoryBytes: number;
  /** Egress rules. Empty = no network. */
  networkEgress?: ReadonlyArray<{ host: string; port: number }>;
}

export interface SandboxResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** Time elapsed in milliseconds. */
  elapsedMs: number;
  /** True if the run hit the wall-time cap. */
  timedOut: boolean;
}

export interface Sandbox {
  run(input: { code: string; argv: ReadonlyArray<string> }, limits: SandboxLimits): Promise<SandboxResult>;
}

export const RUNTIME_NOT_IMPLEMENTED =
  'Sandboxed runtime (WASM, seccomp, gVisor) lands in Phase 1. Phase 0 ships the interface only.';
