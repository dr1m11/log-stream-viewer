import {
  type LogBufferView,
  type LogStreamSnapshot,
  type LogStreamStore,
  useLogStreamSelector,
} from '@/entities/log-stream';

import { LogGrid } from './LogGrid';

// Each selector returns a value kept in the snapshot, so the table re-renders only when the buffer
// (a new session) or its range changes, never for the counters.
const selectBuffer = (snapshot: LogStreamSnapshot): LogBufferView => snapshot.buffer;
const selectStart = (snapshot: LogStreamSnapshot): number => snapshot.start;
const selectEnd = (snapshot: LogStreamSnapshot): number => snapshot.end;

export interface LogTableProps {
  readonly store: LogStreamStore;
}

/**
 * The live event table: every retained event of the stream, oldest first, following the newest
 * one unless the user scrolls away. Re-renders at most once per animation frame (the snapshot
 * rate), and then renders only the rows in view.
 */
export function LogTable({ store }: LogTableProps) {
  const buffer = useLogStreamSelector(store, selectBuffer);
  const start = useLogStreamSelector(store, selectStart);
  const end = useLogStreamSelector(store, selectEnd);
  return <LogGrid buffer={buffer} start={start} end={end} />;
}
