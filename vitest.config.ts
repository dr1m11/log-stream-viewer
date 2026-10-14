import { defineConfig, type TestProjectConfiguration } from 'vitest/config';

/**
 * One Vitest project per workspace package, added by the package itself when it is created:
 * `protocol` and `mock-server` (node) inline, `web` (jsdom) through `apps/web/vitest.config.ts`.
 */
const projects: TestProjectConfiguration[] = [];

export default defineConfig({
  test: {
    // Vitest rejects an empty `projects` list. Until the first package exists, the root is the only
    // project and has no test files (the node:test suites of .claude/hooks and scripts run with
    // `pnpm test:hooks`, not Vitest).
    ...(projects.length > 0 ? { projects } : { include: [], passWithNoTests: true }),
    coverage: {
      provider: 'v8',
      // Vitest matches include/exclude against paths relative to each project's root
      // (packages/protocol, apps/mock-server, apps/web), so these patterns cover every project.
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['**/*.test.{ts,tsx}', '**/index.ts', 'src/main.{ts,tsx}'],
      reporter: ['text', 'html', 'json-summary', 'json'],
      reportOnFailure: true,
      // Per-package gates are added with the packages (protocol 90%, mock-server 80%).
      // Unlike include/exclude, threshold globs match paths relative to the repository root.
      thresholds: {},
    },
  },
});
