import { useCallback, useEffect, useSyncExternalStore } from 'react';

import {
  applyTheme,
  readThemePreference,
  type ResolvedTheme,
  resolveTheme,
  subscribeToSystemTheme,
  systemPrefersDark,
  type ThemePreference,
  writeThemePreference,
} from './theme';

// Preference changes made in this tab; other tabs are covered by the `storage` event.
const preferenceListeners = new Set<() => void>();

function subscribe(onChange: () => void): () => void {
  preferenceListeners.add(onChange);
  window.addEventListener('storage', onChange);
  const unsubscribeSystem = subscribeToSystemTheme(onChange);
  return () => {
    preferenceListeners.delete(onChange);
    window.removeEventListener('storage', onChange);
    unsubscribeSystem();
  };
}

function getResolvedTheme(): ResolvedTheme {
  return resolveTheme(readThemePreference(), systemPrefersDark());
}

function getServerPreference(): ThemePreference {
  return 'system';
}

function getServerResolvedTheme(): ResolvedTheme {
  return 'light';
}

export interface UseThemeResult {
  preference: ThemePreference;
  resolvedTheme: ResolvedTheme;
  setPreference: (preference: ThemePreference) => void;
}

/** Current theme preference and the theme actually applied; keeps `<html data-theme>` in sync. */
export function useTheme(): UseThemeResult {
  const preference = useSyncExternalStore(subscribe, readThemePreference, getServerPreference);
  const resolvedTheme = useSyncExternalStore(subscribe, getResolvedTheme, getServerResolvedTheme);

  useEffect(() => {
    applyTheme(resolvedTheme);
  }, [resolvedTheme]);

  const setPreference = useCallback((next: ThemePreference) => {
    writeThemePreference(next);
    for (const listener of preferenceListeners) listener();
  }, []);

  return { preference, resolvedTheme, setPreference };
}
