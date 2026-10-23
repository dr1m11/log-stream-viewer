import type { JsonValue } from '@lsv/protocol';

/**
 * Longest pretty-printed payload the worker sends to the details view, in characters (64 KiB of
 * ASCII). Rendering a `<pre>` costs layout per character on the main thread; beyond this the
 * text is cut, and the details say so.
 */
export const MAX_PAYLOAD_TEXT_LENGTH = 64 * 1024;

/** An event's payload as the details view shows it. */
export interface PayloadText {
  /** `JSON.stringify(payload, null, 2)`, cut after `MAX_PAYLOAD_TEXT_LENGTH` characters. */
  readonly text: string;
  /** Whether `text` was cut. */
  readonly truncated: boolean;
  /** Length of the whole pretty-printed payload in characters. */
  readonly length: number;
}

/**
 * Pretty-prints a payload (in the worker, off the main thread) and cuts it at `maxLength`. The cut
 * never splits a surrogate pair (an emoji, say): it then falls one character earlier, so the text
 * never ends in a lone high surrogate.
 */
export function formatPayload(
  payload: JsonValue,
  maxLength: number = MAX_PAYLOAD_TEXT_LENGTH,
): PayloadText {
  const full = JSON.stringify(payload, null, 2);
  if (full.length <= maxLength) return { text: full, truncated: false, length: full.length };
  const last = full.charCodeAt(maxLength - 1);
  const cut = last >= 0xd800 && last <= 0xdbff ? maxLength - 1 : maxLength;
  return { text: full.slice(0, cut), truncated: true, length: full.length };
}
