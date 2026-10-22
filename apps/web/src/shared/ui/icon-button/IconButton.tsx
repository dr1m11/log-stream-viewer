import { Fragment, type MouseEvent } from 'react';

import { Button, type ButtonProps } from '@/shared/ui/button';
import { Kbd } from '@/shared/ui/kbd';
import { Tooltip, type TooltipProps } from '@/shared/ui/tooltip';

export interface IconButtonProps extends Omit<ButtonProps, 'size' | 'aria-label'> {
  /** Accessible name of the control, also shown as its tooltip. Required: the button has no text. */
  label: string;
  /** Keys of the control's shortcut, shown after the label in the tooltip: ['Space']. */
  shortcut?: readonly string[] | undefined;
  tooltipSide?: TooltipProps['side'];
}

/**
 * Square icon-only button with a required label and a matching tooltip.
 *
 * `disabled` is rendered as `aria-disabled`, not the native attribute: a natively disabled button
 * gets no hover or focus, so its tooltip, the only visible name of an icon, could never be shown.
 * It stays in the tab order, is announced as dimmed, and its clicks are swallowed.
 */
export function IconButton({
  label,
  shortcut = [],
  tooltipSide = 'bottom',
  variant = 'ghost',
  disabled = false,
  onClick,
  ...props
}: IconButtonProps) {
  const handleClick = disabled
    ? (event: MouseEvent<HTMLButtonElement>) => {
        event.preventDefault();
      }
    : onClick;

  // The spaces only separate the words of the tooltip's text: flex layout drops them.
  const content =
    shortcut.length === 0 ? (
      label
    ) : (
      <span className="flex items-center gap-2">
        {label}{' '}
        <span className="flex gap-0.5">
          {shortcut.map((key, index) => (
            // A static list that may repeat a key (['G', 'G']): the index is the stable identity.
            // eslint-disable-next-line @eslint-react/no-array-index-key
            <Fragment key={index}>
              {index > 0 && ' '}
              <Kbd>{key}</Kbd>
            </Fragment>
          ))}
        </span>
      </span>
    );

  return (
    <Tooltip content={content} side={tooltipSide}>
      <Button
        {...props}
        variant={variant}
        size="icon"
        aria-label={label}
        aria-disabled={disabled || undefined}
        onClick={handleClick}
      />
    </Tooltip>
  );
}
