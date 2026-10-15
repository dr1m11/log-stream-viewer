import { DEFAULT_RATE, err, MIN_RATE, ok, type Result } from '@lsv/protocol';

/** Which browser origins may open a stream. */
export interface OriginPolicy {
  /** Origins allowed verbatim, e.g. `https://log-stream-viewer.example.dev`. */
  readonly exact: ReadonlySet<string>;
  /** Anchored patterns (`^…$`), e.g. for per-PR preview hosts. */
  readonly patterns: readonly RegExp[];
  /** Whether a request without an `Origin` header (CLI tools, tests) is accepted. */
  readonly allowMissing: boolean;
}

/** Validated server settings; every module receives this object, nobody reads `process.env`. */
export interface ServerConfig {
  readonly port: number;
  readonly host: string;
  readonly origins: OriginPolicy;
  /** Rate of a stream whose client did not ask for one. */
  readonly defaultRate: number;
  /** Ceiling of a single stream's rate (`hello.limits.maxRate`). */
  readonly maxRate: number;
  readonly maxConnections: number;
  readonly maxConnectionsPerIp: number;
  /** Ceiling of all streams together, events per second. */
  readonly globalMaxEventsPerSec: number;
  /** Session lifetime; the server closes the socket with 4000 afterwards. */
  readonly sessionMaxMs: number;
  /** Deployed commit, reported by `/healthz`. */
  readonly gitSha: string;
  readonly production: boolean;
  /**
   * Whether the per-IP cap trusts the proxy's `Fly-Client-IP` header (`TRUST_PROXY_IP_HEADER`,
   * default: on in production, behind Fly's proxy which sets it; off locally). Without a trusted
   * proxy any client could set the header and dodge the cap, so the socket address counts.
   */
  readonly trustProxyIpHeader: boolean;
}

/** Environment variables as `process.env` provides them. */
export type Env = Readonly<Record<string, string | undefined>>;

/** Origins of the local web app (`pnpm dev` on 5173, `pnpm preview` on 4173). */
export const DEV_ORIGINS = [
  'http://localhost:5173',
  'http://localhost:4173',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:4173',
] as const;

export const CONFIG_DEFAULTS = {
  port: 8787,
  /** Loopback locally; every interface in production (Fly's proxy connects from outside). */
  devHost: '127.0.0.1',
  productionHost: '0.0.0.0',
  maxRate: 20_000,
  maxConnections: 50,
  maxConnectionsPerIp: 3,
  globalMaxEventsPerSec: 20_000,
  sessionMaxMs: 30 * 60 * 1000,
  gitSha: 'dev',
} as const;

const DECIMAL_INTEGER = /^\d+$/;

/** Reads the variables and collects every problem instead of stopping at the first one. */
class EnvReader {
  readonly errors: string[] = [];
  readonly #env: Env;

  constructor(env: Env) {
    this.#env = env;
  }

  /** The trimmed value, or `undefined` when the variable is unset or blank. */
  string(name: string): string | undefined {
    const value = this.#env[name]?.trim();
    return value === undefined || value === '' ? undefined : value;
  }

  integer(name: string, fallback: number, min: number, max: number): number {
    const text = this.string(name);
    if (text === undefined) return fallback;
    const value = DECIMAL_INTEGER.test(text) ? Number(text) : Number.NaN;
    if (Number.isSafeInteger(value) && value >= min && value <= max) return value;
    this.errors.push(
      `${name} must be an integer from ${String(min)} to ${String(max)}, got ${JSON.stringify(text)}`,
    );
    return fallback;
  }

  boolean(name: string, fallback: boolean): boolean {
    const text = this.string(name)?.toLowerCase();
    if (text === undefined) return fallback;
    if (text === 'true' || text === '1') return true;
    if (text === 'false' || text === '0') return false;
    this.errors.push(`${name} must be true, false, 1 or 0, got ${JSON.stringify(text)}`);
    return fallback;
  }
}

/**
 * Parses `ALLOWED_ORIGINS`: comma-separated entries, each either an exact origin
 * (`https://app.example.dev`, scheme + host + optional port, no path or trailing slash) or an
 * anchored regular expression that starts with `^` and ends with `$`
 * (`^https://pr-\d+-app\.example\.dev$`). Regex entries cannot contain commas.
 */
export function parseAllowedOrigins(
  text: string,
): Result<Pick<OriginPolicy, 'exact' | 'patterns'>, string[]> {
  const exact = new Set<string>();
  const patterns: RegExp[] = [];
  const errors: string[] = [];
  for (const entry of text.split(',')) {
    const value = entry.trim();
    if (value === '') continue;
    if (value.startsWith('^')) {
      const pattern = compileAnchored(value);
      if (typeof pattern === 'string') errors.push(pattern);
      else patterns.push(pattern);
      continue;
    }
    if (!isOrigin(value)) {
      errors.push(
        `ALLOWED_ORIGINS: ${JSON.stringify(value)} is not an origin like https://app.example.dev (scheme://host[:port], no path)`,
      );
      continue;
    }
    exact.add(value);
  }
  if (errors.length === 0 && exact.size === 0 && patterns.length === 0) {
    errors.push('ALLOWED_ORIGINS must list at least one origin');
  }
  return errors.length === 0 ? ok({ exact, patterns }) : err(errors);
}

