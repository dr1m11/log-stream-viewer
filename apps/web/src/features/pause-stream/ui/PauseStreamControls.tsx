import { Pause, Play, TriangleAlert } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

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
 * A count that changes every frame while paused, as text: the only part of the paused status that
 * re-renders per frame. Never a live region; {@link PauseAnnouncement} speaks for it.
 */
function LiveCount({
  store,
  select,
  one,
  many,
}: {
  store: LogStreamStore;
  select: (snapshot: LogStreamSnapshot) => number;
  one: string;
  many: string;
}) {
  const count = useLogStreamSelector(store, select);
  return plural(count, one, many);
}

/**
 * Shown once the full buffer starts evicting rows the user could have scrolled to when pausing;
 * re-renders only when that starts, its count updates on its own.
 */
function EvictionWarning({ store }: { store: LogStreamStore }) {
  const evicting = useLogStreamSelector(store, selectEvicting);
  if (!evicting) return null;
  return (
    // Wraps on narrow screens instead of overflowing like a one-line badge.
    <Badge tone="warning" className="h-auto min-h-5 py-0.5 whitespace-normal">
      <TriangleAlert aria-hidden="true" />
      <span>
        <LiveCount store={store} select={selectEvicted} one="older event" many="older events" />{' '}
        evicted while paused — the buffer is full
      </span>
    </Badge>
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
  const resume = useCallback(() => {
    store.resume();
    // The Resume button disappears with the pause: keep the focus next to it.
    toggleRef.current?.focus();
  }, [store]);

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
      {/* While paused only the counts re-render per frame; this component, once per toggle. */}
      {paused && (
        <>
          <Badge tone="accent">
            <LiveCount store={store} select={selectNewEvents} one="new event" many="new events" />
          </Badge>
          <Button size="sm" onClick={resume}>
            <Play aria-hidden="true" />
            Resume
          </Button>
          <EvictionWarning store={store} />
        </>
      )}
      <PauseAnnouncement store={store} />
    </div>
  );
}
