import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { AI_ATTRIBUTION_RE, git, nearestExistingDir, PROJECT_DIR, resolveRoot } from './_lib.mjs';
import { formatEslintErrors } from './format-lint.mjs';
import { currentStage, formatDevServers, summarizeStatus } from './session-context.mjs';
import { changedTsFiles } from './stop-typecheck.mjs';

describe('AI_ATTRIBUTION_RE', () => {
  it('matches attribution lines in any casing', () => {
    assert.match('Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>', AI_ATTRIBUTION_RE);
    assert.match('co-authored-by: claude', AI_ATTRIBUTION_RE);
    assert.match(
      '🤖 Generated with [Claude Code](https://claude.com/claude-code)',
      AI_ATTRIBUTION_RE,
    );
  });

  it('does not match human co-authors or unrelated text', () => {
    assert.doesNotMatch('Co-authored-by: Jane Doe <jane@example.com>', AI_ATTRIBUTION_RE);
    assert.doesNotMatch('docs(claude): update project rules', AI_ATTRIBUTION_RE);
  });
});

describe('resolveRoot', () => {
  const top = path.resolve(git(['rev-parse', '--show-toplevel']) ?? PROJECT_DIR);

  it('finds the repository top level from a nested or not-yet-existing directory', () => {
    assert.equal(resolveRoot(path.join(top, '.claude', 'hooks')), top);
    assert.equal(resolveRoot(path.join(top, 'apps', 'not-created-yet', 'src')), top);
  });

  it('skips missing candidates and falls back to the project dir outside any repository', () => {
    const outside = mkdtempSync(path.join(os.tmpdir(), 'lsv-hooks-'));
    try {
      assert.equal(resolveRoot(undefined, outside), PROJECT_DIR);
      assert.equal(resolveRoot(outside, top), top);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('walks up to the closest existing directory', () => {
    assert.equal(nearestExistingDir(path.join(top, 'missing', 'deeper')), top);
  });
});

describe('currentStage', () => {
  it('reads the roadmap marker', () => {
    assert.equal(currentStage('# Roadmap\n\n<!-- current-stage: B2 -->\n'), 'B2');
    assert.equal(currentStage('# Roadmap'), null);
  });
});

describe('summarizeStatus', () => {
  it('counts staged, modified and untracked entries', () => {
    assert.equal(
      summarizeStatus('M  a.ts\n M b.ts\nMM c.ts\n?? d.ts\n'),
      '2 staged, 2 modified, 1 untracked',
    );
    assert.equal(summarizeStatus(''), 'clean');
  });
});

describe('formatDevServers', () => {
  it('lists each server with its port and state', () => {
    assert.equal(
      formatDevServers([
        ['web', 5173, true],
        ['mock', 8787, false],
      ]),
      'web :5173 up, mock :8787 down',
    );
  });
});

describe('changedTsFiles', () => {
  it('keeps TypeScript paths, including rename targets', () => {
    const porcelain =
      ' M apps/web/src/main.tsx\n?? README.md\nR  old.ts -> packages/protocol/src/new.ts\n?? "with space.ts"\n';
    assert.deepEqual(changedTsFiles(porcelain), [
      'apps/web/src/main.tsx',
      'packages/protocol/src/new.ts',
      'with space.ts',
    ]);
  });
});

describe('formatEslintErrors', () => {
  it('reports errors only, relative to the root', () => {
    const lines = formatEslintErrors(
      [
        {
          filePath: `${process.cwd()}/src/a.ts`,
          messages: [
            {
              severity: 2,
              line: 3,
              column: 5,
              message: 'Unexpected any.',
              ruleId: '@typescript-eslint/no-explicit-any',
            },
            { severity: 1, line: 4, column: 1, message: 'warning', ruleId: 'x' },
          ],
        },
      ],
      process.cwd(),
    );
    assert.deepEqual(lines, ['src/a.ts:3:5 Unexpected any. (@typescript-eslint/no-explicit-any)']);
  });
});
