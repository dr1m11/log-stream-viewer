import { memo } from 'react';

import { EventTime, LevelLabel } from '@/entities/log-event';
import type { LogBufferView } from '@/entities/log-stream';
import { cn } from '@/shared/lib/cn';

import { ROW_HEIGHT } from '../lib/table-scroll';

/**
 * Column layout shared by the header row and the data rows: time, level, service, message. The
 * widths are in `ch` of the row's monospace font, so the header row must keep `font-mono` too.
 */
export const ROW_COLUMNS = 'grid grid-cols-[12ch_5ch_13ch_minmax(0,1fr)] items-center gap-x-4 px-3';

/** The number of columns, for `aria-colcount`. */
export const COLUMN_COUNT = 4;

interface CellsProps {
  readonly buffer: LogBufferView;
  readonly position: number;
}

/**
 * The cells of the event at `position`. The event at a position never changes, so this re-renders
 * only for a new buffer (session): when the rows shift (new rows, eviction) only the cells of rows
 * that just came into view render and format their timestamp.
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

export interface LogRowProps {
  readonly buffer: LogBufferView;
  /** Buffer position of the event; also the React key, so a row keeps its cells while it shifts. */
  readonly position: number;
  /** Virtual index (`position - start`), read by the virtualizer from `data-index`. */
  readonly index: number;
  /** Element id, the target of the grid's `aria-activedescendant`. */
  readonly id: string;
  /** Whether this is the grid's active row (keyboard cursor). */
  readonly active: boolean;
}

/**
 * One data row. Its height is fixed ({@link ROW_HEIGHT}) for now; an expandable row would let the
 * virtualizer measure it through `data-index`. The active row is marked with an accent bar, and with
 * a focus outline while the grid has keyboard focus.
 */
export const LogRow = memo(function LogRow({ buffer, position, index, id, active }: LogRowProps) {
  return (
    <div
      role="row"
      id={id}
      // The header is row 1.
      aria-rowindex={index + 2}
      data-index={index}
      data-active={active || undefined}
      style={{ height: ROW_HEIGHT }}
      className={cn(
        ROW_COLUMNS,
        'relative whitespace-nowrap',
        'data-active:before:absolute data-active:before:inset-y-0 data-active:before:left-0 data-active:before:w-1 data-active:before:bg-accent',
        'group-focus-visible:data-active:outline-2 group-focus-visible:data-active:-outline-offset-2 group-focus-visible:data-active:outline-focus',
      )}
    >
      <LogCells buffer={buffer} position={position} />
    </div>
  );
});
