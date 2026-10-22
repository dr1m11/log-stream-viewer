import { useEffect, useState, useSyncExternalStore } from 'react';

import {
  createLogStreamStore,
  type LogStreamOptions,
  type LogStreamSnapshot,
  type LogStreamStore,
} from './log-stream-store';

/**
 * A stream for the lifetime of the component: the store is created once from `getOptions`
 * (called on the first render only), started on mount and stopped on unmount, which terminates
 * the worker. The store object never changes, so passing it down re-renders nothing; components
 * subscribe to the parts they show with {@link useLogStreamSelector}.
 */
export function useLogStreamStore(getOptions: () => LogStreamOptions): LogStreamStore {
  const [store] = useState(() => createLogStreamStore(getOptions()));

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
export function useLogStreamSelector<T>(
  store: LogStreamStore,
  select: (snapshot: LogStreamSnapshot) => T,
): T {
  return useSyncExternalStore(store.subscribe, () => select(store.getSnapshot()));
}
