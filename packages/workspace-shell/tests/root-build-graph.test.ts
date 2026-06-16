import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

interface TsConfig {
  references?: Array<{ path?: string }>;
}

const repoRoot = join(__dirname, '../../..');

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function workspaceProjectDirs(scope: string): string[] {
  return readdirSync(join(repoRoot, scope), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `${scope}/${entry.name}`)
    .filter((workspacePath) => existsSync(join(repoRoot, workspacePath, 'tsconfig.json')))
    .sort();
}

describe('root TypeScript build graph', () => {
  it('includes every workspace project so CI emits package exports before tests', () => {
    const rootConfig = readJson<TsConfig>(join(repoRoot, 'tsconfig.json'));
    const references = new Set(
      rootConfig.references?.map((reference) => reference.path?.replace(/^\.\//, '')) ?? [],
    );
    const workspaceProjects = [
      ...workspaceProjectDirs('packages'),
      ...workspaceProjectDirs('apps'),
    ].sort();

    expect([...references].sort()).toEqual(workspaceProjects);
  });
});
