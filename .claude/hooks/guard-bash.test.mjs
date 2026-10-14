import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

import { checkCommand, checkForegroundServer, stripQuoted } from './guard-bash.mjs';

const repo = path.resolve('/repo');
const worktree = path.resolve('/repo/.claude/worktrees/agent-1');
const onFeature = { branch: 'feat/table', hasOrigin: true };
const onMain = { branch: 'main', hasOrigin: true };

/** Session in the main checkout on `main`; the worktree is on a feature branch. */
const inMain = {
  cwd: repo,
  contextOf: (/** @type {string} */ dir) => (dir === worktree ? onFeature : onMain),
};
const inFeature = { cwd: repo, contextOf: () => onFeature };
const bootstrap = { cwd: repo, contextOf: () => ({ branch: 'main', hasOrigin: false }) };

describe('checkCommand', () => {
  it('ignores commands without git or gh', () => {
    assert.equal(checkCommand('pnpm test', inMain), null);
  });

  it('allows a plain conventional commit on a feature branch', () => {
    assert.equal(
      checkCommand('git add -A && git commit -m "feat(protocol): add log event type"', inFeature),
      null,
    );
  });

  it('blocks Claude co-author trailers in commit messages', () => {
    const command = `git commit -m "$(cat <<'EOF'\nfeat: x\n\nCo-Authored-By: Claude Opus <noreply@anthropic.com>\nEOF\n)"`;
    assert.match(checkCommand(command, inFeature) ?? '', /AI attribution/);
  });

  it('blocks "Generated with Claude Code" in PR bodies', () => {
    const command =
      'gh pr create --title "feat: x" --body "🤖 Generated with [Claude Code](https://claude.com/claude-code)"';
    assert.match(checkCommand(command, inFeature) ?? '', /AI attribution/);
  });

  it('blocks --no-verify and -n on commit', () => {
    assert.match(
      checkCommand('git commit --no-verify -m "fix: x"', inFeature) ?? '',
      /--no-verify/,
    );
    assert.match(checkCommand('git commit -nm "fix: x"', inFeature) ?? '', /--no-verify/);
  });

  it('does not treat flags inside the message as real flags', () => {
    assert.equal(
      checkCommand('git commit -m "docs: explain the -n flag and --no-verify"', inFeature),
      null,
    );
  });

  it('blocks commits on main once the repo has a remote', () => {
    assert.match(checkCommand('git commit -m "fix: x"', inMain) ?? '', /main/);
  });

  it('allows commits on main during local bootstrap (no origin yet)', () => {
    assert.equal(checkCommand('git commit -m "chore: bootstrap"', bootstrap), null);
  });

  it('allows committing on main when the same command creates a branch first', () => {
    assert.equal(checkCommand('git switch -c feat/x && git commit -m "feat: x"', inMain), null);
  });

  it('judges git -C commits by the target directory', () => {
    assert.equal(checkCommand(`git -C "${worktree}" commit -m "feat: x"`, inMain), null);
    assert.equal(
      checkCommand('git -C .claude/worktrees/agent-1 commit -m "feat: x"', inMain),
      null,
    );
  });

  it('judges commits after cd / Set-Location by the new directory', () => {
    assert.equal(
      checkCommand('cd .claude/worktrees/agent-1 && git commit -m "feat: x"', inMain),
      null,
    );
    assert.equal(
      checkCommand(`Set-Location -Path '${worktree}'; git commit -m "feat: x"`, inMain),
      null,
    );
    assert.match(checkCommand('cd apps/web && git commit -m "feat: x"', inMain) ?? '', /main/);
  });

  it('blocks plain force push but allows --force-with-lease on feature branches', () => {
    assert.match(checkCommand('git push --force', inFeature) ?? '', /force push/);
    assert.match(checkCommand('git push -f origin feat/table', inFeature) ?? '', /force push/);
    assert.match(checkCommand('git push origin +feat/table', inFeature) ?? '', /force push/);
    assert.equal(checkCommand('git push --force-with-lease', inFeature), null);
    assert.equal(checkCommand('git push -u origin feat/table', inFeature), null);
  });

  it('blocks force-with-lease to main', () => {
    assert.match(checkCommand('git push --force-with-lease origin main', inFeature) ?? '', /main/);
    assert.match(checkCommand('git push --force-with-lease', inMain) ?? '', /main/);
  });

  it('requires a conventional --title for gh pr create', () => {
    assert.match(checkCommand('gh pr create --fill', inFeature) ?? '', /--title/);
    assert.match(
      checkCommand('gh pr create --title "Add table" --body x', inFeature) ?? '',
      /Conventional/,
    );
    assert.equal(
      checkCommand('gh pr create --title "feat(table): virtualize rows" --body-file -', inFeature),
      null,
    );
  });
});

describe('checkForegroundServer', () => {
  it('blocks dev servers and watchers in the foreground', () => {
    for (const command of [
      'pnpm dev',
      'pnpm -s dev',
      'pnpm --parallel --filter @lsv/web --filter @lsv/mock-server dev',
      'pnpm --filter @lsv/mock-server start',
      'pnpm run preview',
      'pnpm serve:demo',
      'npm run dev',
      'pnpm exec vite',
      'pnpm --filter @lsv/web exec vite preview',
      'npx vite --port 5173',
      'node --watch src/main.ts',
      'node apps/mock-server/src/main.ts',
      'fly logs -a log-stream-viewer-mock',
      'pnpm exec playwright test --ui',
      'pnpm exec playwright show-report',
      'pnpm exec wrangler tail',
      'docker run -p 8080:8080 lsv-mock',
      'docker compose up',
      'cd apps/web; pnpm dev',
    ]) {
      assert.match(checkForegroundServer(command, false) ?? '', /run_in_background/, command);
    }
  });

  it('allows the same commands in the background', () => {
    assert.equal(checkForegroundServer('pnpm dev', true), null);
  });

  it('allows commands that finish on their own', () => {
    for (const command of [
      'pnpm build',
      'pnpm verify',
      'pnpm test:e2e',
      'pnpm exec vite build',
      'pnpm --filter @lsv/web exec vite build',
      'node scripts/free-ports.mjs',
      'node --test ".claude/hooks/*.test.mjs"',
      'fly logs --no-tail -a log-stream-viewer-mock',
      'docker run -d -p 8080:8080 lsv-mock',
      'docker build -f apps/mock-server/Dockerfile .',
      'git commit -m "docs: run pnpm dev to start"',
    ]) {
      assert.equal(checkForegroundServer(command, false), null, command);
    }
  });
});

describe('stripQuoted', () => {
  it('removes quoted strings and heredoc bodies', () => {
    const stripped = stripQuoted(`git commit -F - <<'EOF'\nfix: -n inside\nEOF\n && echo "a -f b"`);
    assert.doesNotMatch(stripped, /-n inside|a -f b/);
  });

  it('removes PowerShell here-strings', () => {
    const stripped = stripQuoted("git commit -m @'\nfix: x\n-n here\n'@");
    assert.doesNotMatch(stripped, /-n here/);
  });
});
