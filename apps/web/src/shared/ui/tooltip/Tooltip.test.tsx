import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { Tooltip, TooltipProvider } from './Tooltip';

describe('Tooltip', () => {
  it('is hidden until the trigger is focused, then describes it', async () => {
    const user = userEvent.setup();
    render(
      <TooltipProvider delayDuration={0}>
        <Tooltip content="Scroll to the newest event">
          <button type="button">Jump to latest</button>
        </Tooltip>
      </TooltipProvider>,
    );

    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();

    await user.tab();
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Scroll to the newest event');
    expect(screen.getByRole('button', { name: 'Jump to latest' })).toHaveAccessibleDescription(
      'Scroll to the newest event',
    );
  });

  it('opens on hover', async () => {
    const user = userEvent.setup();
    render(
      <TooltipProvider delayDuration={0}>
        <Tooltip content="Help">
          <button type="button">?</button>
        </Tooltip>
      </TooltipProvider>,
    );

    await user.hover(screen.getByRole('button', { name: '?' }));
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Help');
  });

  it('adds no <style> elements, which the production CSP would block', async () => {
    const user = userEvent.setup();
    render(
      <TooltipProvider delayDuration={0}>
        <Tooltip content="Help">
          <button type="button">?</button>
        </Tooltip>
      </TooltipProvider>,
    );

    await user.hover(screen.getByRole('button', { name: '?' }));
    await screen.findByRole('tooltip');
    expect(document.querySelectorAll('style')).toHaveLength(0);
  });

  it('closes on Escape', async () => {
    const user = userEvent.setup();
    render(
      <TooltipProvider delayDuration={0}>
        <Tooltip content="Help">
          <button type="button">?</button>
        </Tooltip>
      </TooltipProvider>,
    );

    await user.tab();
    await screen.findByRole('tooltip');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });
});
