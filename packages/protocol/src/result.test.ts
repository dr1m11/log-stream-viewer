import { describe, expect, it } from 'vitest';

import { err, ok, type Result } from './result.ts';

describe('Result helpers', () => {
  it('ok() wraps a value as a success', () => {
    expect(ok(42)).toEqual({ ok: true, value: 42 });
  });

  it('err() wraps an error as a failure', () => {
    expect(err('boom')).toEqual({ ok: false, error: 'boom' });
  });

  it('narrows by the ok discriminant', () => {
    const results: Result<number, string>[] = [ok(1), err('nope')];
    const described = results.map((result) =>
      result.ok ? `value ${String(result.value)}` : `error ${result.error}`,
    );
    expect(described).toEqual(['value 1', 'error nope']);
  });
});
