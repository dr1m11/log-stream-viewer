import { ChevronRight } from 'lucide-react';
import { type CSSProperties, memo, type MouseEvent, type Ref } from 'react';

import { EventTime, LevelLabel } from '@/entities/log-event';
import type { LogBufferView } from '@/entities/log-stream';
import { cn } from '@/shared/lib/cn';
import { IconButton } from '@/shared/ui/icon-button';

import { ROW_HEIGHT } from '../lib/table-scroll';
import { EventDetails, type GetEvent } from './EventDetails';

/**
 * Column layout shared by the header row and the data rows: details toggle, time, level, service,
 * message. The widths are in `ch` of the row's monospace font, so the header row must keep
 * `font-mono` too.
 */
export const ROW_COLUMNS =
  'grid grid-cols-[1.5rem_12ch_5ch_13ch_minmax(0,1fr)] items-center gap-x-3 pr-3 pl-1.5';

/** The number of columns, for `aria-colcount`. */
export const COLUMN_COUNT = 5;

/** Accessible name (and tooltip) of the disclosure button of every row. */
export const DETAILS_TOGGLE_LABEL = 'Event details';

/**
 * Find the disclosure button and the details cell (by their `data-` attributes): the grid handles
 * their clicks by delegation, so no row gets a handler of its own.
 */
export const DETAILS_TOGGLE_SELECTOR = '[data-details-toggle]';
export const DETAILS_CELL_SELECTOR = '[data-details]';

interface CellsProps {
  readonly buffer: LogBufferView;
  readonly position: number;
}

/**
 * The cells of the event at `position`. The event at a position never changes, so they re-render
 * only when their row element shows another position (while following, rows are recycled by
 * virtual index) or the buffer changes (a new session).
 */
const LogCells = memo(function LogCells({ buffer, position }: CellsProps) {
  if (!buffer.has(position)) {
    // Evicted by a batch that arrived after the snapshot that listed it: the next snapshot drops
    // the row, so it stays empty until then instead of showing another event's data.
    return (
      <>
        <div role="gridcell" />
        <div role="gridcell" />
        <div role="gridcell" />
        <div role="gridcell" />
      </>
    );
  }
  const message = buffer.messageAt(position);
  return (
    <>
      <div role="gridcell" className="text-fg-muted">
        <EventTime ts={buffer.tsAt(position)} />
      </div>
      <div role="gridcell">
        <LevelLabel level={buffer.levelAt(position)} />
      </div>
      <div role="gridcell" className="truncate">
        {buffer.serviceAt(position)}
      </div>
      <div role="gridcell" className="truncate" title={message}>
        {message}
      </div>
    </>
  );
});

/** Keeps the keyboard focus on the grid: the grid's Enter does what the button does. */
function keepFocus(event: MouseEvent): void {
  event.preventDefault();
}

/**
 * The disclosure button of a row. Its props do not depend on the position, so a recycled row
 * (following, keyed by index) re-renders its cells but not this button and its tooltip. Out of
 * the tab order (`tabIndex={-1}`) like every control inside a grid that manages focus with
 * `aria-activedescendant`: keyboard users press Enter on the active row instead.
 */
const DetailsToggle = memo(function DetailsToggle({
  expanded,
  controls,
}: {
  expanded: boolean;
  controls: string | undefined;
}) {
  return (
    <IconButton
      label={DETAILS_TOGGLE_LABEL}
      tooltipSide="right"
      tabIndex={-1}
      aria-expanded={expanded}
      aria-controls={controls}
      onMouseDown={keepFocus}
      className="size-6"
      data-details-toggle=""
    >
      <ChevronRight
        aria-hidden="true"
        className={cn('transition-transform', expanded && 'rotate-90')}
      />
    </IconButton>
  );
});

export interface LogRowProps {
  readonly buffer: LogBufferView;
  /** Buffer position of the event (the grid picks the React key: index or position, by mode). */
  readonly position: number;
  /** Virtual index (`position - start`), read by the virtualizer from `data-index`. */
  readonly index: number;
  /** Element id, the target of the grid's `aria-activedescendant`. */
  readonly id: string;
  /** Whether this is the grid's active row (keyboard cursor). */
  readonly active: boolean;
  /** Whether the row's details are open. */
  readonly expanded: boolean;
  /** Fetches the full event for the details. */
  readonly getEvent: GetEvent;
  /** Attached to the details cell of the expanded row, which the grid measures. */
  readonly detailsRef: Ref<HTMLDivElement>;
}

// Shared by every row and every render: the active state is styled through `data-active`.
const ROW_STYLE: CSSProperties = { height: ROW_HEIGHT };
// The expanded row: its own line, then the details on a second grid line of their own height.
const EXPANDED_ROW_STYLE: CSSProperties = { gridTemplateRows: `${String(ROW_HEIGHT)}px auto` };
const ROW_CLASS = cn(
  ROW_COLUMNS,
  'relative whitespace-nowrap',
  'data-active:before:absolute data-active:before:top-0 data-active:before:left-0 data-active:before:h-7 data-active:before:w-1 data-active:before:bg-accent',
  'group-focus-visible:data-active:outline-2 group-focus-visible:data-active:-outline-offset-2 group-focus-visible:data-active:outline-focus',
);

/**
 * One data row: {@link ROW_HEIGHT} tall, or taller with its details open — the grid measures that
 * one row itself (see `LogGrid`). The active row is marked with an accent bar, and with a focus
 * outline while the grid has keyboard focus.
 */
export const LogRow = memo(function LogRow({
  buffer,
  position,
  index,
  id,
  active,
  expanded,
  getEvent,
  detailsRef,
}: LogRowProps) {
  const detailsId = `${id}-details`;
  return (
    <div
      role="row"
      id={id}
      // The header is row 1.
      aria-rowindex={index + 2}
      aria-expanded={expanded}
      data-index={index}
      data-active={active || undefined}
      style={expanded ? EXPANDED_ROW_STYLE : ROW_STYLE}
      className={ROW_CLASS}
    >
      <div role="gridcell" className="flex">
        <DetailsToggle expanded={expanded} controls={expanded ? detailsId : undefined} />
      </div>
      <LogCells buffer={buffer} position={position} />
      {expanded && (
        <div
          role="gridcell"
          ref={detailsRef}
          className="col-span-full -mr-3 -ml-1.5 self-stretch"
          data-details=""
        >
          <EventDetails
            key={position}
            buffer={buffer}
            position={position}
            getEvent={getEvent}
            id={detailsId}
          />
        </div>
      )}
    </div>
  );
});
