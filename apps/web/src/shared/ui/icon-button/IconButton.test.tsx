import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Pause } from 'lucide-react';
import type { ReactElement } from 'react';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';

import { TooltipProvider } from '@/shared/ui/tooltip';

import { IconButton, type IconButtonProps } from './IconButton';

function renderWithProvider(ui: ReactElement) {
  return render(<TooltipProvider delayDuration={0}>{ui}</TooltipProvider>);
}

describe('IconButton', () => {
  it('uses the label as the accessible name', () => {
    renderWithProvider(
      <IconButton label="Pause">
        <Pause aria-hidden />
      </IconButton>,
    );
    expect(screen.getByRole('button', { name: 'Pause' })).toBeInTheDocument();
  });

  it('requires a label instead of a free aria-label', () => {
    // Checked by `tsc` (pnpm typecheck): an icon-only button without a label has no accessible name.
    expectTypeOf<Pick<IconButtonProps, 'label'>>().toEqualTypeOf<{ label: string }>();
    expectTypeOf<IconButtonProps>().not.toHaveProperty('aria-label');
  });

  it('shows the label as a tooltip on keyboard focus', async () => {
    const user = userEvent.setup();
    renderWithProvider(
      <IconButton label="Pause">
        <Pause aria-hidden />
      </IconButton>,
    );

    await user.tab();
    expect(screen.getByRole('button', { name: 'Pause' })).toHaveFocus();
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Pause');
  });

  it('shows the keys of its shortcut in the tooltip', async () => {
    const user = userEvent.setup();
    renderWithProvider(
      <IconButton label="Pause" shortcut={['Shift', 'Space']}>
        <Pause aria-hidden />
      </IconButton>,
    );

    await user.tab();
    const tooltip = await screen.findByRole('tooltip');
    expect(tooltip).toHaveTextContent('Pause Shift Space');
    expect(screen.getByRole('button', { name: 'Pause' })).toBeInTheDocument();
    expect(within(tooltip).getByText('Shift').tagName).toBe('KBD');
  });

  it('forwards clicks', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    renderWithProvider(
      <IconButton label="Pause" onClick={onClick}>
        <Pause aria-hidden />
      </IconButton>,
    );

    await user.click(screen.getByRole('button', { name: 'Pause' }));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('keeps a disabled button focusable with its tooltip, but ignores activation', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    renderWithProvider(
      <IconButton label="Pause" disabled onClick={onClick}>
        <Pause aria-hidden />
      </IconButton>,
    );
    const button = screen.getByRole('button', { name: 'Pause' });
    expect(button).toHaveAttribute('aria-disabled', 'true');

    await user.hover(button);
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Pause');
    await user.unhover(button);

    await user.tab();
    expect(button).toHaveFocus();
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Pause');

    await user.click(button);
    await user.keyboard('{Enter}');
    await user.keyboard(' ');
    expect(onClick).not.toHaveBeenCalled();
  });

  it('shows a shortcut that repeats a key', async () => {
    const user = userEvent.setup();
    renderWithProvider(
      <IconButton label="Jump to latest" shortcut={['G', 'G']}>
        <Pause aria-hidden />
      </IconButton>,
    );

    await user.tab();
    const tooltip = await screen.findByRole('tooltip');
    expect(within(tooltip).getAllByText('G')).toHaveLength(2);
  });

  it('labels a link rendered with asChild', () => {
    renderWithProvider(
      <IconButton label="Source code" asChild>
        <a href="https://example.com">
          <Pause aria-hidden />
        </a>
      </IconButton>,
    );
    expect(screen.getByRole('link', { name: 'Source code' })).toHaveAttribute(
      'href',
      'https://example.com',
    );
  });
});
