// @ts-check
import { AI_ATTRIBUTION_RE } from './.claude/hooks/_lib.mjs';

/** Allowed Conventional Commit scopes. Extend when a new area appears. */
const SCOPES = [
  'web',
  'server',
  'protocol',
  'core',
  'ui',
  'stream',
  'table',
  'search',
  'chart',
  'worker',
  'e2e',
  'ci',
  'deploy',
  'deps',
  'docs',
  'claude',
  'repo',
  'tooling',
];

const config = {
  extends: ['@commitlint/config-conventional'],
  plugins: [
    {
      rules: {
        /** @param {{ raw?: string | null }} commit */
        'no-ai-attribution': ({ raw }) => [
          !AI_ATTRIBUTION_RE.test(raw ?? ''),
          'AI attribution (Co-Authored-By: Claude, "Generated with Claude Code") is not allowed',
        ],
      },
    },
  ],
  rules: {
    'no-ai-attribution': [2, 'always'],
    'scope-enum': [2, 'always', SCOPES],
    'header-max-length': [2, 'always', 100],
  },
};

export default config;
