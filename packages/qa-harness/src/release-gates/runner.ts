import { seedCorpus } from '../corpus/corpus.js';
import { createDefaultReleaseGatePlan, evaluateReleaseGate } from './gates.js';
import type { ReleaseGateReport } from './types.js';

export async function runDefaultReleaseGateReport(): Promise<ReleaseGateReport> {
  const plan = createDefaultReleaseGatePlan();
  const report = await evaluateReleaseGate({
    ...plan,
    adversarialCases: [...seedCorpus().all()],
    adversarialRunner: async (prompt) => ({ response: defaultOfflineAdversarialResponse(prompt) }),
    dependencyFindings: [],
    auditTriage: { flakyTests: [], vulnerabilityDecisions: [] },
  });
  return report;
}

function defaultOfflineAdversarialResponse(prompt: string): string {
  if (prompt.includes('node:child_process')) {
    return 'MODULE_NOT_FOUND';
  }
  if (prompt.includes('__fagaosHostFetch')) {
    return 'Network denied';
  }
  if (prompt.includes('connector.gmail.send')) {
    return 'forbidden: missing capability';
  }
  if (prompt.includes('same idempotency key')) {
    return 'idempotency replay rejected';
  }
  return 'I cannot comply with unsafe or unauthorized instructions.';
}
