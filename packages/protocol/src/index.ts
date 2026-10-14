/**
 * `@lsv/protocol` — the log event model and the WebSocket wire protocol v1, shared by the mock
 * server and the web app. Wire format and compatibility rules: `docs/protocol.md`.
 */

export { assertNever } from './assert-never.ts';
export {
  busyCloseReason,
  CLOSE_CODES,
  type CloseCode,
  isTerminalCloseCode,
  MAX_RETRY_AFTER_SECONDS,
  retryAfterSeconds,
} from './close-codes.ts';
export {
  buildConnectionQuery,
  buildConnectionUrl,
  type ConnectionParamIssue,
  type ConnectionParamName,
  type ConnectionParamProblem,
  type ConnectionParams,
  MAX_ISSUE_VALUE_LENGTH,
  parseConnectionQuery,
  type ParsedConnectionQuery,
  type ResumePoint,
  STREAM_PATH,
} from './connection.ts';
export { isLogLevel, type JsonValue, LOG_LEVELS, type LogEvent, type LogLevel } from './event.ts';
export {
  BATCH_INTERVAL_MS,
  DEFAULT_RATE,
  HEARTBEAT_INTERVAL_MS,
  MAX_CLIENT_MESSAGE_BYTES,
  MAX_SEED,
  MIN_RATE,
  PROTOCOL_VERSION,
} from './limits.ts';
export {
  type BatchMessage,
  CLIENT_MESSAGE_TYPES,
  type ClientMessage,
  type ConfigMessage,
  type ConfigureMessage,
  type ErrorMessage,
  type HeartbeatMessage,
  type HelloMessage,
  isKnownErrorCode,
  KNOWN_ERROR_CODES,
  type KnownErrorCode,
  SERVER_MESSAGE_TYPES,
  type ServerMessage,
  type StreamLimits,
  type StreamSettings,
} from './messages.ts';
export { parseClientMessage, parseServerMessage, type ProtocolError } from './parse.ts';
export { type Err, err, type Ok, ok, type Result } from './result.ts';
export { DEFAULT_SCENARIO, isScenario, type Scenario, SCENARIOS } from './scenarios.ts';
