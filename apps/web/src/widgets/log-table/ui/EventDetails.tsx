import { type ReactNode, useEffect, useState } from 'react';

import { EventTime, LevelLabel } from '@/entities/log-event';
import type { LogBufferView, LogEventDetails, PayloadText } from '@/entities/log-stream';

import { truncatedNote } from '../lib/payload-note';
import { DETAILS_MAX_HEIGHT } from '../lib/table-scroll';

/** Fetches the details of the event at a position (`LogStreamStore.getEventDetails`). */
export type GetEventDetails = (position: number) => Promise<LogEventDetails | undefined>;

export const EVICTED_TEXT = 'Payload no longer available — the event was evicted from the buffer.';
export const NO_PAYLOAD_TEXT = 'This event has no payload.';

type PayloadState =
  | { readonly phase: 'loading' }
  | { readonly phase: 'loaded'; readonly payload: PayloadText }
  | { readonly phase: 'evicted' }
  | { readonly phase: 'none' };

export interface EventDetailsProps {
  readonly buffer: LogBufferView;
  readonly position: number;
  readonly getEventDetails: GetEventDetails;
  /** Element id, the target of the disclosure button's `aria-controls`. */
  readonly id: string;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-fg-muted">{label}</dt>
      <dd className="min-w-0 font-mono break-all">{children}</dd>
    </>
  );
}

/**
 * The details of the event at `position`: the full message, every field and the payload,
 * pretty-printed. The replica has every field but the payload, so they show at once; the payload
 * text comes from the worker (`getEventDetails`), which pretty-prints and cuts it there, and only
 * for an event that has one (`hasPayloadAt`). Mount one per position: the state belongs to one
 * event.
 *
 * A labelled region that scrolls inside {@link DETAILS_MAX_HEIGHT}; it is focusable so the keyboard
 * can scroll it too.
 */
export function EventDetails({ buffer, position, getEventDetails, id }: EventDetailsProps) {
  // Read once: the event at a position never changes, and the row may be evicted while open.
  const [event] = useState(() => buffer.eventAt(position));
  const hasPayload = event !== undefined && buffer.hasPayloadAt(position);
  const [payload, setPayload] = useState<PayloadState>(() => {
    if (event === undefined) return { phase: 'evicted' };
    return hasPayload ? { phase: 'loading' } : { phase: 'none' };
  });

  useEffect(() => {
    if (!hasPayload) return;
    let current = true;
    // An answer that arrives after unmounting is dropped; the store bounds what is still pending.
    void getEventDetails(position).then((details) => {
      if (!current) return;
      if (details === undefined) setPayload({ phase: 'evicted' });
      else if (details.payload === undefined) setPayload({ phase: 'none' });
      else setPayload({ phase: 'loaded', payload: details.payload });
    });
    return () => {
      current = false;
    };
  }, [getEventDetails, position, hasPayload]);

  return (
    <div
      id={id}
      role="region"
      aria-label={event === undefined ? 'Event details' : `Details of event #${String(event.seq)}`}
      // A scrollable region must be reachable by keyboard (axe `scrollable-region-focusable`).
      // eslint-disable-next-line jsx-a11y-x/no-noninteractive-tabindex -- a labelled scroll container, not a widget
      tabIndex={0}
      style={{ maxHeight: DETAILS_MAX_HEIGHT }}
      className="overflow-auto border-t border-border bg-surface px-4 py-3 font-sans text-sm whitespace-normal"
    >
      {event !== undefined && (
        <>
          <p className="font-mono break-words whitespace-pre-wrap">{event.message}</p>
          <dl className="mt-3 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1">
            <Field label="Time">
              <EventTime ts={event.ts} withDate />
            </Field>
            <Field label="Level">
              <LevelLabel level={event.level} />
            </Field>
            <Field label="Service">{event.service}</Field>
            <Field label="Host">{event.host}</Field>
            <Field label="Seq">{event.seq}</Field>
            <Field label="Trace ID">{event.traceId ?? '—'}</Field>
          </dl>
        </>
      )}
      <h3 className="mt-3 text-xs font-semibold text-fg-muted">Payload</h3>
      {payload.phase === 'loaded' ? (
        <>
          <pre className="mt-1 font-mono text-xs break-words whitespace-pre-wrap">
            {payload.payload.text}
          </pre>
          {payload.payload.truncated && (
            <p className="mt-1 text-fg-muted">{truncatedNote(payload.payload.length)}</p>
          )}
        </>
      ) : (
        <p role="status" className="mt-1 text-fg-muted">
          {payload.phase === 'loading'
            ? 'Loading payload…'
            : payload.phase === 'evicted'
              ? EVICTED_TEXT
              : NO_PAYLOAD_TEXT}
        </p>
      )}
    </div>
  );
}
