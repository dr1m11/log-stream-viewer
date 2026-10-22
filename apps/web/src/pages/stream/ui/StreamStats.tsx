import { useId } from 'react';

import {
  type ConnectionStatus,
  type LogStreamSnapshot,
  type LogStreamStore,
  useLogStreamSelector,
} from '@/entities/log-stream';

const NUMBER_FORMAT = new Intl.NumberFormat('en-US');

// Each counter selects a number, so a counter that did not change does not re-render.
const selectReceived = (snapshot: LogStreamSnapshot): number => snapshot.counters.received;
const selectEventsPerSecond = (snapshot: LogStreamSnapshot): number =>
  snapshot.counters.eventsPerSecond;
const selectMissed = (snapshot: LogStreamSnapshot): number => snapshot.counters.missed;
const selectDropped = (snapshot: LogStreamSnapshot): number => snapshot.counters.dropped;
const selectInvalidFrames = (snapshot: LogStreamSnapshot): number =>
  snapshot.counters.invalidFrames;
const selectStatus = (snapshot: LogStreamSnapshot): ConnectionStatus => snapshot.status;

/** One counter: a group named by its label ("Events received, group, 1,234"). */
function Stat({
  store,
  label,
  select,
}: {
  store: LogStreamStore;
  label: string;
  select: (snapshot: LogStreamSnapshot) => number;
}) {
  const labelId = useId();
  const value = useLogStreamSelector(store, select);
  return (
    <div role="group" aria-labelledby={labelId}>
      <div id={labelId} className="text-xs text-fg-muted">
        {label}
      </div>
      <div className="font-mono text-2xl tabular-nums">{NUMBER_FORMAT.format(value)}</div>
    </div>
  );
}

/** The effective stream settings, once the server has sent them. */
function StreamSettingsNote({ store }: { store: LogStreamStore }) {
  const status = useLogStreamSelector(store, selectStatus);
  if (status.phase !== 'connected') return null;
  const { scenario, rate, seed } = status.stream;
  return (
    <p className="mt-3 text-sm text-fg-muted">
      Scenario {scenario} at {NUMBER_FORMAT.format(rate)} events/s, seed {seed}. Missed events are
      gaps in the event sequence numbers; they include the events the server reports as dropped
      under backpressure.
    </p>
  );
}

/**
 * Stream counters; each re-renders only when its own number changes, at most once per animation
 * frame. Deliberately not a live region: announcing numbers that change many times a second
 * would drown out everything else for screen-reader users.
 */
export function StreamStats({ store }: { store: LogStreamStore }) {
  const headingId = useId();

  return (
    <section
      aria-labelledby={headingId}
      className="rounded-lg border border-border bg-surface-raised p-4"
    >
      <h2 id={headingId} className="text-sm font-semibold">
        Stream
      </h2>
      <div className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
        <Stat store={store} label="Events received" select={selectReceived} />
        <Stat store={store} label="Events per second" select={selectEventsPerSecond} />
        <Stat store={store} label="Missed events" select={selectMissed} />
        <Stat store={store} label="Dropped by server" select={selectDropped} />
        <Stat store={store} label="Invalid frames" select={selectInvalidFrames} />
      </div>
      <StreamSettingsNote store={store} />
    </section>
  );
}
