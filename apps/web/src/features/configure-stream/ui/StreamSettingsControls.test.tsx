import type { StreamLimits } from '@lsv/protocol';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type FromWorkerMessage, useLogStreamStore } from '@/entities/log-stream';
import { FakeWorker, testHello } from '@/shared/lib/testing';

import { RATE_SLIDER_STEPS, sliderPositionToRate } from '../lib/rate-scale';
import { RATE_COMMIT_DELAY_MS } from '../model/request-settings';
import { StreamSettingsControls } from './StreamSettingsControls';

const LIMITS: StreamLimits = { minRate: 10, maxRate: 5000, sessionMaxMs: 1_800_000 };
const NO_COUNTERS = { received: 0, eventsPerSecond: 0, missed: 0, dropped: 0, invalidFrames: 0 };

/** The controls on a real stream store whose worker is a fake the test answers for. */
function Harness() {
  const store = useLogStreamStore(() => ({
    endpoint: 'ws://localhost:8787/ws',
    request: {},
    capacity: 1000,
    spawnWorker: () => new FakeWorker(),
  }));
  return <StreamSettingsControls store={store} />;
}

/** Delivers a worker message and lets the store publish its next snapshot (one frame). */
function post(message: FromWorkerMessage): void {
  act(() => {
    FakeWorker.latest().receive(message);
    vi.advanceTimersByTime(16);
  });
}

function connect(limits: StreamLimits = LIMITS): void {
  const { stream, expiresAt } = testHello();
  post({ type: 'hello', session: 1, stream, limits, expiresAt });
}

/** The `configure` messages the controls sent to the worker, oldest first. */
function configures(): unknown[] {
  return FakeWorker.latest()
    .messages()
    .filter(
      (message) =>
        typeof message === 'object' &&
        message !== null &&
        'type' in message &&
        message.type === 'configure',
    );
}

function controls() {
  return {
    slider: screen.getByRole('slider', { name: 'Rate' }),
    rate: screen.getByRole('spinbutton', { name: 'Exact rate, events per second' }),
    scenario: screen.getByRole('combobox', { name: 'Scenario' }),
  };
}

function setup() {
  const user = userEvent.setup();
  const view = render(<Harness />);
  return { user, ...view };
}

/** Fakes timeouts as well (the slider's debounce); for tests that drive no user-event. */
function fakeTimeouts(): void {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame'],
  });
}

