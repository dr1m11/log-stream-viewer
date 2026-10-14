// PreToolUse (Bash|PowerShell): keeps git/gh usage within the repo's workflow rules and keeps
// long-running dev servers out of foreground tool calls (they would block until the timeout).
import path from 'node:path';

import { AI_ATTRIBUTION_RE, fail, git, isMain, PROJECT_DIR, readInput } from './_lib.mjs';

const CONVENTIONAL_TITLE_RE =
  /^(build|chore|ci|docs|feat|fix|perf|refactor|revert|style|test)(\([a-z0-9-]+\))?!?: \S.*$/;
const PLACEHOLDER_RE = /\u0000(\d+)\u0000/g;
const CHANGE_DIR_RE = /^(cd|chdir|pushd|set-location|sl|push-location)$/i;

/** Package scripts that start a server and never exit on their own. */
const SERVER_SCRIPTS = new Set(['dev', 'dev:web', 'dev:server', 'preview', 'start', 'serve:demo']);
/** Package-manager options that take a separate value (`--filter @lsv/web`). */
const PM_OPTIONS_WITH_VALUE = new Set(['--filter', '-F', '-C', '--dir', '--prefix', '--workspace']);

/**
 * Replace quoted strings with placeholders so separators and flags inside messages are ignored,
 * keeping the original values for path arguments. Heredoc bodies and PowerShell here-strings are dropped.
 * @param {string} command
 * @returns {{ masked: string, values: string[] }}
 */
export function maskQuoted(command) {
  /** @type {string[]} */
  const values = [];
  const masked = command
    .replace(/<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2\s*(?=\n|$)/g, '<<HEREDOC')
    .replace(/@(['"])\r?\n[\s\S]*?\r?\n\1@/g, '""')
    .replace(/"(?:\\.|[^"\\])*"|'[^']*'/g, (match) => {
      values.push(match.slice(1, -1));
      return `\u0000${values.length - 1}\u0000`;
    });
  return { masked, values };
}

/**
 * The command with quoted strings, heredoc bodies and here-strings blanked out.
 * @param {string} command
 */
export function stripQuoted(command) {
  return maskQuoted(command).masked.replace(PLACEHOLDER_RE, '""');
}

