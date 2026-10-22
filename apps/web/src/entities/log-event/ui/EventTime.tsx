import { formatEventTime } from '../lib/event-time';

/** An event's timestamp as the time of day, with the full instant in `dateTime`. */
export function EventTime({ ts, className }: { ts: number; className?: string }) {
  return (
    <time dateTime={new Date(ts).toISOString()} className={className}>
      {formatEventTime(ts)}
    </time>
  );
}
