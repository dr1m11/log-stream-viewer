import helloFrame from '@lsv/protocol/fixtures/v1/hello.json?raw';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FakeWebSocket, testBatch } from '@/shared/lib/testing';

import { StreamPage } from './StreamPage';

function batchFrame(seqs: readonly number[], dropped?: number): string {
  return JSON.stringify({ ...testBatch(seqs), dropped });
}

function socketAt(index: number): FakeWebSocket {
  const socket = FakeWebSocket.instances[index];
  if (socket === undefined) throw new Error(`No WebSocket #${String(index)} was created`);
  return socket;
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

  it('shows a socket the browser refuses to open in the status, not as a crash', async () => {
    vi.stubGlobal(
      'WebSocket',
      vi.fn(function refuse() {
        throw new DOMException(
          'An insecure WebSocket connection may not be initiated from a page loaded over HTTPS.',
          'SecurityError',
        );
      }),
    );

    render(<StreamPage />);

    const status = screen.getByRole('status');
    expect(await within(status).findByText('Closed: Cannot open the connection')).toBeVisible();
    expect(status).toHaveTextContent('An insecure WebSocket connection may not be initiated');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('keeps one live socket through the StrictMode double mount', async () => {
    const { unmount } = render(
      <StrictMode>
        <StreamPage />
      </StrictMode>,
    );
    expect(FakeWebSocket.instances).toHaveLength(2);
    const [first, second] = [socketAt(0), socketAt(1)];

    // The first effect's cleanup closed its socket while connecting: it closes once open, and
    // whatever it still delivers does not reach the page.
    act(() => {
      first.open();
      first.receive(helloFrame);
      first.receive(batchFrame([1, 2, 3, 4, 5, 6, 7, 8, 9]));
    });
    expect(first.closedWith?.code).toBe(1000);

    act(() => {
      second.open();
      second.receive(helloFrame);
      second.receive(batchFrame([1, 2]));
    });
    await waitFor(() => {
      expect(counter('Events received')).toBe('2');
    });
    expect(screen.getByRole('status')).toHaveTextContent('Connected');
    expect(second.closedWith).toBeUndefined();

    unmount();
    expect(second.closedWith?.code).toBe(1000);
  });

  it('counts received, missed and server-dropped events and previews the newest event', async () => {
    const { socket } = await renderConnected();

    act(() => {
      socket.receive(batchFrame([1, 2, 3]));
      socket.receive(batchFrame([6, 7], 1));
    });

    await waitFor(() => {
      expect(counter('Events received')).toBe('5');
    });
    expect(counter('Missed events')).toBe('2');
    expect(counter('Dropped by server')).toBe('1');
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
