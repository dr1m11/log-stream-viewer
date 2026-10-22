import { clampBufferCapacity, DEFAULT_BUFFER_CAPACITY } from '@lsv/core';
import { parseConnectionQuery, PROTOCOL_VERSION } from '@lsv/protocol';

import type { StreamRequest } from '@/shared/api';

/**
 * Reads the stream settings from the page URL (`/?rate=500&scenario=error-burst&seed=42`). They
 * have the names and rules of the connection query, so the protocol's own parser reads them:
 * unknown parameters are skipped and invalid values left out, so the server's defaults apply.
 */
export function readStreamRequest(search: string): StreamRequest {
  const query = search.startsWith('?') ? search.slice(1) : search;
  // The page URL carries no `v`; the client's version goes first, so a `v` in the URL is ignored.
  const parsed = parseConnectionQuery(`v=${String(PROTOCOL_VERSION)}&${query}`);
  if (!parsed.ok) return {};
  const { rate, scenario, seed } = parsed.value.params;
  return { rate, scenario, seed };
}

/**
 * Reads the buffer capacity in events from the page URL (`/?buffer=500000`), clamped to the
 * supported range (`clampBufferCapacity`). Without the parameter, or with a value that is not a
 * number, the buffer keeps `DEFAULT_BUFFER_CAPACITY` events.
 */
export function readBufferCapacity(search: string): number {
  const text = new URLSearchParams(search).get('buffer')?.trim() ?? '';
  return text === '' ? DEFAULT_BUFFER_CAPACITY : clampBufferCapacity(Number(text));
}
