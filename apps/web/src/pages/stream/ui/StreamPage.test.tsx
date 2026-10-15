import helloFrame from '@lsv/protocol/fixtures/v1/hello.json?raw';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FakeWebSocket, testBatch } from '@/shared/lib/testing';

import { StreamPage } from './StreamPage';

function batchFrame(seqs: readonly number[]): string {
  return JSON.stringify(testBatch(seqs));
}

/** Renders the page and opens its (fake) socket with the server's `hello`. */
async function renderConnected() {
  const view = render(<StreamPage />);
  const socket = FakeWebSocket.latest();
  act(() => {
    socket.open();
    socket.receive(helloFrame);
  });
  await screen.findByText('Connected');
  return { ...view, socket };
}

/** The number shown by the counter named `name`. */
function counter(name: string): string | null {
  return within(screen.getByRole('group', { name })).getByText(/^[\d,]+$/).textContent;
}

describe('StreamPage', () => {
  beforeEach(() => {
    FakeWebSocket.reset();
    vi.stubGlobal('WebSocket', FakeWebSocket);
    window.history.replaceState(null, '', '/');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('connects with protocol v1 and the stream settings from the page URL', () => {
    window.history.replaceState(null, '', '/?rate=500&scenario=error-burst&seed=7&utm_source=x');

    render(<StreamPage />);

    expect(FakeWebSocket.latest().url).toBe(
      'ws://localhost:8787/ws?v=1&rate=500&scenario=error-burst&seed=7',
    );
  });

  it('announces the connection status from connecting to connected', async () => {
    render(<StreamPage />);
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('Connecting…');

    const socket = FakeWebSocket.latest();
    act(() => {
      socket.open();
      socket.receive(helloFrame);
    });

    expect(await within(status).findByText('Connected')).toBeInTheDocument();
    expect(
      screen.getByText(/Scenario steady at 200 events\/s, seed 42/, { exact: false }),
    ).toBeInTheDocument();
  });

  it('explains why the stream closed', async () => {
    const { socket } = await renderConnected();

    act(() => {
      socket.closeFromServer(4029, 'busy; retry-after=30');
    });

    const status = screen.getByRole('status');
    expect(await within(status).findByText('Closed: Server busy')).toBeInTheDocument();
    expect(status).toHaveTextContent('Reload the page to retry after 30 s.');
  });

  it('counts received and missed events and previews the newest event', async () => {
    const { socket } = await renderConnected();

    act(() => {
      socket.receive(batchFrame([1, 2, 3]));
      socket.receive(batchFrame([6, 7]));
    });

    await waitFor(() => {
      expect(counter('Events received')).toBe('5');
    });
    expect(counter('Missed events')).toBe('2');
    expect(counter('Invalid frames')).toBe('0');
    expect(Number(counter('Events per second'))).toBeGreaterThan(0);
    const latest = screen.getByRole('region', { name: 'Latest event' });
    expect(await within(latest).findByText('event 7')).toBeInTheDocument();
    expect(within(latest).getByText('orders')).toBeInTheDocument();
    expect(within(latest).getByText('info')).toBeInTheDocument();
  });

  it('counts frames it cannot parse without dropping the connection', async () => {
    const { socket } = await renderConnected();

    act(() => {
      socket.receive('not json');
    });

    await waitFor(() => {
      expect(counter('Invalid frames')).toBe('1');
    });
    expect(screen.getByRole('status')).toHaveTextContent('Connected');
    expect(socket.closedWith).toBeUndefined();
  });

  it('closes the socket when the page unmounts', async () => {
    const { socket, unmount } = await renderConnected();

    unmount();

    expect(socket.closedWith?.code).toBe(1000);
  });

  it('switches the colour theme from the header', async () => {
    const user = userEvent.setup();
    render(<StreamPage />);

    await user.click(screen.getByRole('radio', { name: 'Dark' }));

    expect(screen.getByRole('radio', { name: 'Dark' })).toBeChecked();
    expect(document.documentElement.dataset.theme).toBe('dark');
  });
});
