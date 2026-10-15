export interface ErrorFallbackProps {
  error: unknown;
  onRetry: () => void;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error';
}

/** Full-page message shown when rendering fails. */
export function ErrorFallback({ error, onRetry }: ErrorFallbackProps) {
  return (
    <main className="mx-auto grid min-h-full max-w-xl place-content-center gap-3 p-6 text-center">
      <div role="alert" className="grid gap-3">
        <h1 className="text-2xl font-semibold">Something went wrong</h1>
        <p className="text-fg-muted">The viewer hit an unexpected error.</p>
        <pre className="overflow-auto rounded-lg border border-border bg-surface-raised p-3 text-left text-sm whitespace-pre-wrap">
          {describeError(error)}
        </pre>
      </div>
      <div>
        <button
          type="button"
          onClick={onRetry}
          className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-surface-raised hover:opacity-90"
        >
          Try again
        </button>
      </div>
    </main>
  );
}
