import { LOG_LEVELS } from '@lsv/protocol';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { LevelLabel } from './LevelLabel';

describe('LevelLabel', () => {
  it.each(LOG_LEVELS)('writes out the "%s" level in its own colour', (level) => {
    render(<LevelLabel level={level} />);

    expect(screen.getByText(level)).toHaveClass(`text-level-${level}`);
  });
});
