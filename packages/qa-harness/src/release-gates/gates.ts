import { AdversarialCorpus } from '../corpus/corpus.js';
import type {
  AuditTriageInput,
  AuditTriageReport,
  DependencyAuditFinding,
  DependencyAuditReport,
  GatePolicy,
  GateSectionReport,
  ProviderContractTarget,
  ReleaseGateInput,
  ReleaseGatePlan,
  ReleaseGateReport,
  RuntimeScenarioTarget,
  ThreatCoverageItem,
} from './types.js';

const DEFAULT_POLICY: GatePolicy = {
  failOnSeverities: ['P0', 'P1'],
  minAdversarialPassRate: 1,
  requiredThreatCoverageStatuses: ['covered', 'partial', 'gap'],
  failOnDependencySeverities: ['critical', 'high'],
};

export function createDefaultReleaseGatePlan(): ReleaseGatePlan {
  return {
    policy: DEFAULT_POLICY,
    providerTargets: [
      {
        provider: 'gmail',
        status: 'prerequisite-missing',
        missingPrerequisites: ['FAG-25 staging OAuth client', 'FAG-25 deployed webhook endpoint', 'seed tenant with message history'],
        requiredForRelease: true,
      },
      {
        provider: 'google-calendar',
        status: 'prerequisite-missing',
        missingPrerequisites: ['FAG-25 staging OAuth client', 'calendar sync-token fixture', 'watch-channel callback URL'],
        requiredForRelease: true,
      },
      {
        provider: 'telegram',
        status: 'prerequisite-missing',
        missingPrerequisites: ['FAG-25 bot token fixture', 'webhook signing fixture'],
        requiredForRelease: false,
      },
      {
        provider: 'discord',
        status: 'prerequisite-missing',
        missingPrerequisites: ['FAG-25 gateway staging bot', 'rate-limit fixture'],
        requiredForRelease: false,
      },
    ],
    runtimeTargets: [
      {
        scenario: 'control-plane-session-soak',
        status: 'passed',
        requiredForRelease: true,
      },
      {
        scenario: 'scheduler-lease-chaos',
        status: 'passed',
        requiredForRelease: true,
      },
      {
        scenario: 'connector-sync-soak',
        status: 'prerequisite-missing',
        missingPrerequisites: ['FAG-25 production connector sync implementation'],
        requiredForRelease: true,
      },
      {
        scenario: 'desktop-browser-session-soak',
        status: 'prerequisite-missing',
        missingPrerequisites: ['FAG-26 production desktop/browser runtime'],
        requiredForRelease: true,
      },
    ],
    threatCoverage: [
      {
        id: 'agentic-prompt-injection',
        title: 'Prompt injection and delegated instruction attacks',
        status: 'covered',
        owner: 'QA',
        evidence: ['default adversarial corpus prompt-injection cases'],
      },
      {
        id: 'agentic-sensitive-information-disclosure',
        title: 'Sensitive information disclosure',
        status: 'covered',
        owner: 'QA',
        evidence: ['credential-disclosure and exfiltration corpus categories'],
      },
      {
        id: 'agentic-tool-misuse',
        title: 'Tool misuse and unauthorized action',
        status: 'partial',
        owner: 'Policy/runtime',
        evidence: ['tool-misuse corpus category', 'connector contract idempotency checks'],
        requiredAction: 'Add provider write-operation denial cases once FAG-25 exposes writes.',
      },
      {
        id: 'agentic-memory-poisoning',
        title: 'Memory and long-session state poisoning',
        status: 'gap',
        owner: 'Control plane',
        requiredAction: 'Add long-session resume/checkpoint poisoning cases tied to FAG-21 state models.',
      },
      {
        id: 'agentic-supply-chain',
        title: 'Dependency and tool supply chain',
        status: 'partial',
        owner: 'Security',
        evidence: ['npm audit gate', 'FAG-14 remediation workflow'],
        requiredAction: 'Keep dependency triage in release reports.',
      },
    ],
  };
}

