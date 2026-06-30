import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { verifyPackagingManifest } from './verify-packaging.js';

async function createWorkspace() {
  const root = await mkdtemp(join(tmpdir(), 'fagaos-packaging-'));

  await mkdir(join(root, 'apps/control-plane-server/dist'), { recursive: true });
  await mkdir(join(root, 'packages/control-plane/dist'), { recursive: true });
  await mkdir(join(root, 'packages/runtime/dist'), { recursive: true });

  await writeFile(
    join(root, 'apps/control-plane-server/package.json'),
    JSON.stringify({
      name: '@fagaos/control-plane-server',
      main: 'dist/main.js',
      deploy: {
        kind: 'node-service',
        entrypoint: 'dist/main.js',
        includes: ['dist', 'package.json'],
      },
      dependencies: {
        '@fagaos/control-plane': '*',
      },
    }),
  );
  await writeFile(
    join(root, 'packages/runtime/package.json'),
    JSON.stringify({
      name: '@fagaos/runtime',
      main: 'dist/index.js',
      deploy: {
        kind: 'node-library',
        entrypoint: 'dist/index.js',
        includes: ['dist', 'package.json'],
      },
    }),
  );
  await writeFile(
    join(root, 'packages/control-plane/package.json'),
    JSON.stringify({
      name: '@fagaos/control-plane',
      main: 'dist/index.js',
    }),
  );
  await writeFile(join(root, 'apps/control-plane-server/dist/main.js'), '');
  await writeFile(join(root, 'packages/runtime/dist/index.js'), '');

  return root;
}

describe('verifyPackagingManifest', () => {
  test('accepts deployable workspaces with built entrypoints and local package dependencies', async () => {
    const root = await createWorkspace();

    await expect(verifyPackagingManifest(root)).resolves.toEqual([
      {
        kind: 'node-service',
        name: '@fagaos/control-plane-server',
        path: 'apps/control-plane-server',
        entrypoint: 'dist/main.js',
      },
      {
        kind: 'node-library',
        name: '@fagaos/runtime',
        path: 'packages/runtime',
        entrypoint: 'dist/index.js',
      },
    ]);
  });

  test('reports missing build artifacts before a package is handed to deployment', async () => {
    const root = await createWorkspace();
    await writeFile(
      join(root, 'packages/runtime/package.json'),
      JSON.stringify({
        name: '@fagaos/runtime',
        main: 'dist/index.js',
        deploy: {
          kind: 'node-library',
          entrypoint: 'dist/missing.js',
          includes: ['dist', 'package.json'],
        },
      }),
    );

    await expect(verifyPackagingManifest(root)).rejects.toThrow(
      '@fagaos/runtime deploy.entrypoint does not exist: packages/runtime/dist/missing.js',
    );
  });
});
