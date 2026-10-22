// @ts-check
import { builtinModules } from 'node:module';

import js from '@eslint/js';
import eslintReact from '@eslint-react/eslint-plugin';
import vitest from '@vitest/eslint-plugin';
import { defineConfig, globalIgnores } from 'eslint/config';
import prettier from 'eslint-config-prettier/flat';
import jsxA11y from 'eslint-plugin-jsx-a11y-x';
import playwright from 'eslint-plugin-playwright';
import reactHooks from 'eslint-plugin-react-hooks';
import { reactRefresh } from 'eslint-plugin-react-refresh';
import simpleImportSort from 'eslint-plugin-simple-import-sort';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// ---------------------------------------------------------------------------------------------
// Import boundaries (docs/adr/0001). Patterns are anchored regexes, not gitignore-style groups,
// so they only match bare package specifiers and never segments of relative paths
// (`./events/log-event.ts` is fine, `events` is not).
//
// Flat config REPLACES the options of `no-restricted-imports` when a later block sets the rule for
// overlapping files. Always build the rule with `restrictImports(...)` and pass every pattern list
// that applies to those files (e.g. `restrictImports(WEB_IMPORT_BANS, newPatterns)`), otherwise
// the earlier bans are silently dropped.
// ---------------------------------------------------------------------------------------------

/** @typedef {{ group: string[], message: string } | { regex: string, message: string }} ImportPattern */

/**
 * @param {...ImportPattern[]} patternLists
 * @returns {['error', { patterns: ImportPattern[] }]}
 */
function restrictImports(...patternLists) {
  return ['error', { patterns: patternLists.flat() }];
}

/** `react`, `react-dom/client`, `react-error-boundary`, … and `ws`, `ws/lib/sender.js`. */
const REACT_OR_WS_RE = '^(react(-[^/]+)?|ws)(/|$)';
const REACT_RE = '^react(-[^/]+)?(/|$)';
/** `node:*` and bare built-in names with optional subpaths (`fs`, `fs/promises`, `events`). */
const NODE_BUILTINS_RE = `^(node:|(${builtinModules
  .filter((name) => !name.startsWith('node:'))
  .join('|')})(/|$))`;

/**
 * Bans imports of one app from the other: the web client and the mock server share only
 * @lsv/protocol. Relative paths match only when they enter the sibling app (`../../web/src/…`,
 * `../../../apps/web/…`), not a same-named folder inside the importing app (`../web/handler.ts`).
 * @param {string} app directory name under apps/
 * @returns {ImportPattern[]}
 */
function otherAppImports(app) {
  const message = `Do not import from apps/${app}; share code through @lsv/protocol (see docs/adr/0001).`;
  return [
    { group: [`@lsv/${app}`, `@lsv/${app}/*`], message },
    {
      regex: `^(\\.\\./)+(apps/${app}(/|$)|${app}/(src|e2e|public|package\\.json)(/|$))`,
      message,
    },
  ];
}

const PACKAGES_MESSAGE =
  'packages/* are framework-free: no React, ws or Node built-ins (see docs/adr/0001).';
const APPS_FROM_PACKAGES_MESSAGE =
  'packages/* must not import the apps; the apps depend on packages, not the other way round (see docs/adr/0001).';

/** @type {ImportPattern[]} */
const WEB_IMPORT_BANS = otherAppImports('mock-server');
/** @type {ImportPattern[]} */
const WEB_TEST_DOUBLE_BANS = [
  {
    group: ['@/shared/lib/testing', '@/shared/lib/testing/*'],
    message: 'Test doubles are for *.test.ts(x) files only; keep them out of the app bundle.',
  },
];
/** @type {ImportPattern[]} */
const SERVER_IMPORT_BANS = [
  { regex: REACT_RE, message: 'The mock server does not use React (see docs/adr/0001).' },
  ...otherAppImports('web'),
];
const PURE_SERVER_MESSAGE =
  'The generator, scheduler, budget, hub, rate limiter and client-ip helpers are pure: no Node APIs, sockets, wall clock or Math.random — take time as an argument and randomness from the seeded Prng (see .claude/rules/mock-server.md).';
