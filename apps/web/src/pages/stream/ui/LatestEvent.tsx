import type { LogEvent, LogLevel } from '@lsv/protocol';
import { useId } from 'react';

import {
  type LogStreamSnapshot,
  type LogStreamStore,
  useLogStreamSelector,
} from '@/entities/log-stream';
import { cn } from '@/shared/lib/cn';

const TIME_FORMAT = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  fractionalSecondDigits: 3,
  hourCycle: 'h23',
});

const LEVEL_CLASSES: Record<LogLevel, string> = {
  trace: 'text-level-trace',
  debug: 'text-level-debug',
  info: 'text-level-info',
  warn: 'text-level-warn',
  error: 'text-level-error',
  fatal: 'text-level-fatal',
};

function selectLatest(snapshot: LogStreamSnapshot): LogEvent | undefined {
  return snapshot.latest;
}

/** The newest event: re-renders at most four times per second (`PREVIEW_INTERVAL_MS`). */
export function LatestEvent({ store }: { store: LogStreamStore }) {
  const headingId = useId();
  const event = useLogStreamSelector(store, selectLatest);

  return (
    <section
      aria-labelledby={headingId}
      className="rounded-lg border border-border bg-surface-raised p-4"
    >
      <h2 id={headingId} className="text-sm font-semibold">
        Latest event
      </h2>
      {event === undefined ? (
        <p className="mt-3 text-sm text-fg-muted">No events yet.</p>
      ) : (
        <p className="mt-3 flex flex-wrap items-baseline gap-x-3 gap-y-1 font-mono text-sm">
          <time dateTime={new Date(event.ts).toISOString()} className="text-fg-muted">
            {TIME_FORMAT.format(event.ts)}
          </time>
          <span className={cn('font-semibold uppercase', LEVEL_CLASSES[event.level])}>
            {event.level}
          </span>
          <span>{event.service}</span>
          <span className="min-w-0 break-words">{event.message}</span>
        </p>
      )}
    </section>
  );
}
