import { StreamPage } from '@/pages/stream';

import { AppErrorBoundary } from './error-handling';

export function App() {
  return (
    <AppErrorBoundary>
      <StreamPage />
    </AppErrorBoundary>
  );
}
