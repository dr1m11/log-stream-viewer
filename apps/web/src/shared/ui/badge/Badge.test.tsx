import { render, screen } from '@testing-library/react';
import { TriangleAlert } from 'lucide-react';
import { describe, expect, it } from 'vitest';

import { Badge } from './Badge';

describe('Badge', () => {
  it('shows its content as plain text, not as a control', () => {
    render(
      <p>
        Stream{' '}
        <Badge tone="warning">
          <TriangleAlert aria-hidden />3<span className="sr-only"> dropped</span>
        </Badge>
      </p>,
    );

    expect(screen.getByText('Stream', { exact: false })).toHaveTextContent('Stream 3 dropped');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('merges a custom className', () => {
    render(<Badge className="ml-auto">3</Badge>);
    expect(screen.getByText('3')).toHaveClass('ml-auto');
  });
});
