import { ThemeToggle } from '@/features/toggle-theme';

import { useStreamStore } from '../model/use-stream-store';
import { ConnectionStatus } from './ConnectionStatus';
import { LatestEvent } from './LatestEvent';
import { StreamStats } from './StreamStats';

/**
 * The live stream page. It renders once: the stream store lives outside React and each block
 * subscribes to the part of the snapshot it shows.
 */
export function StreamPage() {
  const store = useStreamStore();

  return (
    <div className="flex min-h-full flex-col">
      <header className="border-b border-border bg-surface-raised">
        <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center gap-x-6 gap-y-3 px-4 py-3">
          <h1 className="text-lg font-semibold tracking-tight">Log Stream Viewer</h1>
          <ConnectionStatus store={store} />
          <div className="ml-auto">
            <ThemeToggle />
          </div>
        </div>
      </header>
      <main className="mx-auto grid w-full max-w-5xl flex-1 content-start gap-6 px-4 py-6">
        <StreamStats store={store} />
        <LatestEvent store={store} />
      </main>
    </div>
  );
}
