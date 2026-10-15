import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { THEME_STORAGE_KEY } from './theme';
import { useTheme } from './use-theme';

function installColorScheme(prefersDark: boolean) {
  let matches = prefersDark;
  const listeners = new Set<() => void>();
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({
      get matches() {
        return matches;
      },
      addEventListener: (_type: 'change', listener: () => void) => listeners.add(listener),
      removeEventListener: (_type: 'change', listener: () => void) => listeners.delete(listener),
    })),
  );
  return {
    setPrefersDark(next: boolean) {
      matches = next;
      for (const listener of listeners) listener();
    },
  };
}

describe('useTheme', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('follows the system colour scheme by default', () => {
    const colorScheme = installColorScheme(true);
    const { result } = renderHook(() => useTheme());

    expect(result.current.preference).toBe('system');
    expect(result.current.resolvedTheme).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');

    act(() => {
      colorScheme.setPrefersDark(false);
    });
    expect(result.current.resolvedTheme).toBe('light');
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('applies and persists an explicit preference', () => {
    installColorScheme(true);
    const { result } = renderHook(() => useTheme());

    act(() => {
      result.current.setPreference('light');
    });

    expect(result.current.preference).toBe('light');
    expect(result.current.resolvedTheme).toBe('light');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('picks up a preference changed in another tab', () => {
    installColorScheme(false);
    const { result } = renderHook(() => useTheme());

    act(() => {
      window.localStorage.setItem(THEME_STORAGE_KEY, 'dark');
      window.dispatchEvent(new StorageEvent('storage', { key: THEME_STORAGE_KEY }));
    });

    expect(result.current.preference).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('ignores unknown stored values', () => {
    installColorScheme(false);
    window.localStorage.setItem(THEME_STORAGE_KEY, 'sepia');
    const { result } = renderHook(() => useTheme());

    expect(result.current.preference).toBe('system');
    expect(result.current.resolvedTheme).toBe('light');
  });

  it('falls back to the system preference when storage is unavailable', () => {
    installColorScheme(true);
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    const { result } = renderHook(() => useTheme());

    expect(result.current.preference).toBe('system');
    expect(() => {
      result.current.setPreference('light');
    }).not.toThrow();
  });
});
