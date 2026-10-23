import { afterEach, describe, expect, it } from 'vitest';

import { isPauseShortcut, type ShortcutKeyEvent } from './pause-shortcut';

function keydown(overrides: Partial<ShortcutKeyEvent> = {}): ShortcutKeyEvent {
  return {
    key: 'p',
    code: 'KeyP',
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    repeat: false,
    defaultPrevented: false,
    target: document.body,
    ...overrides,
  };
}

/** Adds `html` to the document and returns its first element. */
function mount(html: string): Element {
  const container = document.createElement('div');
  container.innerHTML = html;
  document.body.append(container);
  const element = container.firstElementChild;
  if (element === null) throw new Error('Nothing to mount');
  return element;
}

describe('isPauseShortcut', () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it('accepts a bare P anywhere on the page, also with Caps Lock', () => {
    expect(isPauseShortcut(keydown())).toBe(true);
    expect(isPauseShortcut(keydown({ key: 'P' }))).toBe(true);
    expect(isPauseShortcut(keydown({ target: mount('<button>Other</button>') }))).toBe(true);
    expect(
      isPauseShortcut(keydown({ target: mount('<div role="treegrid" tabindex="0"></div>') })),
    ).toBe(true);
  });

  it('accepts the physical P key on a layout where it types another letter', () => {
    expect(isPauseShortcut(keydown({ key: 'з', code: 'KeyP' }))).toBe(true);
    // On Dvorak the P key types L: that is another Latin letter, so it is not the shortcut.
    expect(isPauseShortcut(keydown({ key: 'l', code: 'KeyP' }))).toBe(false);
    expect(isPauseShortcut(keydown({ key: 'p', code: 'KeyR' }))).toBe(true);
  });

  it('ignores other keys, modifiers, auto-repeat and handled events', () => {
    expect(isPauseShortcut(keydown({ key: 'o', code: 'KeyO' }))).toBe(false);
    expect(isPauseShortcut(keydown({ ctrlKey: true }))).toBe(false);
    expect(isPauseShortcut(keydown({ metaKey: true }))).toBe(false);
    expect(isPauseShortcut(keydown({ altKey: true }))).toBe(false);
    expect(isPauseShortcut(keydown({ key: 'P', shiftKey: true }))).toBe(false);
    expect(isPauseShortcut(keydown({ repeat: true }))).toBe(false);
    expect(isPauseShortcut(keydown({ defaultPrevented: true }))).toBe(false);
  });

  it('accepts P on inputs that take no text', () => {
    for (const html of [
      '<input type="radio">',
      '<input type="checkbox">',
      '<input type="range">',
      '<input type="button" value="Go">',
    ]) {
      expect(isPauseShortcut(keydown({ target: mount(html) }))).toBe(true);
    }
  });

  it('ignores keys typed into form fields', () => {
    for (const html of [
      '<input type="number">',
      '<input>',
      '<input type="search">',
      '<textarea></textarea>',
      '<select><option>a</option></select>',
      '<div contenteditable="true"><span>text</span></div>',
    ]) {
      const field = mount(html);
      expect(isPauseShortcut(keydown({ target: field.firstElementChild ?? field }))).toBe(false);
    }
  });
});
