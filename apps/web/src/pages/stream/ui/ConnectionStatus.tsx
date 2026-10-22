import {
  type ConnectionStatus as Status,
  type LogStreamSnapshot,
  type LogStreamStore,
  useLogStreamSelector,
} from '@/entities/log-stream';
import { cn } from '@/shared/lib/cn';

import { describeClose } from '../lib/describe-close';

type Tone = 'pending' | 'ok' | 'stopped';

const DOT_CLASSES: Record<Tone, string> = {
  pending: 'bg-fg-muted motion-safe:animate-pulse',
  ok: 'bg-success',
  stopped: 'bg-danger',
};

interface Presentation {
  readonly tone: Tone;
  readonly label: string;
  readonly advice?: string;
}

function present(status: Status): Presentation {
  switch (status.phase) {
    case 'connecting':
      return { tone: 'pending', label: 'Connecting…' };
    case 'connected':
      return { tone: 'ok', label: 'Connected' };
    case 'closed': {
      const { title, advice } = describeClose(status.code, status.reason, status.wasConnected);
      return { tone: 'stopped', label: `Closed: ${title}`, advice };
    }
  }
}

function selectStatus(snapshot: LogStreamSnapshot): Status {
  return snapshot.status;
}

function selectError(snapshot: LogStreamSnapshot): string | undefined {
  return snapshot.error;
}

/**
 * Connection status badge. A polite live region, so screen readers announce connection changes;
 * it re-renders only when the status changes, never for the fast counters.
 */
export function ConnectionStatus({ store }: { store: LogStreamStore }) {
  const { tone, label, advice } = present(useLogStreamSelector(store, selectStatus));
  const error = useLogStreamSelector(store, selectError);

  return (
    <p role="status" aria-live="polite" className="flex flex-wrap items-center gap-x-2 text-sm">
      <span
        aria-hidden="true"
        className={cn('size-2.5 shrink-0 rounded-full', DOT_CLASSES[tone])}
      />
      <span className="font-medium">{label}</span>
      {advice !== undefined && <span className="text-fg-muted">{advice}</span>}
      {error !== undefined && <span className="text-fg-muted">{error}</span>}
    </p>
  );
}
