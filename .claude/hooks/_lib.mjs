// Shared helpers for Claude Code hooks. Plain Node ESM, no dependencies, works on Windows and POSIX.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Main checkout. Fallback only: in a git worktree the hook input's `cwd` points elsewhere. */
export const PROJECT_DIR = path.resolve(
  process.env.CLAUDE_PROJECT_DIR ??
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..'),
);

/** Matches AI attribution trailers we never allow in commits, PRs or issues. */
export const AI_ATTRIBUTION_RE =
  /co-authored-by:[^\n]*(claude|anthropic)|noreply@anthropic\.com|generated with \[?claude/i;

/**
 * True when the module is executed directly (`node file.mjs`), false when imported by tests.
 * @param {string} importMetaUrl
 */
export function isMain(importMetaUrl) {
  const entry = process.argv[1];
  return entry !== undefined && importMetaUrl === pathToFileURL(path.resolve(entry)).href;
}

/**
 * Hook payload from stdin. Only the fields our hooks use are typed.
 * @typedef {{
 *   cwd?: string,
 *   source?: string,
 *   stop_hook_active?: boolean,
 *   tool_name?: string,
 *   tool_input?: { command?: string, file_path?: string, run_in_background?: boolean },
 * }} HookInput
 */

/** @returns {Promise<HookInput>} */
export async function readInput() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  return raw ? JSON.parse(raw) : {};
}

/**
 * @param {string[]} args
 * @param {string} [cwd]
 * @returns {string | null} trimmed stdout, or null when git fails
 */
export function git(args, cwd = PROJECT_DIR) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 5000 });
  return result.status === 0 ? result.stdout.trim() : null;
}

/**
 * Closest existing directory for a path that may not exist yet (e.g. a file about to be written).
 * @param {string} target
 */
export function nearestExistingDir(target) {
  let dir = path.resolve(target);
  while (!existsSync(dir)) {
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return dir;
}

/**
 * Repository root for this hook call: the git top level of the first candidate directory that is
 * inside a repository. Pass the touched file's directory and/or the hook input's `cwd` — both follow
 * Claude into git worktrees, while CLAUDE_PROJECT_DIR always points at the main checkout.
 * @param {...(string | undefined)} candidates
 */
export function resolveRoot(...candidates) {
  for (const candidate of candidates) {
    if (!candidate) continue;
    const top = git(['rev-parse', '--show-toplevel'], nearestExistingDir(candidate));
    if (top) return path.resolve(top);
  }
  return PROJECT_DIR;
}

/**
 * Root-relative POSIX path, or null when the file is outside the root.
 * @param {string | undefined} file
 * @param {string} [root]
 * @returns {string | null}
 */
export function projectRelative(file, root = PROJECT_DIR) {
  if (!file) return null;
  const rel = path.relative(root, path.resolve(root, file));
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

/**
 * Resolve a package's JS bin inside the root's node_modules (avoids spawning .cmd shims on Windows).
 * @param {string} pkg
 * @param {string} [binName]
 * @param {string} [root]
 * @returns {string | null}
 */
export function resolveBin(pkg, binName = pkg, root = PROJECT_DIR) {
  const pkgJsonPath = path.join(root, 'node_modules', pkg, 'package.json');
  if (!existsSync(pkgJsonPath)) return null;
  /** @type {{ bin?: string | Record<string, string> }} */
  const { bin } = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
  const rel = typeof bin === 'string' ? bin : bin?.[binName];
  return rel ? path.join(path.dirname(pkgJsonPath), rel) : null;
}

/**
 * @param {string} script
 * @param {string[]} args
 * @param {Omit<import('node:child_process').SpawnSyncOptions, 'encoding'>} [options]
 */
export function runNode(script, args, options = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: PROJECT_DIR,
    maxBuffer: 16 * 1024 * 1024,
    ...options,
    encoding: 'utf8',
  });
}

/**
 * Exit with code 2 so Claude Code shows the reason to Claude (blocks PreToolUse/Stop).
 * @param {string} message
 * @returns {never}
 */
export function fail(message) {
  process.stderr.write(`${message.trim()}\n`);
  process.exit(2);
}

/**
 * @param {string} text
 * @param {number} count
 */
export function firstLines(text, count) {
  const lines = text.trim().split(/\r?\n/);
  const head = lines.slice(0, count).join('\n');
  return lines.length > count ? `${head}\n… ${lines.length - count} more line(s)` : head;
}
