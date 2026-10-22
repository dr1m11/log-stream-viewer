import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';

import { cn } from '@/shared/lib/cn';

// Filled tones put surface-raised text on a text-colour token, which keeps 4.5:1 in both themes
// (tokens.css). There is no separate warning token: warning reuses the warn level's colour.
const badgeVariants = cva(
  'inline-flex h-5 shrink-0 items-center gap-1 rounded-full px-1.5 text-xs font-medium whitespace-nowrap tabular-nums [&_svg]:size-3 [&_svg]:shrink-0',
  {
    variants: {
      tone: {
        neutral: 'bg-surface-muted text-fg-muted',
        accent: 'bg-accent text-surface-raised',
        success: 'bg-success text-surface-raised',
        warning: 'bg-level-warn text-surface-raised',
        danger: 'bg-danger text-surface-raised',
      },
    },
    defaultVariants: {
      tone: 'neutral',
    },
  },
);

export interface BadgeProps extends ComponentProps<'span'>, VariantProps<typeof badgeVariants> {}

/**
 * A small, non-interactive label, such as a dropped-events count. Colour is never the only signal:
 * pair a tone with an icon or words, and give a bare number words for screen readers ("3 dropped").
 */
export function Badge({ className, tone, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}
