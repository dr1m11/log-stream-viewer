import { cva, type VariantProps } from 'class-variance-authority';
import { Slot } from 'radix-ui';
import type { ComponentProps } from 'react';

import { cn } from '@/shared/lib/cn';

// The keyboard focus ring comes from the global :focus-visible style in app/styles/index.css.
// Filled variants put surface-raised text on the fill: the same token pair as the text colours,
// so it keeps 4.5:1 in both themes, also at 90% opacity on hover (tokens.css).
// `aria-disabled` (IconButton) looks like `disabled` but keeps hover and focus for the tooltip;
// only the hover fill is dropped.
const buttonVariants = cva(
  'inline-flex shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-md font-medium whitespace-nowrap transition-colors select-none disabled:pointer-events-none disabled:opacity-50 aria-disabled:cursor-not-allowed aria-disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        primary: 'bg-accent text-surface-raised not-aria-disabled:hover:bg-accent/90',
        secondary:
          'border border-border bg-surface-raised text-fg not-aria-disabled:hover:bg-surface-muted',
        ghost: 'text-fg not-aria-disabled:hover:bg-surface-muted',
        danger: 'bg-danger text-surface-raised not-aria-disabled:hover:bg-danger/90',
      },
      size: {
        sm: 'h-7 px-2.5 text-xs',
        md: 'h-8 px-3 text-sm',
        icon: 'size-8',
      },
    },
    defaultVariants: {
      variant: 'secondary',
      size: 'md',
    },
  },
);

export interface ButtonProps extends ComponentProps<'button'>, VariantProps<typeof buttonVariants> {
  /** Render the single child (e.g. a link) with button styles instead of a `<button>`. */
  asChild?: boolean;
}

/** A text button; `type="button"` by default so it never submits a form by accident. */
export function Button({
  className,
  variant,
  size,
  asChild = false,
  type = 'button',
  ...props
}: ButtonProps) {
  const classes = cn(buttonVariants({ variant, size }), className);
  if (asChild) return <Slot.Root className={classes} {...props} />;
  return <button type={type} className={classes} {...props} />;
}
