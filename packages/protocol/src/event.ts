/** Log levels from the least to the most severe; an index in this list is the level's severity. */
export const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;

/** Severity of a log event. */
export type LogLevel = (typeof LOG_LEVELS)[number];

const KNOWN_LEVELS: readonly unknown[] = LOG_LEVELS;

/** Tells whether a value is one of {@link LOG_LEVELS}. */
export function isLogLevel(value: unknown): value is LogLevel {
  return KNOWN_LEVELS.includes(value);
}

/** Any value that survives a JSON round trip. */
export type JsonValue =
  null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

/** One log line produced by a service, as it travels inside a `batch` message. */
export interface LogEvent {
  /**
   * Position in the stream (`hello.streamId`): starts at 1 and grows by one per generated event.
   * A gap means lost events — `seq` is the single source of truth for gaps.
   */
  readonly seq: number;
  /** Server clock, epoch milliseconds. */
  readonly ts: number;
  readonly level: LogLevel;
  /** Emitting service, e.g. `payments`. */
  readonly service: string;
  /** Emitting instance, e.g. `payments-7f9c-2`. */
  readonly host: string;
  readonly message: string;
  /** Correlates events of one request across services. */
  readonly traceId?: string;
  /** Structured details (HTTP request, latency, user id, error stack…). Not validated deeply. */
  readonly payload?: Readonly<Record<string, JsonValue>>;
}
