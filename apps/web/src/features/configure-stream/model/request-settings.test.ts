import type { StreamSettings } from '@lsv/protocol';
import { describe, expect, it } from 'vitest';

import { settingsChange, type TargetSettings, targetSettings } from './request-settings';

const STREAM: StreamSettings = { rate: 200, scenario: 'steady', seed: 42 };

describe('targetSettings', () => {
  it('puts the pending change on top of the effective settings', () => {
    expect(targetSettings(STREAM, { pending: undefined, error: undefined })).toEqual({
      rate: 200,
      scenario: 'steady',
    });
    expect(
      targetSettings(STREAM, { pending: { requestId: 'cfg-1', rate: 900 }, error: undefined }),
    ).toEqual({ rate: 900, scenario: 'steady' });
  });
});

describe('settingsChange', () => {
  const target: TargetSettings = { rate: 200, scenario: 'steady' };

  it('keeps only the values that differ from the target', () => {
    expect(settingsChange(target, { rate: 500, scenario: 'steady' })).toEqual({ rate: 500 });
    expect(settingsChange(target, { scenario: 'traffic-spike' })).toEqual({
      scenario: 'traffic-spike',
    });
  });

  it('returns nothing when the values already are the target', () => {
    expect(settingsChange(target, { rate: 200 })).toBeUndefined();
    expect(settingsChange(target, {})).toBeUndefined();
  });
});
