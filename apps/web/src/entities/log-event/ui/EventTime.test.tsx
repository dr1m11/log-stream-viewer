import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { formatEventDateTime, formatEventTime } from '../lib/event-time';
import { EventTime } from './EventTime';

describe('EventTime', () => {
  it('shows the time of day and carries the full instant in dateTime', () => {
    const ts = Date.UTC(2026, 9, 22, 21, 4, 5, 7);

    render(<EventTime ts={ts} />);

    const time = screen.getByText(formatEventTime(ts));
    expect(time.tagName).toBe('TIME');
    expect(time).toHaveAttribute('dateTime', '2026-10-22T21:04:05.007Z');
  });

  it('shows the date as well when asked to', () => {
    const ts = Date.UTC(2026, 9, 22, 21, 4, 5, 7);

    render(<EventTime ts={ts} withDate />);

    expect(screen.getByText(formatEventDateTime(ts))).toHaveAttribute(
      'dateTime',
      '2026-10-22T21:04:05.007Z',
    );
  });
});
