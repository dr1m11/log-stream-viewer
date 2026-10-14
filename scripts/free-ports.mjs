// Frees the local dev ports of this repo (web 5173, preview 4173, mock server 8787, or the ports
// given as arguments) by stopping the processes listening on them. Only processes that belong to
// this repository are stopped: their command line contains the repo path, or they run the mock
// server entry (`src/main.ts`). Servers of other projects on the same ports are reported and left.
// On Windows, background dev servers often survive their parent shell; this cleans them up.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_PORTS = [5173, 4173, 8787];

/** @typedef {{ port: number, pid: number, cmd: string }} Listener */

/** @param {string} value */
function normalize(value) {
  return value.replaceAll('\\', '/').toLowerCase();
}

/**
 * Whether a process command line belongs to this repository.
 * @param {string} cmd
 * @param {string} [root]
 */
export function isOwnProcess(cmd, root = ROOT) {
  const line = normalize(cmd);
  return line.includes(normalize(root)) || /(^|[\s"'/])src\/main\.ts\b/.test(line);
}

/**
 * Parses the PowerShell `ConvertTo-Json` output (a single object or an array) into listeners.
 * @param {string} json
 * @returns {Listener[]}
 */
export function parseWindowsListeners(json) {
  const text = json.trim();
  if (!text) return [];
  /** @type {unknown} */
  const parsed = JSON.parse(text);
  const items = Array.isArray(parsed) ? parsed : [parsed];
  return items.flatMap((item) => {
    if (typeof item !== 'object' || item === null) return [];
    const { port, pid, cmd } = /** @type {{ port?: unknown, pid?: unknown, cmd?: unknown }} */ (
      item
    );
    return typeof port === 'number' && typeof pid === 'number' && pid > 0
      ? [{ port, pid, cmd: typeof cmd === 'string' ? cmd : '' }]
      : [];
  });
}

/**
 * @param {number[]} ports
 * @returns {Listener[]}
 */
function listListeners(ports) {
  if (process.platform === 'win32') {
    const script = [
      `Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue`,
      `| Where-Object { @(${ports.join(',')}) -contains $_.LocalPort }`,
      `| Sort-Object -Property LocalPort, OwningProcess -Unique`,
      `| ForEach-Object { $p = Get-CimInstance Win32_Process -Filter "ProcessId=$($_.OwningProcess)";`,
      `[pscustomobject]@{ port = [int]$_.LocalPort; pid = [int]$_.OwningProcess; cmd = [string]$p.CommandLine } }`,
      `| ConvertTo-Json -Compress`,
    ].join(' ');
    const result = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { encoding: 'utf8' },
    );
    return parseWindowsListeners(result.stdout ?? '');
  }
  return ports.flatMap((port) => {
    const lsof = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], {
      encoding: 'utf8',
    });
    return (lsof.stdout ?? '')
      .split(/\s+/)
      .filter(Boolean)
      .map((pid) => {
        const ps = spawnSync('ps', ['-o', 'command=', '-p', pid], { encoding: 'utf8' });
        return { port, pid: Number(pid), cmd: (ps.stdout ?? '').trim() };
      });
  });
}

/** @param {number} pid */
function stop(pid) {
  if (process.platform === 'win32') {
    return (
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { encoding: 'utf8' }).status === 0
    );
  }
  try {
    process.kill(pid, 'SIGTERM');
    return true;
  } catch {
    return false;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const requested = process.argv.slice(2).map(Number).filter(Number.isInteger);
  const ports = requested.length > 0 ? requested : DEFAULT_PORTS;
  const listeners = listListeners(ports);
  if (listeners.length === 0) console.log(`Ports ${ports.join(', ')} are free.`);
  for (const { port, pid, cmd } of listeners) {
    if (!isOwnProcess(cmd)) {
      console.log(
        `:${port} is used by another project (PID ${pid}: ${cmd || 'unknown'}); left running.`,
      );
      continue;
    }
    console.log(`:${port} PID ${pid} ${stop(pid) ? 'stopped' : 'could not be stopped'}.`);
  }
}
