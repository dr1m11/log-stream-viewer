import type { Scenario, StreamSettings } from '@lsv/protocol';

import type {
  LogStreamStore,
  StreamSettingsChange,
  StreamSettingsRequests,
} from '@/entities/log-stream';

/**
 * How long the rate slider has to rest before its value is sent. One `configure` per settled
 * drag or burst of arrow keys keeps the client at no more than about three messages per second,
 * far below the server's limit of 20 per second (bursts of 40), which closes the socket with 1008.
 */
export const RATE_COMMIT_DELAY_MS = 300;

/** Rate and scenario the stream is heading to. */
export interface TargetSettings {
  readonly rate: number;
  readonly scenario: Scenario;
}

/**
 * The settings the stream will have once the pending change is answered: the effective ones from
 * the server (`stream`) with the pending change on top.
 */
export function targetSettings(
  stream: StreamSettings,
  { pending }: StreamSettingsRequests,
): TargetSettings {
  return {
    rate: pending?.rate ?? stream.rate,
    scenario: pending?.scenario ?? stream.scenario,
  };
}

/** The part of `wanted` that differs from `target`, or `undefined` when nothing would change. */
export function settingsChange(
  target: TargetSettings,
  wanted: StreamSettingsChange,
): StreamSettingsChange | undefined {
  const rate = wanted.rate !== undefined && wanted.rate !== target.rate ? wanted.rate : undefined;
  const scenario =
    wanted.scenario !== undefined && wanted.scenario !== target.scenario
      ? wanted.scenario
      : undefined;
  if (rate === undefined && scenario === undefined) return undefined;
  return {
    ...(rate === undefined ? {} : { rate }),
    ...(scenario === undefined ? {} : { scenario }),
  };
}

/**
 * Sends what `wanted` changes compared with the current target, read from the store at call time
 * (a debounced call must not compare against settings from an older render). Sends nothing when
 * the stream is not connected or the values are already the target.
 */
export function requestSettings(store: LogStreamStore, wanted: StreamSettingsChange): void {
  const { status, settings } = store.getSnapshot();
  if (status.phase !== 'connected') return;
  const change = settingsChange(targetSettings(status.stream, settings), wanted);
  if (change !== undefined) store.configure(change);
}
