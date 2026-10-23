import { describe, expect, it } from 'vitest';

import { truncatedNote } from './payload-note';

describe('truncatedNote', () => {
  it('gives the size of the whole payload in whole KB, rounded up', () => {
    expect(truncatedNote(200_000)).toBe('… truncated (196 KB total)');
    expect(truncatedNote(65_537)).toBe('… truncated (65 KB total)');
  });
});
