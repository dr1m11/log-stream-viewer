import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { Button } from './Button';

describe('Button', () => {
  it('renders a non-submitting button by default', () => {
    render(<Button>Pause</Button>);
    expect(screen.getByRole('button', { name: 'Pause' })).toHaveAttribute('type', 'button');
  });

  it('calls onClick when activated with the mouse or keyboard', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Pause</Button>);

    await user.click(screen.getByRole('button', { name: 'Pause' }));
    await user.keyboard('{Enter}');
    await user.keyboard(' ');
    expect(onClick).toHaveBeenCalledTimes(3);
  });

  it('does not fire when disabled', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <Button disabled onClick={onClick}>
        Pause
      </Button>,
    );

    await user.click(screen.getByRole('button', { name: 'Pause' }));
    expect(onClick).not.toHaveBeenCalled();
  });

  it('renders its child with button styles when asChild is set', () => {
    render(
      <Button asChild variant="primary">
        <a href="/docs">Docs</a>
      </Button>,
    );

    const link = screen.getByRole('link', { name: 'Docs' });
    expect(link).toHaveAttribute('href', '/docs');
    expect(link).not.toHaveAttribute('type');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('merges a custom className', () => {
    render(<Button className="w-full">Pause</Button>);
    expect(screen.getByRole('button', { name: 'Pause' })).toHaveClass('w-full');
  });
});
