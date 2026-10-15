import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppErrorBoundary } from './AppErrorBoundary';

let shouldThrow = true;

function Flaky() {
  if (shouldThrow) throw new Error('Render failed');
  return <p>Recovered</p>;
}

describe('AppErrorBoundary', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows the error and renders the children again after "Try again"', async () => {
    // React reports the caught error on the console; keep the test output clean.
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const user = userEvent.setup();
    shouldThrow = true;
    render(
      <AppErrorBoundary>
        <Flaky />
      </AppErrorBoundary>,
    );

    expect(screen.getByRole('alert')).toHaveTextContent('Render failed');

    shouldThrow = false;
    await user.click(screen.getByRole('button', { name: 'Try again' }));

    expect(screen.getByText('Recovered')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
