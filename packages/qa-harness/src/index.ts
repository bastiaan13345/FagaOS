/**
 * @fagaos/qa-harness — public entry point.
 *
 * This package ships three pieces of QA infrastructure for FagaOS:
 *
 *   - `sandbox` (./sandbox)    — SandboxHarness: run a function in an
 *                                 isolated child process with a configurable
 *                                 timeout, memory cap, and network denylist.
 *   - `contracts` (./contracts) — ConnectorContractSuite: parameterised
 *                                 tests every connector must pass.
 *   - `corpus` (./corpus)       — AdversarialCorpus: seed cases for prompt
 *                                 injection, sandbox escape, and exfiltration.
 *   - `fixtures` (./fixtures)   — Mock providers for Gmail/Graph push,
 *                                 Meta, Telegram, and Discord.
 *   - `release-gates`           — Release readiness policy, prereq tracking,
 *                                 and JSON reporting for Phase 2 QA.
 *
 * The package is Phase 1 (FAG-12) scope. It is not the full
 * desktop/browser automation harness — that lands under FAG-4.
 */

export type { SandboxOptions, SandboxResult, SandboxReason, SandboxLogLine } from './sandbox/types.js';
export { SandboxHarness, SandboxTimeoutError, SandboxMemoryLimitError, SandboxNetworkDeniedError } from './sandbox/harness.js';
export { isLikelySandboxEscape, isLikelyExfiltration, isLikelyPromptInjection } from './corpus/detectors.js';

export type { Connector } from '@fagaos/connectors';

export type {
  ContractSuiteOptions,
  ContractTestContext,
  ContractCheck,
  ContractCheckResult,
  ContractSuiteResult,
} from './contracts/types.js';
export { ConnectorContractSuite, defineCheck } from './contracts/suite.js';

export type { AdversarialCase, AdversarialCategory, AdversarialVerdict } from './corpus/types.js';
export { AdversarialCorpus, seedCorpus } from './corpus/corpus.js';
export { defaultSeedCases } from './corpus/seed.js';
export {
  createDefaultReleaseGatePlan,
  evaluateAuditTriage,
  evaluateDependencyAudit,
  evaluateProviderContracts,
  evaluateReleaseGate,
  evaluateRuntimeScenarios,
  evaluateThreatCoverage,
} from './release-gates/index.js';
export type {
  AuditTriageInput,
  DependencyAuditFinding,
  GatePolicy,
  ProviderContractTarget,
  ReleaseGateReport,
  RuntimeScenarioTarget,
  ThreatCoverageItem,
} from './release-gates/index.js';