describe('StreamSettingsControls', () => {
  beforeEach(() => {
    FakeWorker.reset();
    // Animation frames only, so `post()` can let the store publish. Testing Library waits for a
    // real `setTimeout` after each user-event call, so only tests without user-event fake timeouts.
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame'] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('is disabled until the stream is connected, and again once it closes', () => {
    setup();
    const { slider, rate, scenario } = controls();
    for (const control of [slider, rate, scenario]) expect(control).toBeDisabled();

    connect();
    for (const control of [slider, rate, scenario]) expect(control).toBeEnabled();

    post({ type: 'closed', session: 1, code: 1001, reason: 'bye', counters: NO_COUNTERS });
    for (const control of [slider, rate, scenario]) expect(control).toBeDisabled();
    // The last settings stay visible.
    expect(rate).toHaveValue(200);
  });

  it("takes the rate bounds from the server's limits", () => {
    setup();
    connect({ minRate: 20, maxRate: 750, sessionMaxMs: 1000 });
    const { slider, rate } = controls();

    expect(rate).toHaveAttribute('min', '20');
    expect(rate).toHaveAttribute('max', '750');
    expect(rate).toHaveValue(200);
    expect(slider).toHaveAttribute('aria-valuetext', '200 events per second');

    fireEvent.change(slider, { target: { value: String(RATE_SLIDER_STEPS) } });
    expect(slider).toHaveAttribute('aria-valuetext', '750 events per second');
    fireEvent.change(slider, { target: { value: '0' } });
    expect(rate).toHaveValue(20);
  });

  it('clamps a typed rate above the maximum and shows the effective rate from the server', async () => {
    const { user } = setup();
    connect();
    const { rate } = controls();

    await user.clear(rate);
    await user.type(rate, '999999{Enter}');

    expect(configures()).toEqual([
      expect.objectContaining({ type: 'configure', requestId: 'cfg-1', rate: 5000 }),
    ]);
    expect(rate).toHaveValue(5000);
    expect(screen.getByText('Applying…')).toBeInTheDocument();

    post({ type: 'config', session: 1, requestId: 'cfg-1', rate: 5000, scenario: 'steady' });
    expect(screen.getByText('Effective rate: 5,000 events/s')).toBeInTheDocument();

    // Leaving the field without a change sends nothing more.
    await user.tab();
    expect(configures()).toHaveLength(1);
  });

  it('sends nothing for a rate equal to the effective one or for an empty field', async () => {
    const { user } = setup();
    connect();
    const { rate } = controls();

    await user.clear(rate);
    await user.type(rate, '200{Enter}');
    await user.clear(rate);
    await user.tab();

    expect(configures()).toEqual([]);
    expect(rate).toHaveValue(200);
  });

  it('sends one configure once the slider rests, not one per step', () => {
    fakeTimeouts();
    setup();
    connect();
    const { slider } = controls();
    const start = Number(slider.getAttribute('value'));

    // user-event has no keyboard support for range inputs; each change is one arrow key press.
    for (let step = 1; step <= 5; step++) {
      fireEvent.change(slider, { target: { value: String(start + step) } });
      act(() => {
        vi.advanceTimersByTime(RATE_COMMIT_DELAY_MS / 2);
      });
    }
    expect(configures()).toEqual([]);

    act(() => {
      vi.advanceTimersByTime(RATE_COMMIT_DELAY_MS);
    });

    const rate = sliderPositionToRate(start + 5, LIMITS);
    expect(configures()).toEqual([
      { type: 'configure', session: 1, requestId: 'cfg-1', rate, scenario: undefined },
    ]);
    expect(slider).toHaveAttribute(
      'aria-valuetext',
      `${rate.toLocaleString('en-US')} events per second`,
    );
  });

  it('changes the scenario with the native select, without reconnecting', async () => {
    const { user } = setup();
    connect();
    const { scenario } = controls();

    await user.selectOptions(scenario, 'Error burst');

    expect(configures()).toEqual([
      expect.objectContaining({ requestId: 'cfg-1', scenario: 'error-burst', rate: undefined }),
    ]);
    expect(scenario).toHaveValue('error-burst');
    post({ type: 'config', session: 1, requestId: 'cfg-1', rate: 200, scenario: 'error-burst' });
    expect(scenario).toHaveValue('error-burst');
    // One worker and one session: `start`, then the `configure`.
    expect(FakeWorker.instances).toHaveLength(1);
    expect(FakeWorker.latest().messages()).toHaveLength(2);
  });

  it('keeps showing a pending scenario after a rate commit, and sends no duplicate', async () => {
    const { user } = setup();
    connect();
    const { scenario, rate } = controls();

    await user.selectOptions(scenario, 'Error burst');
    await user.clear(rate);
    await user.type(rate, '900{Enter}');

    expect(scenario).toHaveValue('error-burst');
    expect(rate).toHaveValue(900);
    // Picking the pending scenario again changes nothing; going back to Steady is a real change.
    await user.selectOptions(scenario, 'Error burst');
    await user.selectOptions(scenario, 'Steady');
    expect(configures()).toEqual([
      expect.objectContaining({ requestId: 'cfg-1', scenario: 'error-burst' }),
      expect.objectContaining({ requestId: 'cfg-2', rate: 900, scenario: undefined }),
      expect.objectContaining({ requestId: 'cfg-3', scenario: 'steady', rate: undefined }),
    ]);
  });

  it('shows a rejected change and restores the effective settings', async () => {
    const { user } = setup();
    connect();
    const { scenario, rate } = controls();

    await user.selectOptions(scenario, 'Traffic spike');
    await user.clear(rate);
    await user.type(rate, '900{Enter}');
    // Both unanswered changes show until the server answers.
    expect(scenario).toHaveValue('traffic-spike');
    expect(rate).toHaveValue(900);
    post({
      type: 'stream-error',
      session: 1,
      code: 'bad-message',
      message: 'Invalid configure message',
    });

    expect(screen.getByText('Not applied: Invalid configure message')).toBeInTheDocument();
    expect(scenario).toHaveValue('steady');
    expect(rate).toHaveValue(200);
  });

  it('cancels a pending slider commit on unmount', () => {
    fakeTimeouts();
    const { unmount } = setup();
    connect();

    fireEvent.change(controls().slider, { target: { value: '80' } });
    unmount();

    expect(vi.getTimerCount()).toBe(0);
  });
});