/** @type {ImportPattern[]} */
const PURE_SERVER_IMPORT_BANS = [
  { regex: NODE_BUILTINS_RE, message: PURE_SERVER_MESSAGE },
  { regex: '^ws(/|$)', message: PURE_SERVER_MESSAGE },
];
/** @type {ImportPattern[]} */
const APPS_FROM_PACKAGES_BANS = [
  {
    group: ['@lsv/web', '@lsv/web/*', '@lsv/mock-server', '@lsv/mock-server/*'],
    message: APPS_FROM_PACKAGES_MESSAGE,
  },
  // From packages/<name>/... the repository root is at least two levels up.
  { regex: '^(\\.\\./){2,}apps(/|$)', message: APPS_FROM_PACKAGES_MESSAGE },
];

/**
 * Globals no package may use (`no-restricted-globals` options are replaced, not merged, by a later
 * block for the same files, so every block that sets the rule spreads this list).
 * @type {{ name: string, message: string }[]}
 */
const PACKAGE_GLOBAL_BANS = [
  ...['window', 'document', 'navigator', 'location', 'localStorage', 'sessionStorage'].map(
    (name) => ({ name, message: 'packages/* must not depend on browser APIs.' }),
  ),
  ...['process', 'Buffer', 'require', '__dirname', '__filename'].map((name) => ({
    name,
    message: 'packages/* must not depend on Node APIs.',
  })),
];
const CORE_CLOCK_MESSAGE =
  '@lsv/core takes time as an argument (`now`): no clocks, timers or animation frames inside (see docs/adr/0006).';
/** @type {{ name: string, message: string }[]} */
const CORE_CLOCK_BANS = [
  'Date',
  'performance',
  'setTimeout',
  'setInterval',
  'requestAnimationFrame',
].map((name) => ({ name, message: CORE_CLOCK_MESSAGE }));

