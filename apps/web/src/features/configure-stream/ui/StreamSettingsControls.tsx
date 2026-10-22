import { DEFAULT_SCENARIO, isScenario, type Scenario, SCENARIOS } from '@lsv/protocol';
import { type KeyboardEvent, useEffect, useId, useRef, useState } from 'react';

import {
  type ConnectionStatus,
  type LogStreamSnapshot,
  type LogStreamStore,
  type StreamSettingsRequests,
  useLogStreamSelector,
} from '@/entities/log-stream';
import { cn } from '@/shared/lib/cn';

import {
  clampRate,
  RATE_SLIDER_STEPS,
  rateToSliderPosition,
  sliderPositionToRate,
} from '../lib/rate-scale';
import { RATE_COMMIT_DELAY_MS, requestSettings, targetSettings } from '../model/request-settings';

type Connected = Extract<ConnectionStatus, { phase: 'connected' }>;

const NUMBER_FORMAT = new Intl.NumberFormat('en-US');

const SCENARIO_LABELS: Record<Scenario, string> = {
  steady: 'Steady',
  'error-burst': 'Error burst',
  'traffic-spike': 'Traffic spike',
};

const selectStatus = (snapshot: LogStreamSnapshot): ConnectionStatus => snapshot.status;
const selectRequests = (snapshot: LogStreamSnapshot): StreamSettingsRequests => snapshot.settings;

const FIELD_CLASSES =
  'h-8 rounded-md border border-fg-muted bg-surface-raised px-2 text-sm text-fg disabled:cursor-not-allowed disabled:opacity-50';

/** A slider position the user chose, with the rate it maps to. */
interface SliderChoice {
  readonly position: number;
  readonly rate: number;
}

/**
 * Stream settings: the rate as a logarithmic slider (`lib/rate-scale.ts`) plus a number input for
 * exact values, and the scenario as a native `<select>` (Radix Select injects `<style>`, which the
 * CSP blocks). The bounds come from the server's `hello.limits`, never from constants.
 *
 * Each commit sends at most one `configure`, and none when the value is already the target (the
 * effective settings with the pending change on top): the slider after resting for
 * {@link RATE_COMMIT_DELAY_MS}, the number input on Enter or blur (clamped to the bounds), the
 * scenario on change. The controls show the pending value until the server answers; a rejected
 * change brings back the effective settings, with the server's message below the controls.
 * Disabled unless connected; after a disconnect they keep showing the last settings.
 */
