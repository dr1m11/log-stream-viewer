import type {
  BatchMessage,
  HeartbeatMessage,
  HelloMessage,
  LogEvent,
  StreamSettings,
} from '@lsv/protocol';

const START_MS = 1_791_979_200_000;

/** A valid `hello` message; `stream` overrides the stream settings. */
export function testHello(stream: Partial<StreamSettings> = {}): HelloMessage {
  return {
    type: 'hello',
    protocolVersion: 1,
    streamId: 'st_test',
    resumed: false,
    serverTime: START_MS,
    stream: { rate: 200, scenario: 'steady', seed: 42, ...stream },
    limits: { minRate: 10, maxRate: 20_000, sessionMaxMs: 1_800_000 },
    expiresAt: START_MS + 1_800_000,
  };
}

/** A valid log event; `seq` sets its timestamp and message unless they are overridden. */
export function testLogEvent(seq: number, overrides: Partial<LogEvent> = {}): LogEvent {
  return {
    seq,
    ts: START_MS + seq,
    level: 'info',
    service: 'orders',
    host: 'orders-1a6e-1',
    message: `event ${String(seq)}`,
    ...overrides,
  };
}

/** A valid `batch` message with one {@link testLogEvent} per `seq` (pass them in ascending order). */
export function testBatch(seqs: readonly number[]): BatchMessage {
  return { type: 'batch', sentAt: START_MS, events: seqs.map((seq) => testLogEvent(seq)) };
}

/** A valid `heartbeat` message. */
export function testHeartbeat(lastSeq = 0): HeartbeatMessage {
  return { type: 'heartbeat', serverTime: START_MS, lastSeq };
}
