// Test-facing: lets a test that stubs the global `Worker` answer as the stream worker would.
export type { FromWorkerMessage } from './api/worker-protocol';
export type {
  ConnectionStatus,
  LogBufferView,
  LogStreamOptions,
  LogStreamSnapshot,
  LogStreamStore,
} from './model/log-stream-store';
export { useLogStreamSelector, useLogStreamStore } from './model/use-log-stream';
