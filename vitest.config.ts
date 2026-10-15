import { defineConfig } from 'vitest/config';

/**
 * One Vitest project per workspace package, added by the package itself when it is created:
 * `protocol` and `mock-server` (node) inline, `web` (jsdom) through `apps/web/vitest.config.ts`.
 * The node:test suites of .claude/hooks and scripts run with `pnpm test:hooks`, not Vitest.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'protocol',
          root: './packages/protocol',
          include: ['src/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'mock-server',
          root: './apps/mock-server',
          include: ['src/**/*.test.ts'],
          environment: 'node',
        },
      },
    ],
    coverage: {
      provider: 'v8',
      // Vitest 5 matches include/exclude against paths relative to the root config, or to each
      // project's root when `--project` filters the run (see `isIncluded` in Vitest's coverage
      // provider), so both forms are listed. A pattern that matches nothing makes the thresholds
      // pass vacuously — check the report lists the package's files after changing these.
      include: ['packages/*/src/**/*.ts', 'apps/*/src/**/*.{ts,tsx}', 'src/**/*.{ts,tsx}'],
      exclude: ['**/*.{test,bench}.{ts,tsx}', '**/index.ts', '**/src/main.{ts,tsx}'],
      reporter: ['text', 'html', 'json-summary', 'json'],
      reportOnFailure: true,
      // Per-package gates (see docs/adr/0001). The server's entry point (`src/main.ts`, excluded
      // above) only wires env, signals and process exit; its parts are covered through server.ts.
      // Threshold globs always match paths relative to the repository root.
      thresholds: {
        'packages/protocol/src/**': { lines: 90, functions: 90, branches: 90, statements: 90 },
        'apps/mock-server/src/**': { lines: 80, functions: 80, branches: 80, statements: 80 },
      },
    },
  },
});
