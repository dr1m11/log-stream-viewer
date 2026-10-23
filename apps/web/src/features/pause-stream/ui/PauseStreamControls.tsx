import { Pause, Play, TriangleAlert } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import {
  eventsSincePause,
  evictedSincePause,
  type LogStreamSnapshot,
  type LogStreamStore,
  useLogStreamSelector,
} from '@/entities/log-stream';
import { Badge } from '@/shared/ui/badge';
import { Button } from '@/shared/ui/button';
import { IconButton } from '@/shared/ui/icon-button';

import { isPauseShortcut, PAUSE_SHORTCUT_KEY } from '../lib/pause-shortcut';

const NUMBER_FORMAT = new Intl.NumberFormat('en-US');

// Numbers and booleans: a component re-renders only when what it shows changes.
const selectPaused = (snapshot: LogStreamSnapshot): boolean => snapshot.paused !== undefined;
const selectNewEvents = (snapshot: LogStreamSnapshot): number => eventsSincePause(snapshot);
const selectEvicted = (snapshot: LogStreamSnapshot): number => evictedSincePause(snapshot);
const selectEvicting = (snapshot: LogStreamSnapshot): boolean => evictedSincePause(snapshot) > 0;

function togglePause(store: LogStreamStore): void {
  if (store.getSnapshot().paused === undefined) store.pause();
  else store.resume();
}

function plural(count: number, one: string, many: string): string {
  return `${NUMBER_FORMAT.format(count)} ${count === 1 ? one : many}`;
}

/**
 * What the pause holds back: the events received since (they appear on resume) and, once the full
 * buffer starts evicting rows the user could have scrolled to, how many are gone. Both counts change
 * every frame, so neither is a live region; {@link PauseAnnouncement} speaks for them.
 */
function PausedStatus({ store, onResume }: { store: LogStreamStore; onResume: () => void }) {
  const newEvents = useLogStreamSelector(store, selectNewEvents);
  const evicted = useLogStreamSelector(store, selectEvicted);
  return (
    <>
      <Badge tone="accent">{plural(newEvents, 'new event', 'new events')}</Badge>
      <Button size="sm" onClick={onResume}>
        <Play aria-hidden="true" />
        Resume
      </Button>
      {evicted > 0 && (
        // Wraps on narrow screens instead of overflowing like a one-line badge.
        <Badge tone="warning" className="h-auto min-h-5 py-0.5 whitespace-normal">
          <TriangleAlert aria-hidden="true" />
          {plural(evicted, 'older event', 'older events')} evicted while paused — the buffer is full
        </Badge>
      )}
    </>
  );
}

/**
 * A polite live region that speaks once per change of state — paused, evicting, resumed — never
 * per frame. It is always rendered, so screen readers pick up its first change.
 */
function PauseAnnouncement({ store }: { store: LogStreamStore }) {
  const paused = useLogStreamSelector(store, selectPaused);
  const evicting = useLogStreamSelector(store, selectEvicting);
  const [wasPaused, setWasPaused] = useState(false);
  if (paused && !wasPaused) setWasPaused(true);

  let message = '';
  if (paused && evicting) {
    message = 'The buffer is full: older events are evicted while the stream view is paused.';
  } else if (paused) {
    message = 'Stream view paused. New events are kept in the buffer.';
  } else if (wasPaused) {
    message = 'Stream view resumed.';
  }
  return (
    <p aria-live="polite" className="sr-only">
      {message}
    </p>
  );
}

/**
 * Pause and resume the stream view (`store.pause()` / `store.resume()`): a toggle button, the
 * page-wide shortcut P (not while typing in a form field) and, while paused, the count of new
 * events with a Resume action and the eviction warning. The stream itself never pauses: the
 * buffer keeps receiving, and evicting at its capacity.
 *
 * The toggle keeps one accessible name, "Pause stream", and reports its state with `aria-pressed`
 * (WAI-ARIA APG: a toggle's label must not change with its state, or "Resume stream, pressed"
 * would mean the opposite of what it says). Pressed, it is filled with the accent colour.
 */
export function PauseStreamControls({ store }: { store: LogStreamStore }) {
  const paused = useLogStreamSelector(store, selectPaused);
  const toggleRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (!isPauseShortcut(event)) return;
      event.preventDefault();
      togglePause(store);
    }
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [store]);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <IconButton
        ref={toggleRef}
        label="Pause stream"
        shortcut={[PAUSE_SHORTCUT_KEY]}
        aria-pressed={paused}
        aria-keyshortcuts={PAUSE_SHORTCUT_KEY}
        variant={paused ? 'primary' : 'secondary'}
        onClick={() => {
          togglePause(store);
        }}
      >
        <Pause aria-hidden="true" />
      </IconButton>
      {paused && (
        <PausedStatus
          store={store}
          onResume={() => {
            store.resume();
            // The Resume button disappears with the pause: keep the focus next to it.
            toggleRef.current?.focus();
          }}
        />
      )}
      <PauseAnnouncement store={store} />
    </div>
  );
}
