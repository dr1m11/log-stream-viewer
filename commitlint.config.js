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

/**
 * The message without git's comment lines and the `git commit -v` diff below the scissors line,
 * so quoted text there cannot trigger the attribution check.
 * @param {string} message
 */
const stripGitComments = (message) =>
  (message.split(/^# -+ >8 -+$/m)[0] ?? '').replace(/^#.*$/gm, '');

/** Messages git writes itself (merges, reverts, fixups). commitlint skips them by default. */
const GIT_GENERATED_RE =
  /^(Merge |Merged |Revert "|Reapply "|Automatic merge|Auto-merged |(amend|fixup|squash)!)/;

const config = {
  extends: ['@commitlint/config-conventional'],
  // The default ignores skip every rule, including no-ai-attribution, for git-generated messages.
  // Skip those only while they carry no AI attribution.
  defaultIgnores: false,
  ignores: [
    /** @param {string} message */
    (message) =>
      GIT_GENERATED_RE.test(message) && !AI_ATTRIBUTION_RE.test(stripGitComments(message)),
  ],
  plugins: [
    {
      rules: {
        /** @param {{ raw?: string | null }} commit */
        'no-ai-attribution': ({ raw }) => [
          !AI_ATTRIBUTION_RE.test(stripGitComments(raw ?? '')),
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
