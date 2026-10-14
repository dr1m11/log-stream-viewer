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

const REACT_IMPORTS = ['react', 'react/*', 'react-*'];

/**
 * Bans imports from the other app: the web client and the mock server share only @lsv/protocol.
 * @param {string} app directory name under apps/
 */
function otherAppImports(app) {
  const message = `Do not import from apps/${app}; share code through @lsv/protocol (see docs/adr/0001).`;
  return [
    { group: [`@lsv/${app}`, `@lsv/${app}/*`], message },
    // Relative paths that climb out of this app into the other one (`../../web/src/...`).
    { regex: `^(\\.\\./)+(apps/)?${app}(/|$)`, message },
  ];
}

const PROTOCOL_IMPORT_MESSAGE =
  'packages/protocol is the framework-free wire contract: no React, Node or ws (see docs/adr/0001).';

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
    rules: {
      'no-restricted-imports': ['error', { patterns: otherAppImports('mock-server') }],
    },
  },
  {
    // Node 24 runs the server's TypeScript directly (type stripping); it never touches React or the web app.
    files: ['apps/mock-server/**/*.ts'],
    languageOptions: { globals: globals.node },
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: REACT_IMPORTS,
              message: 'The mock server does not use React (see docs/adr/0001).',
            },
            ...otherAppImports('web'),
          ],
        },
      ],
    },
  },
  {
    files: ['packages/protocol/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [...REACT_IMPORTS, 'ws', 'node:*', ...builtinModules],
              message: PROTOCOL_IMPORT_MESSAGE,
            },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        ...['window', 'document', 'navigator', 'location', 'localStorage', 'sessionStorage'].map(
          (name) => ({
            name,
            message: 'packages/protocol must not depend on browser APIs.',
          }),
        ),
        ...['process', 'Buffer', 'require', '__dirname', '__filename'].map((name) => ({
          name,
          message: 'packages/protocol must not depend on Node APIs.',
        })),
      ],
    },
  },
  {
    // Contract tests may read golden fixtures from disk; the runtime code stays Node-free.
    files: ['packages/protocol/**/*.test.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [...REACT_IMPORTS, 'ws'],
              message: PROTOCOL_IMPORT_MESSAGE,
            },
          ],
        },
      ],
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
    files: ['apps/web/e2e/**/*.ts'],
    extends: [playwright.configs['flat/recommended']],
  },
  prettier,
);
