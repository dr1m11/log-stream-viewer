/** The key shown for the shortcut in hints (`Kbd`) and `aria-keyshortcuts`. */
export const PAUSE_SHORTCUT_KEY = 'P';

/** Elements where a letter key types text or picks an option instead of running a shortcut. */
const TYPING_TARGETS = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';

/** The parts of a `KeyboardEvent` the shortcut reads. */
export type ShortcutKeyEvent = Pick<
  KeyboardEvent,
  'key' | 'code' | 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'repeat' | 'defaultPrevented'
> & { readonly target: EventTarget | null };

/**
 * Whether a page-wide `keydown` toggles the pause: a bare P (no modifier — Ctrl+P prints — and no
 * auto-repeat), not handled by anything else and not typed into a form field. On a layout whose P
 * key produces another letter (Cyrillic, Greek…) the physical key counts too.
 */
export function isPauseShortcut(event: ShortcutKeyEvent): boolean {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false;
  if (event.repeat || event.defaultPrevented) return false;
  const key = event.key.toLowerCase();
  const isP = key === 'p' || (event.code === 'KeyP' && !/^[a-z]$/.test(key));
  if (!isP) return false;
  return !(event.target instanceof Element && event.target.closest(TYPING_TARGETS) !== null);
}
