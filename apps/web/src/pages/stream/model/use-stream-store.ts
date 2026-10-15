import { useEffect, useState, useSyncExternalStore } from 'react';

import { openStreamSocket } from '@/shared/api';
import { STREAM_URL } from '@/shared/config';

import { readStreamRequest } from '../lib/read-stream-request';
import { createStreamStore, type StreamSnapshot, type StreamStore } from './stream-store';

/**
 * The page's stream: connects on mount with the settings from the page URL (`?rate`, `?scenario`,
 * `?seed`) and closes on unmount. The store object never changes, so passing it down does not
 * re-render anything; components subscribe to the parts they show with {@link useStreamSelector}.
 */
export function useStreamStore(): StreamStore {
  const [store] = useState(() => {
    const request = readStreamRequest(window.location.search);
    return createStreamStore((handlers) => openStreamSocket(STREAM_URL, request, handlers));
  });

  useEffect(() => {
    store.start();
    return () => {
      store.stop();
    };
  }, [store]);

  return store;
}

/**
 * A part of the stream snapshot. The component re-renders only when the selected value changes
 * (`Object.is`), so `select` must return a value from the snapshot, not build a new object.
 */
export function useStreamSelector<T>(
  store: StreamStore,
  select: (snapshot: StreamSnapshot) => T,
): T {
  return useSyncExternalStore(store.subscribe, () => select(store.getSnapshot()));
}
