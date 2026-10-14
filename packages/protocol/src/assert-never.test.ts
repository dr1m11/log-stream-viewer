import { describe, expect, it } from 'vitest';

import { assertNever } from './assert-never.ts';

type Shape = { kind: 'circle' } | { kind: 'square' };

function describeShape(shape: Shape): string {
  switch (shape.kind) {
    case 'circle':
      return 'round';
    case 'square':
      return 'angular';
    default:
      return assertNever(shape);
  }
}

describe('assertNever', () => {
  it('is unreachable when every variant is handled', () => {
    expect(describeShape({ kind: 'circle' })).toBe('round');
    expect(describeShape({ kind: 'square' })).toBe('angular');
  });

  it('throws with the unhandled value when reached at runtime', () => {
    const unexpected: unknown = { kind: 'triangle' };
    expect(() => describeShape(unexpected as Shape)).toThrow(
      'Unhandled variant: {"kind":"triangle"}',
    );
  });
});
