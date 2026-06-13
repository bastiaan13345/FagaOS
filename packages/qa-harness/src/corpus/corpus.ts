/**
 * AdversarialCorpus: versioned, in-memory collection of attack cases.
 *
 * The corpus is a plain JS array under the hood, but every mutation
 * is timestamped and the version monotonically increases. This makes
 * the corpus safe to share across processes (in the v0 file-backed
 * variant, see `seedCorpus`).
 *
 * Cases are run via `run(options)`, which delegates to a caller-supplied
 * `runner` so the corpus is runner-agnostic. The default runner in the
 * test suite invokes the SandboxHarness with a deny-all network policy.
 */

import { randomUUID } from 'node:crypto';
import type {
  AdversarialCase,
  AdversarialCategory,
  AdversarialRunResult,
  AdversarialSeverity,
  AdversarialVerdict,
  RunAdversarialOptions,
} from './types.js';
import { defaultSeedCases } from './seed.js';

const SEVERITY_RANK: Record<AdversarialSeverity, number> = {
  P0: 0,
  P1: 1,
  P2: 2,
  P3: 3,
};

export class AdversarialCorpus {
  private readonly cases: AdversarialCase[] = [];
  private version = 0;
  private readonly createdAt = Date.now();

  /** Add a case. Returns the assigned `id` (caller-provided or generated). */
  add(input: Omit<AdversarialCase, 'id'> & { id?: string }): string {
    const id = input.id ?? `adv-${randomUUID()}`;
    if (this.cases.some((c) => c.id === id)) {
      throw new Error(`AdversarialCorpus.add: duplicate id ${id}`);
    }
    this.cases.push({ ...input, id });
    this.version += 1;
    return id;
  }

  /** Remove a case by id. Returns true if it existed. */
  remove(id: string): boolean {
    const before = this.cases.length;
    this.cases.splice(
      this.cases.findIndex((c) => c.id === id),
      1,
    );
    const removed = this.cases.length < before;
    if (removed) this.version += 1;
    return removed;
  }

  /** All cases, in insertion order. */
  all(): readonly AdversarialCase[] {
    return this.cases.slice();
  }

  /** Cases filtered by category and/or severity. */
  filter(opts: { category?: AdversarialCategory; maxSeverity?: AdversarialSeverity }): AdversarialCase[] {
    return this.cases.filter((c) => {
      if (opts.category && c.category !== opts.category) return false;
      if (opts.maxSeverity && SEVERITY_RANK[c.severity] > SEVERITY_RANK[opts.maxSeverity]) return false;
      return true;
    });
  }

  /** Count by category — useful for dashboards. */
  counts(): Record<AdversarialCategory, number> {
    const out: Record<AdversarialCategory, number> = {
      'prompt-injection': 0,
      'sandbox-escape': 0,
      exfiltration: 0,
      'tool-misuse': 0,
      'credential-disclosure': 0,
    };
    for (const c of this.cases) out[c.category] += 1;
    return out;
  }

  getVersion(): number {
    return this.version;
  }

  getCreatedAt(): number {
    return this.createdAt;
  }

  /**
   * Run all matching cases against `runner`. Returns a verdict per
   * case and a summary. Never throws — failures are reported per case.
   */
  async run(options: RunAdversarialOptions): Promise<{
    verdicts: AdversarialVerdict[];
    total: number;
    passed: number;
    failed: number;
    durationMs: number;
  }> {
    const start = Date.now();
    const cases = this.filter({
      ...(options.category ? { category: options.category } : {}),
      ...(options.maxSeverity ? { maxSeverity: options.maxSeverity } : {}),
    });

    const verdicts: AdversarialVerdict[] = [];
    let passed = 0;
    let failed = 0;
    for (const c of cases) {
      let result: AdversarialRunResult;
      try {
        result = await options.runner(c.prompt);
      } catch (err) {
        const e = err as Error;
        verdicts.push({
          caseId: c.id,
          ok: false,
          failedExpectations: [`runner threw: ${e.name}: ${e.message}`],
        });
        failed++;
        if (options.stopOnFirstFailure) break;
        continue;
      }
      const failedExpectations: string[] = [];
      for (const exp of c.expectations) {
        if (exp.require && !exp.require.test(result.response)) {
          failedExpectations.push(`required pattern not present: ${exp.description}`);
        }
        if (exp.forbid && exp.forbid.test(result.response)) {
          failedExpectations.push(`forbidden pattern present: ${exp.description}`);
        }
        if (exp.forbidLogLine) {
          const combined = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
          if (exp.forbidLogLine.test(combined)) {
            failedExpectations.push(`forbidden log line: ${exp.description}`);
          }
        }
      }
      if (failedExpectations.length === 0) {
        verdicts.push({ caseId: c.id, ok: true });
        passed++;
      } else {
        verdicts.push({ caseId: c.id, ok: false, failedExpectations });
        failed++;
        if (options.stopOnFirstFailure) break;
      }
    }
    return { verdicts, total: cases.length, passed, failed, durationMs: Date.now() - start };
  }
}

/** Build a fresh corpus populated with the default seed cases. */
export function seedCorpus(): AdversarialCorpus {
  const c = new AdversarialCorpus();
  for (const seed of defaultSeedCases()) {
    c.add(seed);
  }
  return c;
}
