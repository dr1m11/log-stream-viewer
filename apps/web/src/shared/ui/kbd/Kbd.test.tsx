import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Kbd } from './Kbd';

describe('Kbd', () => {
  it('renders a semantic <kbd> element', () => {
    render(
      <p>
        Press <Kbd>Ctrl</Kbd> + <Kbd>K</Kbd> to search
      </p>,
    );

    const keys = screen.getAllByText(/^(Ctrl|K)$/);
    expect(keys.map((key) => key.tagName)).toEqual(['KBD', 'KBD']);
    expect(screen.getByText(/to search/)).toHaveTextContent('Press Ctrl + K to search');
  });

  it('merges a custom className', () => {
    render(<Kbd className="ml-auto">Esc</Kbd>);
    expect(screen.getByText('Esc')).toHaveClass('ml-auto');
  });
});