export async function evaluateReleaseGate(input: ReleaseGateInput): Promise<ReleaseGateReport> {
  const corpus = new AdversarialCorpus();
  for (const c of input.adversarialCases) corpus.add(c);
  const adversarial = await corpus.run({ runner: input.adversarialRunner });
  const passRate = adversarial.total === 0 ? 1 : adversarial.passed / adversarial.total;

  const failureReasons: string[] = [];
  if (passRate < input.policy.minAdversarialPassRate) {
    failureReasons.push(`adversarial pass rate ${passRate.toFixed(3)} is below ${input.policy.minAdversarialPassRate}`);
  }
  for (const verdict of adversarial.verdicts) {
    if (verdict.ok) continue;
    const testCase = input.adversarialCases.find((c) => c.id === verdict.caseId);
    if (testCase && input.policy.failOnSeverities.includes(testCase.severity)) {
      failureReasons.push(`adversarial case ${testCase.id} failed at release-blocking severity ${testCase.severity}`);
    }
  }

  const providers = evaluateProviderContracts(input.providerTargets);
  const runtimes = evaluateRuntimeScenarios(input.runtimeTargets);
  const threats = evaluateThreatCoverage(input.threatCoverage, input.policy);
  const dependencies = evaluateDependencyAudit(input.dependencyFindings, input.policy);
  const auditTriage = evaluateAuditTriage(input.auditTriage);

  failureReasons.push(
    ...providers.failures,
    ...runtimes.failures,
    ...threats.failures,
    ...dependencies.failures,
    ...auditTriage.failures,
  );

  return {
    status: failureReasons.length === 0 ? 'pass' : 'fail',
    failureReasons,
    prerequisites: [...providers.prerequisites, ...runtimes.prerequisites],
    actions: [...dependencies.deferred, ...auditTriage.actions],
    sections: {
      adversarial: {
        total: adversarial.total,
        passed: adversarial.passed,
        failed: adversarial.failed,
        passRate,
      },
      providers,
      runtimes,
      threats,
      dependencies,
      auditTriage,
    },
  };
}

export function evaluateProviderContracts(targets: ProviderContractTarget[]): GateSectionReport {
  return evaluateTargets('provider', targets);
}

export function evaluateRuntimeScenarios(targets: RuntimeScenarioTarget[]): GateSectionReport {
  return evaluateTargets('runtime', targets);
}

export function evaluateThreatCoverage(items: ThreatCoverageItem[], policy: GatePolicy): GateSectionReport {
  const failures: string[] = [];
  const prerequisites: string[] = [];
  for (const item of items) {
    if (policy.requiredThreatCoverageStatuses.includes(item.status)) continue;
    const action = item.requiredAction ?? 'define release-gating coverage';
    failures.push(`threat:${item.id} is ${item.status}; owner=${item.owner}; action=${action}`);
  }
  return { failures, prerequisites };
}

export function evaluateDependencyAudit(findings: DependencyAuditFinding[], policy: GatePolicy): DependencyAuditReport {
  const failures: string[] = [];
  const deferred: string[] = [];
  for (const finding of findings) {
    if (finding.decision === 'defer') {
      deferred.push(`dependency:${finding.packageName} ${finding.severity} deferred on ${finding.surface}: ${finding.remediation}`);
    }
    if (finding.decision === 'fix-now' && policy.failOnDependencySeverities.includes(finding.severity)) {
      failures.push(`dependency:${finding.packageName} ${finding.severity} on ${finding.surface} requires fix-now remediation`);
    }
  }
  return { failures, deferred };
}

export function evaluateAuditTriage(input: AuditTriageInput): AuditTriageReport {
  const failures: string[] = [];
  const actions: string[] = [];
  for (const flaky of input.flakyTests) {
    if (!flaky.quarantine) {
      failures.push(`flaky:${flaky.name} is unquarantined; owner=${flaky.owner}`);
    } else {
      actions.push(`flaky:${flaky.name} quarantined owner=${flaky.owner} lastFailure=${flaky.lastFailure}`);
    }
  }
  for (const vulnerability of input.vulnerabilityDecisions) {
    actions.push(
      `vulnerability:${vulnerability.id} ${vulnerability.severity} ${vulnerability.decision} owner=${vulnerability.owner} due=${vulnerability.due}`,
    );
  }
  return { failures, actions };
}

function evaluateTargets(
  prefix: 'provider' | 'runtime',
  targets: Array<ProviderContractTarget | RuntimeScenarioTarget>,
): GateSectionReport {
  const failures: string[] = [];
  const prerequisites: string[] = [];
  for (const target of targets) {
    const name = 'provider' in target ? target.provider : target.scenario;
    if (target.status === 'failed' && target.requiredForRelease) {
      for (const check of target.failedChecks ?? ['unknown check']) {
        failures.push(`${prefix}:${name} failed ${check}`);
      }
    }
    if (target.status === 'prerequisite-missing') {
      for (const prerequisite of target.missingPrerequisites ?? ['unspecified prerequisite']) {
        prerequisites.push(`${prefix}:${name} requires ${prerequisite}`);
      }
    }
    if (target.status === 'not-run' && target.requiredForRelease) {
      failures.push(`${prefix}:${name} was not run`);
    }
  }
  return { failures, prerequisites };
}
