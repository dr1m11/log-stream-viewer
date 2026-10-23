import { useLogStreamStore } from '@/entities/log-stream';
import { StreamSettingsControls } from '@/features/configure-stream';
import { PauseStreamControls } from '@/features/pause-stream';
import { ThemeToggle } from '@/features/toggle-theme';
import { STREAM_URL } from '@/shared/config';
import { LogTable } from '@/widgets/log-table';

import { readBufferCapacity, readStreamRequest } from '../lib/read-stream-request';
import { ConnectionStatus } from './ConnectionStatus';
import { StreamStats } from './StreamStats';

/** Stream settings and buffer capacity from the page URL (`?rate`, `?scenario`, `?seed`, `?buffer`). */
function streamOptionsFromUrl() {
  const { search } = window.location;
  return {
    endpoint: STREAM_URL,
    request: readStreamRequest(search),
    capacity: readBufferCapacity(search),
  };
}

/**
 * The live stream page. It renders once: the stream store lives outside React and each block
 * subscribes to the part of the snapshot it shows.
 */
export function StreamPage() {
  const store = useLogStreamStore(streamOptionsFromUrl);

  return (
    // Fills the viewport: the table takes the height left by the header and the counters and
    // scrolls inside itself, so the page does not scroll (unless the window is too short for both).
    <div className="flex h-full flex-col">
      <header className="border-b border-border bg-surface-raised">
        <div className="mx-auto flex w-full max-w-7xl flex-wrap items-center gap-x-6 gap-y-3 px-4 py-3">
          <h1 className="text-lg font-semibold tracking-tight">Log Stream Viewer</h1>
          <ConnectionStatus store={store} />
          <div className="ml-auto">
            <ThemeToggle />
          </div>
        </div>
      </header>
      <main className="mx-auto flex min-h-0 w-full max-w-7xl flex-1 flex-col gap-4 px-4 py-4">
        <StreamSettingsControls store={store} />
        <StreamStats store={store} />
        <PauseStreamControls store={store} />
        <LogTable store={store} />
      </main>
    </div>
  );
}
