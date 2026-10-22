import type { LogLevel } from '@lsv/protocol';

import { cn } from '@/shared/lib/cn';

// Every level colour keeps 4.5:1 on both surfaces in both themes (tokens.css).
const LEVEL_CLASSES: Readonly<Record<LogLevel, string>> = {
  trace: 'text-level-trace',
  debug: 'text-level-debug',
  info: 'text-level-info',
  warn: 'text-level-warn',
  error: 'text-level-error',
  fatal: 'text-level-fatal',
};

/**
 * A log level as coloured upper-case text. The colour is never the only signal: the level is
 * written out, and screen readers read the word itself (the upper case is CSS only).
 */
export function LevelLabel({ level, className }: { level: LogLevel; className?: string }) {
  return (
    <span className={cn('font-semibold uppercase', LEVEL_CLASSES[level], className)}>{level}</span>
  );
}
