import { describe, expect, it } from 'vitest';

import { cn } from './cn';

describe('cn', () => {
  it('joins truthy class names and skips falsy ones', () => {
    expect(cn('px-2', false, undefined, { 'font-mono': true, hidden: false })).toBe(
      'px-2 font-mono',
    );
  });

  it('lets the last conflicting Tailwind utility win, including token colours', () => {
    expect(cn('px-2', 'px-4')).toBe('px-4');
    expect(cn('text-fg', 'text-level-error')).toBe('text-level-error');
  });
});
