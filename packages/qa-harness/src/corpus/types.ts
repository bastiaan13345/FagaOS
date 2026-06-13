/**
 * Types for the adversarial corpus.
 *
 * The corpus is a versioned, in-memory collection of attack cases
 * grouped by category. Each case has:
 *   - a `prompt` (the input to the system under test)
 *   - a `category` (what attack class it represents)
 *   - a `severity` (P0..P3, mirroring the QA strategy's defect SLAs)
 *   - a list of `expectations` — assertions the harness checks after
 *     running the case. The default `run()` is regex-based, so a
 *     caller can extend it with custom matchers via `defineMatcher`.
 *
 * Phase 1 ships seed cases. The full release-gating corpus grows as
 * the security team adds cases; the API is intentionally additive.
 */

export type AdversarialCategory =
  | 'prompt-injection'
  | 'sandbox-escape'
  | 'exfiltration'
  | 'tool-misuse'
  | 'credential-disclosure';

export type AdversarialSeverity = 'P0' | 'P1' | 'P2' | 'P3';

export interface AdversarialExpectation {
  /** Human description of what the case asserts. */
  description: string;
  /** Regex the response must NOT match. */
  forbid?: RegExp;
  /** Regex the response must match (multiline). */
  require?: RegExp;
  /** Marker on stdout/stderr that must NOT appear. */
  forbidLogLine?: RegExp;
}

export interface AdversarialCase {
  id: string;
  category: AdversarialCategory;
  severity: AdversarialSeverity;
  description: string;
  prompt: string;
  expectations: AdversarialExpectation[];
  /**
   * Free-form provenance: where the case came from (CVE, bug bounty
   * report, internal red team, OWASP Agentic Top 10 ID, etc.).
   */
  source?: string;
}

export type AdversarialVerdict =
  | { caseId: string; ok: true }
  | { caseId: string; ok: false; failedExpectations: string[] };

export interface RunAdversarialOptions {
  /** Runner used to invoke the system under test. */
  runner: (prompt: string) => Promise<AdversarialRunResult> | AdversarialRunResult;
  /** Stop on first failure. Default: false. */
  stopOnFirstFailure?: boolean;
  /** Filter to a single category. Default: undefined (all). */
  category?: AdversarialCategory;
  /** Filter to a maximum severity. Default: undefined (all). */
  maxSeverity?: AdversarialSeverity;
}

export interface AdversarialRunResult {
  /** The textual response the system produced. */
  response: string;
  /** Combined stdout from the run (for log-line assertions). */
  stdout?: string;
  /** Combined stderr from the run. */
  stderr?: string;
  /** True iff the system tried to make a network call outside the denylist. */
  madeExternalCall?: boolean;
}
