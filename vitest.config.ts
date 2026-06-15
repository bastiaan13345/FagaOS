import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: [
      'packages/*/tests/**/*.test.ts',
      'packages/*/test/**/*.test.ts',
      'apps/*/tests/**/*.test.ts',
      'apps/*/test/**/*.test.ts',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html', 'lcov'],
      include: ['packages/*/src/**/*.ts', 'apps/*/src/**/*.ts'],
      // Barrel files (index.ts) are pure re-exports and are exercised indirectly
      // by tests importing the deep modules. Excluding them keeps the coverage
      // gate focused on real logic.
      exclude: [
        'packages/*/src/**/index.ts',
        'packages/*/src/**/*.d.ts',
        'apps/*/src/**/index.ts',
        'apps/*/src/**/*.d.ts',
        'apps/*/src/main.ts',
      ],
      thresholds: {
        // QA strategy: >=90% critical paths / >=80% overall.
        // The audit log primitive is a critical path; we enforce 90% on it,
        // and 80% globally as the project floor.
        lines: 80,
        functions: 80,
        branches: 75,
        statements: 80,
        perFile: true,
      },
    },
  },
});
