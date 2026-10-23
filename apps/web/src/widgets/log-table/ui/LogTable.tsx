import {
  type LogBufferView,
  type LogStreamSnapshot,
  type LogStreamStore,
  shownEnd,
  useLogStreamSelector,
} from '@/entities/log-stream';

import { LogGrid } from './LogGrid';

// Each selector returns a value kept in the snapshot or a number, so the table re-renders only
// when the buffer (a new session) or its shown range changes, never for the counters — and, while
// paused, not for the events that keep arriving.
const selectBuffer = (snapshot: LogStreamSnapshot): LogBufferView => snapshot.buffer;
const selectStart = (snapshot: LogStreamSnapshot): number => snapshot.start;
const selectEnd = (snapshot: LogStreamSnapshot): number => shownEnd(snapshot);
const selectPaused = (snapshot: LogStreamSnapshot): boolean => snapshot.paused !== undefined;

export interface LogTableProps {
  readonly store: LogStreamStore;
}

/**
 * The live event table: every retained event of the stream, oldest first, following the newest
 * one unless the user scrolls away. Re-renders at most once per animation frame (the snapshot
 * rate), and then renders only the rows in view.
 *
 * While the stream view is paused (`store.pause()`) the table shows the retained rows up to the
 * pause point (`shownEnd`): no new row appears and it does not follow, but the oldest rows still
 * leave as the buffer evicts them. On resume it jumps to the newest row and follows again.
 */
export function LogTable({ store }: LogTableProps) {
  const buffer = useLogStreamSelector(store, selectBuffer);
  const start = useLogStreamSelector(store, selectStart);
  const end = useLogStreamSelector(store, selectEnd);
  const paused = useLogStreamSelector(store, selectPaused);
  return (
    <LogGrid
      buffer={buffer}
      start={start}
      end={end}
      paused={paused}
      getEventDetails={store.getEventDetails}
    />
  );
}
