// SessionStart: prints a short repository briefing that Claude Code adds to the session context.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import { git, isMain, readInput, resolveRoot } from './_lib.mjs';

/** Local dev servers of this repo, probed so Claude knows what is already running. */
const DEV_SERVERS = /** @type {const} */ ([
  ['web', 5173],
  ['preview', 4173],
  ['mock', 8787],
]);

/**
 * Reads the `<!-- current-stage: B1 -->` marker from docs/roadmap.md.
 * @param {string} roadmap
 */
export function currentStage(roadmap) {
  return /<!--\s*current-stage:\s*([\w.-]+)\s*-->/.exec(roadmap)?.[1] ?? null;
}

/**
 * Summarizes `git status --porcelain` output as "2 staged, 1 modified, 3 untracked".
 * @param {string} porcelain
 */
export function summarizeStatus(porcelain) {
  const counts = { staged: 0, modified: 0, untracked: 0 };
  for (const line of porcelain.split(/\r?\n/).filter(Boolean)) {
    if (line.startsWith('??')) {
      counts.untracked += 1;
      continue;
    }
    if (line[0] !== ' ') counts.staged += 1;
    if (line[1] !== ' ') counts.modified += 1;
  }
  const parts = Object.entries(counts)
    .filter(([, count]) => count > 0)
    .map(([kind, count]) => `${count} ${kind}`);
  return parts.length > 0 ? parts.join(', ') : 'clean';
}

/**
 * Formats probe results as "web :5173 down, preview :4173 down, mock :8787 up".
 * @param {ReadonlyArray<readonly [string, number, boolean]>} results
 */
export function formatDevServers(results) {
  return results.map(([name, port, up]) => `${name} :${port} ${up ? 'up' : 'down'}`).join(', ');
}

/**
 * @param {number} port
 * @returns {Promise<boolean>} whether something accepts TCP connections on localhost:port
 */
function probePort(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: 'localhost', port, timeout: 200 });
    /** @param {boolean} up */
    const done = (up) => {
      socket.destroy();
      resolve(up);
    };
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

/** @param {string} root */
function openPullRequest(root) {
  const result = spawnSync(
    'gh',
    ['pr', 'view', '--json', 'number,state,url', '-q', '"#\\(.number) \\(.state) \\(.url)"'],
    { cwd: root, encoding: 'utf8', timeout: 3000 },
  );
  return result.status === 0 ? result.stdout.trim().replace(/^"|"$/g, '') : null;
}

if (isMain(import.meta.url)) {
  const input = await readInput();
  const root = resolveRoot(input.cwd);
  const lines = ['## Repository context (SessionStart hook)'];

  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], root);
  const hasOrigin = git(['remote', 'get-url', 'origin'], root) !== null;
  if (branch) {
    const counts = git(['rev-list', '--left-right', '--count', '@{upstream}...HEAD'], root);
    const [behind, ahead] = counts ? counts.split(/\s+/) : [];
    lines.push(
      `- Branch: ${branch}${counts ? ` (ahead ${ahead}, behind ${behind} of upstream)` : ' (no upstream)'}`,
    );
    if (branch === 'main' && hasOrigin) {
      lines.push(
        '- ⚠ On main: create a branch (`git switch -c <type>/<kebab-summary>`) before committing.',
      );
    }
  }

  const status = git(['status', '--porcelain'], root);
  if (status !== null) lines.push(`- Working tree: ${summarizeStatus(status)}`);

  const roadmapPath = path.join(root, 'docs', 'roadmap.md');
  const stage = existsSync(roadmapPath) ? currentStage(readFileSync(roadmapPath, 'utf8')) : null;
  if (stage) lines.push(`- Current stage: ${stage} (see docs/roadmap.md and the GitHub milestone)`);

  const probes = await Promise.all(
    DEV_SERVERS.map(
      async ([name, port]) => /** @type {const} */ ([name, port, await probePort(port)]),
    ),
  );
  lines.push(`- Dev servers: ${formatDevServers(probes)}`);

  if (hasOrigin && branch && branch !== 'main') {
    const pr = openPullRequest(root);
    if (pr) lines.push(`- Open PR for this branch: ${pr}`);
  }

  const log = git(['log', '--oneline', '-5'], root);
  if (log) lines.push('- Recent commits:', ...log.split(/\r?\n/).map((entry) => `  - ${entry}`));

  process.stdout.write(`${lines.join('\n')}\n`);
}
