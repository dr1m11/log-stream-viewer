import type { ComponentProps } from 'react';

import { cn } from '@/shared/lib/cn';

/** A keyboard key, e.g. in shortcut hints: <Kbd>Ctrl</Kbd> + <Kbd>K</Kbd>. */
export function Kbd({ className, ...props }: ComponentProps<'kbd'>) {
  return (
    <kbd
      className={cn(
        'inline-flex h-5 min-w-5 items-center justify-center rounded border border-border bg-surface-muted px-1 font-sans text-[0.6875rem] leading-none font-medium text-fg-muted',
        className,
      )}
      {...props}
    />
  );
}