export function StreamSettingsControls({ store }: { store: LogStreamStore }) {
  const headingId = useId();
  const sliderId = useId();
  const numberId = useId();
  const scenarioId = useId();

  const status = useLogStreamSelector(store, selectStatus);
  const requests = useLogStreamSelector(store, selectRequests);

  // The last connected status, so a closed stream still shows the settings it ended with.
  const [lastConnected, setLastConnected] = useState<Connected | undefined>(undefined);
  if (status.phase === 'connected' && status !== lastConnected) setLastConnected(status);
  const shown = status.phase === 'connected' ? status : lastConnected;
  const connected = status.phase === 'connected';

  /** The slider value waiting for {@link RATE_COMMIT_DELAY_MS} before it is sent. */
  const [draftRate, setDraftRate] = useState<number | undefined>(undefined);
  const [slider, setSlider] = useState<SliderChoice | undefined>(undefined);
  /** What the user is typing into the number input, until Enter or blur commits it. */
  const [rateText, setRateText] = useState<string | undefined>(undefined);
  const commitTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(
    () => () => {
      clearTimeout(commitTimerRef.current);
    },
    [],
  );

  const target = shown === undefined ? undefined : targetSettings(shown.stream, requests);
  const rate = draftRate ?? target?.rate;
  const limits = shown?.limits;
  // Near the low end several positions round to one rate: keep the user's position while it still
  // maps to the shown rate, so the next arrow key moves on instead of snapping back.
  const position =
    rate === undefined || limits === undefined
      ? 0
      : slider?.rate === rate
        ? slider.position
        : rateToSliderPosition(rate, limits);

  function cancelSliderCommit(): void {
    clearTimeout(commitTimerRef.current);
    commitTimerRef.current = undefined;
    setDraftRate(undefined);
  }

  function changeSlider(nextPosition: number): void {
    if (limits === undefined) return;
    const nextRate = sliderPositionToRate(nextPosition, limits);
    setSlider({ position: nextPosition, rate: nextRate });
    setDraftRate(nextRate);
    setRateText(undefined);
    clearTimeout(commitTimerRef.current);
    commitTimerRef.current = setTimeout(() => {
      commitTimerRef.current = undefined;
      requestSettings(store, { rate: nextRate });
      // The store now holds the request as pending, which the controls show instead.
      setDraftRate(undefined);
    }, RATE_COMMIT_DELAY_MS);
  }

  function commitRateText(): void {
    if (rateText === undefined) return;
    setRateText(undefined);
    const typed = Number(rateText);
    if (limits === undefined || rateText.trim() === '' || !Number.isFinite(typed)) return;
    cancelSliderCommit();
    requestSettings(store, { rate: clampRate(typed, limits) });
  }

  function onRateKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'Enter') commitRateText();
    else if (event.key === 'Escape') setRateText(undefined);
  }

  function changeScenario(value: string): void {
    if (isScenario(value)) requestSettings(store, { scenario: value });
  }

  const { error, pending } = requests;
  let note = '';
  if (connected && error !== undefined) note = `Not applied: ${error.message}`;
  else if (connected && pending !== undefined) note = 'Applying…';
  else if (connected) note = `Effective rate: ${NUMBER_FORMAT.format(status.stream.rate)} events/s`;

  return (
    <section
      aria-labelledby={headingId}
      className="rounded-lg border border-border bg-surface-raised px-4 py-3"
    >
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <h2 id={headingId} className="text-sm font-semibold">
          Stream settings
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor={sliderId} className="text-sm text-fg-muted">
            Rate
          </label>
          <input
            id={sliderId}
            type="range"
            min={0}
            max={RATE_SLIDER_STEPS}
            step={1}
            value={position}
            aria-valuetext={
              rate === undefined ? undefined : `${NUMBER_FORMAT.format(rate)} events per second`
            }
            disabled={!connected}
            onChange={(event) => {
              changeSlider(event.currentTarget.valueAsNumber);
            }}
            className="h-6 w-40 cursor-pointer accent-accent disabled:cursor-not-allowed disabled:opacity-50"
          />
          <label htmlFor={numberId} className="sr-only">
            Exact rate, events per second
          </label>
          <input
            id={numberId}
            type="number"
            inputMode="numeric"
            min={limits?.minRate}
            max={limits?.maxRate}
            step={1}
            value={rateText ?? (rate === undefined ? '' : String(rate))}
            disabled={!connected}
            onChange={(event) => {
              setRateText(event.currentTarget.value);
            }}
            onBlur={commitRateText}
            onKeyDown={onRateKeyDown}
            className={cn(FIELD_CLASSES, 'w-24 font-mono tabular-nums')}
          />
          <span aria-hidden="true" className="text-sm text-fg-muted">
            events/s
          </span>
        </div>
        <div className="flex items-center gap-2">
          <label htmlFor={scenarioId} className="text-sm text-fg-muted">
            Scenario
          </label>
          <select
            id={scenarioId}
            value={target?.scenario ?? DEFAULT_SCENARIO}
            disabled={!connected}
            onChange={(event) => {
              changeScenario(event.currentTarget.value);
            }}
            className={cn(FIELD_CLASSES, 'cursor-pointer')}
          >
            {SCENARIOS.map((scenario) => (
              <option key={scenario} value={scenario}>
                {SCENARIO_LABELS[scenario]}
              </option>
            ))}
          </select>
        </div>
        {/* Changes once per commit and answer, never per slider tick, so it can be a live region. */}
        <p
          aria-live="polite"
          className={cn('text-sm', error === undefined ? 'text-fg-muted' : 'text-danger')}
        >
          {note}
        </p>
      </div>
    </section>
  );
}