export default defineConfig(
  globalIgnores([
    '**/dist/',
    '**/coverage/',
    '**/playwright-report/',
    '**/test-results/',
    '**/blob-report/',
    '**/.lighthouseci/',
    '**/.wrangler/',
    '.local/',
    // Git worktrees of Claude Code agents: full checkouts that lint themselves.
    '.claude/worktrees/',
  ]),
  {
    linterOptions: { reportUnusedDisableDirectives: 'error' },
  },
  {
    files: ['**/*.{ts,tsx,mts,cts,js,mjs,cjs}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.strictTypeChecked,
      tseslint.configs.stylisticTypeChecked,
    ],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { 'simple-import-sort': simpleImportSort },
    rules: {
      'simple-import-sort/imports': 'error',
      'simple-import-sort/exports': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      'no-restricted-syntax': [
        'error',
        { selector: 'ExportDefaultDeclaration', message: 'Use named exports.' },
      ],
    },
  },
  {
    // Plain JS here is tooling (configs, Claude hooks, scripts): Node globals, no type-aware rules.
    // `tsc` still type-checks it through JSDoc (root tsconfig.json, checkJs).
    files: ['**/*.{js,mjs,cjs}'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { globals: globals.node },
  },
  {
    // Classic scripts served as-is to the browser (e.g. the pre-paint theme script).
    files: ['apps/web/public/**/*.js'],
    languageOptions: { sourceType: 'script', globals: globals.browser },
  },
  {
    // Tools that load their config through a default export.
    files: ['**/*.config.{js,mjs,ts,mts}'],
    rules: { 'no-restricted-syntax': 'off' },
  },
  {
    files: ['apps/web/src/**/*.{ts,tsx}'],
    extends: [
      eslintReact.configs['recommended-type-checked'],
      reactHooks.configs.flat['recommended-latest'],
      reactRefresh.configs.vite(),
      jsxA11y.configs.recommended,
    ],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    rules: { 'no-restricted-imports': restrictImports(WEB_IMPORT_BANS) },
  },
  {
    files: ['apps/web/src/**/*.{ts,tsx}'],
    ignores: ['**/*.test.{ts,tsx}', 'apps/web/src/shared/lib/testing/**'],
    rules: { 'no-restricted-imports': restrictImports(WEB_IMPORT_BANS, WEB_TEST_DOUBLE_BANS) },
  },
  {
    // Node 24 runs the server's TypeScript directly (type stripping); it never touches React or the web app.
    files: ['apps/mock-server/**/*.ts'],
    languageOptions: { globals: globals.node },
    rules: { 'no-restricted-imports': restrictImports(SERVER_IMPORT_BANS) },
  },
  {
    // Deterministic core of the server: a seed and a fake clock must reproduce a stream exactly.
    files: [
      'apps/mock-server/src/generator/**/*.ts',
      'apps/mock-server/src/{scheduler,budget,hub,rate-limit,client-ip}.ts',
    ],
    rules: {
      'no-restricted-imports': restrictImports(SERVER_IMPORT_BANS, PURE_SERVER_IMPORT_BANS),
      'no-restricted-globals': [
        'error',
        ...['Date', 'performance', 'process', 'Buffer', 'setTimeout', 'setInterval'].map(
          (name) => ({ name, message: PURE_SERVER_MESSAGE }),
        ),
      ],
      'no-restricted-properties': [
        'error',
        { object: 'Math', property: 'random', message: PURE_SERVER_MESSAGE },
      ],
    },
  },
  {
    // protocol and core: plain TypeScript without React, DOM, Node or the apps.
    files: ['packages/*/**/*.ts'],
    rules: {
      'no-restricted-imports': restrictImports(
        [{ regex: REACT_OR_WS_RE, message: PACKAGES_MESSAGE }],
        [{ regex: NODE_BUILTINS_RE, message: PACKAGES_MESSAGE }],
        APPS_FROM_PACKAGES_BANS,
      ),
      'no-restricted-globals': ['error', ...PACKAGE_GLOBAL_BANS],
    },
  },
  {
    // The stream engine runs on its caller's clock, so tests drive it with plain numbers.
    files: ['packages/core/src/**/*.ts'],
    ignores: ['**/*.test.ts', '**/*.bench.ts'],
    rules: {
      'no-restricted-globals': ['error', ...PACKAGE_GLOBAL_BANS, ...CORE_CLOCK_BANS],
    },
  },
  {
    // Tests may read fixtures from disk with node:* modules; the runtime code stays Node-free.
    files: ['packages/*/**/*.test.ts'],
    rules: {
      'no-restricted-imports': restrictImports(
        [{ regex: REACT_OR_WS_RE, message: PACKAGES_MESSAGE }],
        APPS_FROM_PACKAGES_BANS,
      ),
    },
  },
  {
    files: ['**/*.test.{ts,tsx}'],
    extends: [vitest.configs.recommended],
    rules: {
      // Type tests assert with `expectTypeOf`, which `tsc` checks.
      'vitest/expect-expect': [
        'error',
        { assertFunctionNames: ['expect', 'assert', 'expectTypeOf'] },
      ],
    },
  },
  {
    // Tests of the repository tooling run on node:test (`pnpm test:hooks`), not Vitest.
    files: ['scripts/**/*.test.ts'],
    rules: {
      'vitest/no-import-node-test': 'off',
      // node:test's describe/it return promises that the runner itself awaits.
      '@typescript-eslint/no-floating-promises': [
        'error',
        {
          allowForKnownSafeCalls: [
            { from: 'package', package: 'node:test', name: ['describe', 'it', 'suite', 'test'] },
          ],
        },
      ],
    },
  },
  {
    files: ['apps/web/e2e/**/*.ts'],
    extends: [playwright.configs['flat/recommended']],
  },
  prettier,
);
