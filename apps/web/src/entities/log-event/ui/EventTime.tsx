import { formatEventDateTime, formatEventTime } from '../lib/event-time';

export interface EventTimeProps {
  readonly ts: number;
  /** Shows the date before the time of day (the details view); table rows show the time only. */
  readonly withDate?: boolean;
  readonly className?: string;
}

/** An event's timestamp as the time of day (or date and time), with the full instant in `dateTime`. */
export function EventTime({ ts, withDate = false, className }: EventTimeProps) {
  return (
    <time dateTime={new Date(ts).toISOString()} className={className}>
      {withDate ? formatEventDateTime(ts) : formatEventTime(ts)}
    </time>
  );
}
