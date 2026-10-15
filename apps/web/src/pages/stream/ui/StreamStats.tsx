import { useId } from 'react';

import type { StreamSnapshot, StreamStore } from '../model/stream-store';
import { useStreamSelector } from '../model/use-stream-store';

const NUMBER_FORMAT = new Intl.NumberFormat('en-US');

function selectSnapshot(snapshot: StreamSnapshot): StreamSnapshot {
  return snapshot;
}

/** One counter: a group named by its label ("Events received, group, 1,234"). */
function Stat({ label, value }: { label: string; value: number }) {
  const labelId = useId();
  return (
    <div role="group" aria-labelledby={labelId}>
      <div id={labelId} className="text-xs text-fg-muted">
        {label}
      </div>
      <div className="font-mono text-2xl tabular-nums">{NUMBER_FORMAT.format(value)}</div>
    </div>
  );
}

/**
 * Stream counters. Re-renders with every published snapshot — at most once per animation frame.
 * Deliberately not a live region: announcing numbers that change many times a second would drown
 * out everything else for screen-reader users.
 */
export function StreamStats({ store }: { store: StreamStore }) {
  const headingId = useId();
  const { status, received, eventsPerSecond, missed, invalidFrames } = useStreamSelector(
    store,
    selectSnapshot,
  );

  return (
    <section
      aria-labelledby={headingId}
      className="rounded-lg border border-border bg-surface-raised p-4"
    >
      <h2 id={headingId} className="text-sm font-semibold">
        Stream
      </h2>
      <div className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Stat label="Events received" value={received} />
        <Stat label="Events per second" value={eventsPerSecond} />
        <Stat label="Missed events" value={missed} />
        <Stat label="Invalid frames" value={invalidFrames} />
      </div>
      {status.phase === 'connected' && (
        <p className="mt-3 text-sm text-fg-muted">
          Scenario {status.stream.scenario} at {NUMBER_FORMAT.format(status.stream.rate)} events/s,
          seed {status.stream.seed}. Missed events are gaps in the event sequence numbers.
        </p>
      )}
    </section>
  );
}
