import { StreamPage } from '@/pages/stream';
import { TooltipProvider } from '@/shared/ui/tooltip';

import { AppErrorBoundary } from './error-handling';

export function App() {
  return (
    <AppErrorBoundary>
      <TooltipProvider>
        <StreamPage />
      </TooltipProvider>
    </AppErrorBoundary>
  );
}