/**
 * Compiles an `ALLOWED_ORIGINS` regex entry `^body$` as `^(?:body)$`, so an alternation inside
 * (`^a|b$`) cannot escape the anchors. The body must be a complete pattern on its own (no
 * unbalanced groups that could close the wrapper) and the final `$` must not be escaped.
 * Returns the problem as a string when the entry is not usable.
 */
function compileAnchored(entry: string): RegExp | string {
  const quoted = JSON.stringify(entry);
  const trailingBackslashes = /\\*\$$/.exec(entry)?.[0].length ?? 0;
  if (!entry.endsWith('$') || trailingBackslashes % 2 === 0) {
    return `ALLOWED_ORIGINS: regex ${quoted} must end with an unescaped $ (entries starting with ^ are anchored regexes and cannot contain commas)`;
  }
  const body = entry.slice(1, -1);
  try {
    // Validates the body alone first: `a)|(.*` compiles inside the wrapper but not on its own.
    new RegExp(body, 'u');
    return new RegExp(`^(?:${body})$`, 'u');
  } catch (error) {
    return `ALLOWED_ORIGINS: invalid regex ${quoted}: ${String(error)}`;
  }
}

/** Whether `value` is exactly a serialized `http(s)` origin. */
function isOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.origin === value;
  } catch {
    return false;
  }
}

/** Whether a WebSocket handshake with this `Origin` header may proceed. */
export function isOriginAllowed(policy: OriginPolicy, origin: string | undefined): boolean {
  if (origin === undefined) return policy.allowMissing;
  return policy.exact.has(origin) || policy.patterns.some((pattern) => pattern.test(origin));
}

/**
 * Builds the server configuration from environment variables. Unset or blank variables take
 * defaults suited to local development; production (`NODE_ENV=production`) must name its
 * `ALLOWED_ORIGINS` and rejects requests without an `Origin`. Returns every problem at once.
 */
export function parseConfig(env: Env): Result<ServerConfig, string[]> {
  const read = new EnvReader(env);
  const production = read.string('NODE_ENV') === 'production';

  const port = read.integer('PORT', CONFIG_DEFAULTS.port, 0, 65_535);
  const host =
    read.string('HOST') ?? (production ? CONFIG_DEFAULTS.productionHost : CONFIG_DEFAULTS.devHost);

  const maxRate = read.integer('MAX_RATE', CONFIG_DEFAULTS.maxRate, MIN_RATE, 1_000_000);
  const defaultRate = read.integer(
    'DEFAULT_RATE',
    Math.min(DEFAULT_RATE, maxRate),
    MIN_RATE,
    maxRate,
  );
  const maxConnections = read.integer('MAX_CONNECTIONS', CONFIG_DEFAULTS.maxConnections, 1, 10_000);
  const maxConnectionsPerIp = read.integer(
    'MAX_CONNECTIONS_PER_IP',
    CONFIG_DEFAULTS.maxConnectionsPerIp,
    1,
    10_000,
  );
  const globalMaxEventsPerSec = read.integer(
    'GLOBAL_MAX_EVENTS_PER_SEC',
    CONFIG_DEFAULTS.globalMaxEventsPerSec,
    MIN_RATE,
    10_000_000,
  );
  const sessionMaxMs = read.integer(
    'SESSION_MAX_MS',
    CONFIG_DEFAULTS.sessionMaxMs,
    1000,
    24 * 60 * 60 * 1000,
  );
  const gitSha = read.string('GIT_SHA') ?? CONFIG_DEFAULTS.gitSha;
  const trustProxyIpHeader = read.boolean('TRUST_PROXY_IP_HEADER', production);

  const errors = read.errors;
  let allowed: Pick<OriginPolicy, 'exact' | 'patterns'> = {
    exact: new Set(DEV_ORIGINS),
    patterns: [],
  };
  const originsText = read.string('ALLOWED_ORIGINS');
  if (originsText !== undefined) {
    const parsed = parseAllowedOrigins(originsText);
    if (parsed.ok) allowed = parsed.value;
    else errors.push(...parsed.error);
  } else if (production) {
    errors.push('ALLOWED_ORIGINS is required when NODE_ENV=production');
  }

  if (errors.length > 0) return err(errors);
  return ok({
    port,
    host,
    origins: { ...allowed, allowMissing: !production },
    defaultRate,
    maxRate,
    maxConnections,
    maxConnectionsPerIp,
    globalMaxEventsPerSec,
    sessionMaxMs,
    gitSha,
    production,
    trustProxyIpHeader,
  });
}
