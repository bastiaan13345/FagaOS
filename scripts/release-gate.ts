import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { runDefaultReleaseGateReport } from '../packages/qa-harness/src/release-gates/runner.js';

async function main(): Promise<void> {
  const outputPath = process.argv[2] ?? 'coverage/release-gate-report.json';
  const report = await runDefaultReleaseGateReport();

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`release gate ${report.status}; report=${outputPath}\n`);

  if (report.status === 'fail') {
    for (const reason of report.failureReasons) {
      process.stderr.write(`${reason}\n`);
    }
    process.exitCode = 1;
  }
}

void main();
