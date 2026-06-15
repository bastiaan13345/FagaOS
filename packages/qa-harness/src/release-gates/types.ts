import type { AdversarialCase, AdversarialRunResult, AdversarialSeverity } from '../corpus/types.js';

export type ReleaseGateStatus = 'pass' | 'fail';
export type TargetStatus = 'passed' | 'failed' | 'prerequisite-missing' | 'not-run';
export type ThreatCoverageStatus = 'covered' | 'partial' | 'gap' | 'not-applicable';
export type DependencySeverity = 'info' | 'low' | 'moderate' | 'high' | 'critical';
export type DependencySurface = 'runtime' | 'dev-tooling' | 'test-only' | 'unknown';
export type DependencyDecision = 'fix-now' | 'defer' | 'accept-risk';

export interface GatePolicy {
  failOnSeverities: AdversarialSeverity[];
  minAdversarialPassRate: number;
  requiredThreatCoverageStatuses: ThreatCoverageStatus[];
  failOnDependencySeverities: DependencySeverity[];
}

export interface ProviderContractTarget {
  provider: string;
  status: TargetStatus;
  missingPrerequisites?: string[];
  failedChecks?: string[];
  requiredForRelease: boolean;
}

export interface RuntimeScenarioTarget {
  scenario: string;
  status: TargetStatus;
  missingPrerequisites?: string[];
  failedChecks?: string[];
  requiredForRelease: boolean;
}

export interface ThreatCoverageItem {
  id: string;
  title: string;
  status: ThreatCoverageStatus;
  owner: string;
  evidence?: string[];
  requiredAction?: string;
}

export interface DependencyAuditFinding {
  packageName: string;
  severity: DependencySeverity;
  surface: DependencySurface;
  remediation: string;
  decision: DependencyDecision;
}

export interface FlakyTestTriage {
  name: string;
  owner: string;
  quarantine: boolean;
  lastFailure: string;
}

export interface VulnerabilityDecision {
  id: string;
  severity: DependencySeverity;
  owner: string;
  decision: DependencyDecision;
  due: string;
}

export interface AuditTriageInput {
  flakyTests: FlakyTestTriage[];
  vulnerabilityDecisions: VulnerabilityDecision[];
}

export interface ReleaseGatePlan {
  policy: GatePolicy;
  providerTargets: ProviderContractTarget[];
  runtimeTargets: RuntimeScenarioTarget[];
  threatCoverage: ThreatCoverageItem[];
}

export interface ReleaseGateInput extends ReleaseGatePlan {
  adversarialCases: AdversarialCase[];
  adversarialRunner: (prompt: string) => Promise<AdversarialRunResult> | AdversarialRunResult;
  dependencyFindings: DependencyAuditFinding[];
  auditTriage: AuditTriageInput;
}

export interface GateSectionReport {
  failures: string[];
  prerequisites: string[];
}

export interface DependencyAuditReport {
  failures: string[];
  deferred: string[];
}

export interface AuditTriageReport {
  failures: string[];
  actions: string[];
}

export interface ReleaseGateReport {
  status: ReleaseGateStatus;
  failureReasons: string[];
  prerequisites: string[];
  actions: string[];
  sections: {
    adversarial: {
      total: number;
      passed: number;
      failed: number;
      passRate: number;
    };
    providers: GateSectionReport;
    runtimes: GateSectionReport;
    threats: GateSectionReport;
    dependencies: DependencyAuditReport;
    auditTriage: AuditTriageReport;
  };
}
