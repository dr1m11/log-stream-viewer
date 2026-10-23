// Created once: constructing an Intl formatter is far more expensive than calling it, and the
// table formats a timestamp for every row it renders.
const TIME_FORMAT = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  fractionalSecondDigits: 3,
  hourCycle: 'h23',
});

/** The time of day of an event (epoch ms) in the viewer's time zone: `14:03:07.512`. */
export function formatEventTime(ts: number): string {
  return TIME_FORMAT.format(ts);
}

const DATE_FORMAT = new Intl.DateTimeFormat('en-GB', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/**
 * The date and time of an event (epoch ms) in the viewer's time zone: `2026-10-22 14:03:07.512`.
 * For the details view, one event at a time; the table rows use {@link formatEventTime}.
 */
export function formatEventDateTime(ts: number): string {
  let year = '';
  let month = '';
  let day = '';
  for (const { type, value } of DATE_FORMAT.formatToParts(ts)) {
    if (type === 'year') year = value;
    else if (type === 'month') month = value;
    else if (type === 'day') day = value;
  }
  return `${year}-${month}-${day} ${formatEventTime(ts)}`;
}
