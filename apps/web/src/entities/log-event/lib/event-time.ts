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