/** @param {string} masked */
function segments(masked) {
  return masked
    .split(/&&|\|\||[;|\n]/)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

/**
 * @param {string} segment masked segment
 * @param {string[]} values quoted values from maskQuoted
 * @returns {{ raw: string[], restored: string[] }} tokens as masked and with quotes restored
 */
function tokenize(segment, values) {
  const raw = segment.split(/\s+/).filter(Boolean);
  const restored = raw.map((token) =>
    token.replace(PLACEHOLDER_RE, (_, index) => values[Number(index)] ?? ''),
  );
  return { raw, restored };
}

/** @param {string} token */
function binaryName(token) {
  return path
    .basename(token.replaceAll('\\', '/'))
    .replace(/\.(cmd|exe|ps1)$/i, '')
    .toLowerCase();
}

/** @param {string} command */
function extractTitle(command) {
  const match = /(?:--title|-t)(?:\s+|=)("(?:\\.|[^"\\])*"|'[^']*'|\S+)/.exec(command);
  return match?.[1]?.replace(/^(["'])([\s\S]*)\1$/, '$2') ?? null;
}

/**
 * @typedef {{ branch: string | null, hasOrigin: boolean }} RepoContext
 * @typedef {{ cwd: string, contextOf: (dir: string) => RepoContext }} CommandEnv
 */

/**
 * Checks git/gh usage. Each git segment is judged in the directory it actually runs in: the
 * session cwd, changed by a leading `cd`/`Set-Location`, or overridden by `git -C <dir>`.
 * @param {string} command
 * @param {CommandEnv} env
 * @returns {string | null} reason to block, or null to allow
 */
export function checkCommand(command, { cwd, contextOf }) {
  if (!/\b(git|gh)\b/.test(command)) return null;

  const writesHistory =
    /\bgit\b[\s\S]*\bcommit\b/.test(command) ||
    /\bgh\s+(pr|issue)\s+(create|edit|comment)\b/.test(command) ||
    /\bgh\s+api\b/.test(command);
  if (writesHistory && AI_ATTRIBUTION_RE.test(command)) {
    return 'AI attribution (Co-Authored-By: Claude / noreply@anthropic.com / "Generated with Claude") is not allowed in commits, PRs or issues. Remove it and retry.';
  }

  const { masked, values } = maskQuoted(command);
  let dir = path.resolve(cwd);
  /** @type {Set<string>} */
  const createdBranchIn = new Set();

  for (const segment of segments(masked)) {
    const { raw, restored } = tokenize(segment, values);
    const head = raw[0] ?? '';

    if (CHANGE_DIR_RE.test(head)) {
      const index = raw.findIndex((token, i) => i > 0 && !token.startsWith('-'));
      const target = restored[index];
      if (index > 0 && target) dir = path.resolve(dir, target);
      continue;
    }

    if (binaryName(head) === 'git') {
      let gitDir = dir;
      let i = 1;
      while (i < raw.length && (raw[i] ?? '').startsWith('-')) {
        const option = raw[i];
        if (option === '-C') gitDir = path.resolve(dir, restored[i + 1] ?? '.');
        i += option === '-C' || option === '-c' ? 2 : 1;
      }
      const subcommand = raw[i];
      const args = raw.slice(i + 1);
      const argsText = args.join(' ');

      if (
        (subcommand === 'switch' && args.some((a) => ['-c', '-C', '--create'].includes(a))) ||
        (subcommand === 'checkout' && args.some((a) => a === '-b' || a === '-B'))
      ) {
        createdBranchIn.add(gitDir);
      }

      if (subcommand === 'commit') {
        if (args.some((a) => a === '--no-verify' || /^-[a-zA-Z]*n[a-zA-Z]*$/.test(a))) {
          return 'Skipping git hooks (--no-verify / -n) is not allowed. Fix the reported problem instead.';
        }
        const { branch, hasOrigin } = contextOf(gitDir);
        if (branch === 'main' && hasOrigin && !createdBranchIn.has(gitDir)) {
          return 'Do not commit directly to main. Create a branch first: git switch -c <type>/<kebab-summary>.';
        }
      }

      if (subcommand === 'push') {
        if (args.includes('--no-verify')) return 'Skipping git hooks (--no-verify) is not allowed.';
        if (
          args.some((a) => a === '--force' || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(a) || a.startsWith('+'))
        ) {
          return 'Plain force push is not allowed. On a feature branch use --force-with-lease.';
        }
        if (
          /--force-with-lease|--force-if-includes/.test(argsText) &&
          (/\bmain\b/.test(argsText) || contextOf(gitDir).branch === 'main')
        ) {
          return 'Force-pushing main is not allowed.';
        }
      }
      continue;
    }

    if (binaryName(head) === 'gh' && raw[1] === 'pr' && raw[2] === 'create') {
      const title = extractTitle(command);
      if (title === null) {
        return 'Pass an explicit --title in Conventional Commits format, e.g. --title "feat(table): virtualize log rows".';
      }
      if (!CONVENTIONAL_TITLE_RE.test(title)) {
        return `PR title "${title}" is not a Conventional Commit (type(scope): summary).`;
      }
    }
  }
  return null;
}

/**
 * Describes a binary invocation that keeps running until stopped, or null.
 * @param {string[]} tokens
 * @returns {string | null}
 */
function longRunningBinary(tokens) {
  const [head, ...args] = tokens;
  if (!head) return null;
  const bin = binaryName(head);
  const has = (/** @type {string} */ flag) => args.includes(flag);

  switch (bin) {
    case 'vite': {
      if (args.some((a) => a === 'build' || a === 'optimize')) return null;
      return `vite ${args.find((a) => ['dev', 'serve', 'preview'].includes(a)) ?? 'dev'}`;
    }
    case 'node':
      if (args.some((a) => a.startsWith('--watch'))) return 'node --watch';
      if (args.some((a) => /(^|[\\/])src[\\/]main\.ts$/.test(a))) return 'the mock server';
      return null;
    case 'tsx':
      return args[0] === 'watch' ? 'tsx watch' : null;
    case 'wrangler':
      return args[0] === 'dev' || args[0] === 'tail' ? `wrangler ${args[0]}` : null;
    case 'fly':
    case 'flyctl':
      return args[0] === 'logs' && !has('--no-tail') ? `${bin} logs (use --no-tail)` : null;
    case 'playwright':
      if (has('--ui')) return 'playwright --ui';
      return args[0] === 'show-report' ? 'playwright show-report' : null;
    case 'docker': {
      const detached = args.some((a) => a === '--detach' || /^-[a-zA-Z]*d[a-zA-Z]*$/.test(a));
      if (args[0] === 'run' && !detached) return 'docker run (add -d)';
      if (args[0] === 'compose' && args.includes('up') && !detached) return 'docker compose up (add -d)';
      return null;
    }
    default:
      return null;
  }
}

/**
 * @param {string} pm
 * @param {string[]} args
 * @returns {string | null}
 */
function longRunningScript(pm, args) {
  let i = 0;
  while (i < args.length && (args[i] ?? '').startsWith('-')) {
    i += PM_OPTIONS_WITH_VALUE.has(args[i] ?? '') ? 2 : 1;
  }
  let rest = args.slice(i);
  if (rest[0] === 'run' || rest[0] === 'run-script') rest = rest.slice(1);
  const [first, ...more] = rest;
  if (first === 'exec' || first === 'dlx') return longRunningBinary(more);
  return first && SERVER_SCRIPTS.has(first) ? `${pm} ${first}` : null;
}

/**
 * Long-running processes (dev servers, watchers, log tails) must run with run_in_background.
 * @param {string} command
 * @param {boolean} runInBackground
 * @returns {string | null} reason to block, or null to allow
 */
export function checkForegroundServer(command, runInBackground) {
  if (runInBackground) return null;
  const { masked, values } = maskQuoted(command);
  for (const segment of segments(masked)) {
    const tokens = tokenize(segment, values).restored.filter((token) => !/^\w+=/.test(token));
    const [head, ...args] = tokens;
    if (!head) continue;
    const bin = binaryName(head);
    const found = ['pnpm', 'npm', 'yarn'].includes(bin)
      ? longRunningScript(bin, args)
      : bin === 'npx' || bin === 'pnpx'
        ? longRunningBinary(args)
        : longRunningBinary(tokens);
    if (found) {
      return `"${found}" keeps running until it is stopped. Start it with run_in_background: true (or use /dev-stack) and poll it (curl, Monitor) instead of blocking the foreground.`;
    }
  }
  return null;
}

if (isMain(import.meta.url)) {
  const input = await readInput();
  const command = input.tool_input?.command ?? '';

  const server = checkForegroundServer(command, input.tool_input?.run_in_background === true);
  if (server) fail(`Blocked by .claude/hooks/guard-bash.mjs: ${server}`);

  if (/\b(git|gh)\b/.test(command)) {
    /** @type {Map<string, RepoContext>} */
    const cache = new Map();
    const reason = checkCommand(command, {
      cwd: input.cwd ?? PROJECT_DIR,
      contextOf: (dir) => {
        const cached = cache.get(dir);
        if (cached) return cached;
        const context = {
          branch: git(['rev-parse', '--abbrev-ref', 'HEAD'], dir),
          hasOrigin: git(['remote', 'get-url', 'origin'], dir) !== null,
        };
        cache.set(dir, context);
        return context;
      },
    });
    if (reason) fail(`Blocked by .claude/hooks/guard-bash.mjs: ${reason}`);
  }
}
