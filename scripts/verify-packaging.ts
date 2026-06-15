#!/usr/bin/env tsx
import { access, readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

type DeployKind = 'node-service' | 'node-library';

interface PackageJson {
  name?: string;
  main?: string;
  dependencies?: Record<string, string>;
  deploy?: {
    kind?: DeployKind;
    entrypoint?: string;
    includes?: string[];
  };
}

export interface VerifiedPackage {
  kind: DeployKind;
  name: string;
  path: string;
  entrypoint: string;
}

const deployableWorkspacePaths = ['apps/control-plane-server', 'packages/runtime'] as const;

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readPackageJson(root: string, workspacePath: string): Promise<PackageJson> {
  const packagePath = join(root, workspacePath, 'package.json');
  const raw = await readFile(packagePath, 'utf8');
  return JSON.parse(raw) as PackageJson;
}

function requireString(value: unknown, field: string, packageName: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${packageName} ${field} must be a non-empty string`);
  }
  return value;
}

function requireDeployKind(value: unknown, packageName: string): DeployKind {
  if (value !== 'node-service' && value !== 'node-library') {
    throw new Error(`${packageName} deploy.kind must be node-service or node-library`);
  }
  return value;
}

async function assertPathExists(root: string, workspacePath: string, artifactPath: string, label: string, packageName: string) {
  const fullPath = join(root, workspacePath, artifactPath);
  if (!(await pathExists(fullPath))) {
    throw new Error(`${packageName} ${label} does not exist: ${relative(root, fullPath)}`);
  }
}

async function assertWorkspaceDependencyExists(root: string, dependencyName: string, packageName: string) {
  for (const scope of ['packages', 'apps']) {
    const scopePath = join(root, scope);
    if (!(await pathExists(scopePath))) {
      continue;
    }

    const children = await readdir(scopePath);
    for (const child of children) {
      const workspacePath = `${scope}/${child}`;
      const candidate = await readPackageJson(root, workspacePath);
      if (candidate.name === dependencyName) {
        return;
      }
    }
  }

  throw new Error(`${packageName} depends on workspace package ${dependencyName}, but no package.json declares it`);
}

export async function verifyPackagingManifest(root = process.cwd()): Promise<VerifiedPackage[]> {
  const verified: VerifiedPackage[] = [];

  for (const workspacePath of deployableWorkspacePaths) {
    const packageJson = await readPackageJson(root, workspacePath);
    const packageName = requireString(packageJson.name, 'name', workspacePath);
    const deploy = packageJson.deploy;

    if (!deploy) {
      throw new Error(`${packageName} package.json must declare deploy metadata`);
    }

    const kind = requireDeployKind(deploy.kind, packageName);
    const entrypoint = requireString(deploy.entrypoint, 'deploy.entrypoint', packageName);
    const includes = Array.isArray(deploy.includes) ? deploy.includes : [];
    if (includes.length === 0) {
      throw new Error(`${packageName} deploy.includes must list packaged paths`);
    }

    await assertPathExists(root, workspacePath, entrypoint, 'deploy.entrypoint', packageName);
    for (const includePath of includes) {
      await assertPathExists(root, workspacePath, includePath, 'deploy.includes path', packageName);
    }

    const dependencies = packageJson.dependencies ?? {};
    for (const dependencyName of Object.keys(dependencies).filter((name) => name.startsWith('@fagaos/'))) {
      await assertWorkspaceDependencyExists(root, dependencyName, packageName);
    }

    verified.push({ kind, name: packageName, path: workspacePath, entrypoint });
  }

  return verified;
}

async function main() {
  const packages = await verifyPackagingManifest();
  for (const pkg of packages) {
    // eslint-disable-next-line no-console
    console.log(`${pkg.name}: ${pkg.kind} entrypoint ${pkg.path}/${pkg.entrypoint}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    // eslint-disable-next-line no-console
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
