import { describe, expect, it } from 'vitest';

import { formatPayload, MAX_PAYLOAD_TEXT_LENGTH } from './format-payload';

describe('formatPayload', () => {
  it('pretty-prints a payload with two-space indentation', () => {
    expect(formatPayload({ orderId: 'o-1', items: [1, 2] })).toEqual({
      text: '{\n  "orderId": "o-1",\n  "items": [\n    1,\n    2\n  ]\n}',
      truncated: false,
      length: 53,
    });
  });

  it('cuts a large payload at the limit and reports its whole length', () => {
    const payload = { blob: 'x'.repeat(200_000) };
    const full = JSON.stringify(payload, null, 2);

    const result = formatPayload(payload);

    expect(result.truncated).toBe(true);
    expect(result.text).toHaveLength(MAX_PAYLOAD_TEXT_LENGTH);
    expect(full.startsWith(result.text)).toBe(true);
    expect(result.length).toBe(full.length);
  });

  it('does not split an emoji at the cut', () => {
    // '"a😀b"': the emoji is the surrogate pair at indexes 2 and 3.
    expect(formatPayload('a😀b', 3)).toEqual({ text: '"a', truncated: true, length: 6 });
    expect(formatPayload('a😀b', 4)).toEqual({ text: '"a😀', truncated: true, length: 6 });
  });

  it('keeps a payload exactly at the limit whole', () => {
    expect(formatPayload('abc', 5)).toEqual({ text: '"abc"', truncated: false, length: 5 });
    expect(formatPayload('abcd', 5)).toEqual({ text: '"abcd', truncated: true, length: 6 });
  });
});
