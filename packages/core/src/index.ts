/**
 * `@lsv/core` — the framework-free stream engine shared by the stream worker and the main thread:
 * a bounded columnar ring buffer, transferable column batches and stream statistics with an
 * injected clock. Design: docs/adr/0006-client-stream-pipeline.md.
 */

export {
  clampBufferCapacity,
  DEFAULT_BUFFER_CAPACITY,
  MAX_BUFFER_CAPACITY,
  MIN_BUFFER_CAPACITY,
} from './buffer-capacity.ts';
export { type ColumnBatch, columnBatchTransferables } from './column-batch.ts';
export { createEventStore, type EventStore, type EventStoreOptions } from './event-store.ts';
export { createStreamStats, type StreamCounters, type StreamStats } from './stream-stats.ts';
export {
  DEFAULT_DICTIONARY_CAPACITY,
  DICTIONARY_OVERFLOW_ID,
  DICTIONARY_OVERFLOW_LABEL,
} from './string-dictionary.ts';
