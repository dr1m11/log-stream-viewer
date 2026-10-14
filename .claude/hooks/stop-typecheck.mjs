// Stop: when TypeScript files changed since the last green run, runs `pnpm typecheck` and
// keeps Claude working (exit 2) until the errors are fixed. Runs in the checkout of the session
// cwd, so a session inside a git worktree checks the worktree.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { fail, firstLines, git, isMain, readInput, resolveRoot } from './_lib.mjs';

const TS_FILE_RE = /\.(ts|tsx|mts|cts)$/;

/**
 * Paths of changed or untracked TypeScript files from `git status --porcelain` output.
 * @param {string} porcelain
 */
export function changedTsFiles(porcelain) {
  return porcelain
    .split(/\r?\n/)
    .filter((line) => line.length > 3)
    .map((line) => {
      const entry = line.slice(3);
      const arrow = entry.indexOf(' -> ');
      return (arrow === -1 ? entry : entry.slice(arrow + 4)).replace(/^"(.*)"$/, '$1');
    })
    .filter((file) => TS_FILE_RE.test(file));
}

/**
 * @param {string} root
 * @param {string[]} files
 */
function signatureOf(root, files) {
  const hash = createHash('sha256');
  for (const file of [...files].sort()) {
    const absolute = path.join(root, file);
    const stat = existsSync(absolute) ? statSync(absolute) : null;
    hash.update(`${file}:${stat?.mtimeMs ?? 'deleted'}:${stat?.size ?? 0}\n`);
  }
  return hash.digest('hex');
}

/** @param {string} cacheFile */
function readCachedSignature(cacheFile) {
  try {
    return JSON.parse(readFileSync(cacheFile, 'utf8')).signature;
  } catch {
    return null;
  }
}

if (isMain(import.meta.url)) {
  const input = await readInput();
  if (input.stop_hook_active) process.exit(0);

  const root = resolveRoot(input.cwd);
  if (!existsSync(path.join(root, 'node_modules', 'typescript'))) process.exit(0);

  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (!pkg.scripts?.typecheck) process.exit(0);

  const status = git(['status', '--porcelain', '--untracked-files=all'], root);
  const files = status === null ? [] : changedTsFiles(status);
  if (files.length === 0) process.exit(0);

  const cacheFile = path.join(root, 'node_modules', '.cache', 'claude-hooks', 'typecheck.json');
  const signature = signatureOf(root, files);
  if (readCachedSignature(cacheFile) === signature) process.exit(0);

  const result = spawnSync('pnpm', ['-s', 'typecheck'], {
    cwd: root,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    timeout: 170_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  // A timeout or spawn error should not trap Claude in a loop; only real type errors block.
  if (result.error || result.status === null) process.exit(0);

  if (result.status === 0) {
    mkdirSync(path.dirname(cacheFile), { recursive: true });
    writeFileSync(cacheFile, JSON.stringify({ signature, checkedAt: new Date().toISOString() }));
    process.exit(0);
  }
  fail(
    `pnpm typecheck failed. Fix these errors before finishing:\n${firstLines(`${result.stdout}\n${result.stderr}`, 40)}`,
  );
}
