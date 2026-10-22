# 0006. Client stream pipeline

- Status: Accepted
- Date: 2026-10-22

## Context

From stage B2 the client keeps what it receives: a table of 100K rows by default and up to 1M, at 60 FPS, while the mock server pushes up to 10K+ events per second as 20 JSON frames per second ([ADR-0004](./0004-log-event-model-and-wire-protocol-v1.md)). In B1 the main thread owned the socket, parsed every frame and kept only counters and the newest event.

Forces:

- **Main-thread budget.** `JSON.parse` and validation of a 500-event frame take about 0.6 ms in Node (`pnpm bench`, `parse.bench.ts`); at 20 frames per second that is time taken from rendering and input. Search and filtering arrive in B3 and need the same events off the main thread.
- **Strings cannot be transferred.** `postMessage` can move `ArrayBuffer`s without copying, but every string and object is structured-cloned. Posting parsed `LogEvent` objects clones the whole object graph, payloads included.
- **Memory.** 1M events must fit in a tab, on the main thread as well as in a worker. Objects per row cost a header, a hidden class and a pointer per field; numbers inside them are often boxed.
- **Hidden tabs.** Browsers pause `requestAnimationFrame` in a background tab but keep delivering socket and worker messages. A buffer that only shrinks when the UI reads it grows without bound (roadmap, B2 notes).
- **Testability.** The buffer, batching and statistics must be testable without React, the DOM, a worker or a real clock (`packages/*` rules, [ADR-0001](./0001-monorepo-layout.md)).

## Decision

**The stream worker owns the socket, parsing and the authoritative buffer; the main thread keeps a replica of the columns it renders.** The engine is the framework-free package `@lsv/core`, used by both threads.

```
WebSocket ─▶ [Worker] openStreamSocket → parseServerMessage → StreamStats + EventStore(keepPayload: true)
                │  postMessage: ColumnBatch (typed arrays transferred) + counters, ≤ 20/s
                ▼
          [Main] EventStore(keepPayload: false) ← appendColumns → snapshot per rAF → useSyncExternalStore → table
                   get-event(position) ─▶ worker → full LogEvent with payload (details)
```

**Columnar ring buffer (`EventStore`).** One preallocated column per field, sized to the capacity: `seq` and `ts` in `Float64Array`, `level` as an index into `LOG_LEVELS` in a `Uint8Array`, `service` and `host` as dictionary ids in `Uint16Array`, `message` and `traceId` in preallocated arrays of strings, a `hasPayload` flag in a `Uint8Array`, and `payload` objects only in the worker's store (`keepPayload`). Appending writes into slots in index loops and allocates nothing apart from dictionary entries for new names.

**Positions.** Every appended event gets the next position, starting at 0. A store retains `[start, end)`, at most `capacity` events; a position addresses the same event for as long as it is retained, so the table, selection and the details request all use positions. Both threads append the same rows in the same order, so a position means the same event on both sides. `clear()` restarts at 0 and must be done on both sides together (a new session).

**Eviction.** Hard capacity, oldest first, **during the append**: appending past `capacity` overwrites the oldest slots and moves `start`. No reader has to drain the buffer, so a hidden tab stays bounded. When the worker evicts rows before they were sent (the main thread fell behind), the next batch starts after a gap and the main thread drops its older rows as well; both sides still agree on every retained position.

**Dictionaries.** Services and hosts are interned into append-only dictionaries with a cap (default 4096 names each); a name beyond the cap maps to a reserved id shown as `(other)`. Entries are never evicted — the cap bounds them — and each batch carries only the names added since the previous one, so both dictionaries assign the same ids.

**Column batches.** The worker encodes the rows appended since its previous batch (`takeColumnBatch`) into fresh typed arrays plus string arrays, `firstPosition`, `count` and the new dictionary names. The six typed-array buffers are transferred (`columnBatchTransferables`); only messages and trace ids are cloned. The main thread appends the batch with `appendColumns`.

**Payloads stay in the worker.** They are the largest and least-read part of an event. The table shows that a row has details (`hasPayload`); opening them asks the worker for the full `LogEvent` at a position (`get-event`, T8), which answers `undefined` once the position is evicted.

**Main ↔ worker messages.** A custom set of typed discriminated unions (no library), owned by `entities/log-stream` in `apps/web`. Every message carries a `session` number that the main thread increments on each `start`; messages of an older session are dropped, so a restart never mixes two streams. Requests that expect an answer carry a `requestId`.

**Statistics (`StreamStats`).** Received events, events per second (ten 100 ms buckets, measured from `hello` while the stream is younger than a second), `seq` gaps (`missed`), reported drops and invalid frames run in the worker and travel with each batch and on heartbeats. Time is an argument (`now`); `@lsv/core` uses no clock, timer or animation frame, which ESLint enforces.

**UI snapshot per animation frame.** The main thread appends batches as they arrive but publishes a snapshot (connection status, counters, buffer `start`/`end`) at most once per `requestAnimationFrame` through `useSyncExternalStore`. Rows are read from the store by position during render, never copied into React state.

**Capacity.** `DEFAULT_BUFFER_CAPACITY` 100,000 events, bounds `MIN_BUFFER_CAPACITY` 1,000 and `MAX_BUFFER_CAPACITY` 1,000,000; the user picks another value with `?buffer=`, clamped by `clampBufferCapacity`. Both stores get the same clamped value.

**Memory per event** (Node 24, events shaped like the mock server's: ~50-character messages, a trace id and a small payload on three in four events; measured with typed-array backing stores included):

| Store                              | Per event | 100K events | 1M events |
| ---------------------------------- | --------- | ----------- | --------- |
| Main thread (`keepPayload: false`) | ~145 B    | ~14 MB      | ~140 MB   |
| Worker (`keepPayload: true`)       | ~255 B    | ~24 MB      | ~245 MB   |

The fixed columns are 22 bytes per slot; the rest is strings (and payloads in the worker). The browser numbers for 10K / 100K / 1M rows are measured and published in B6.

**Measured cost** (`pnpm bench`, `packages/core/src/event-store.bench.ts`, Node 24 on the development machine; indicative, compare rows of one run): appending 500 parsed events takes ~0.03 ms, encoding them ~0.02 ms more, and `appendColumns` of a 500-event batch on the main thread ~0.007 ms. Append, encode and a transferring `structuredClone` of the batch take ~0.3 ms, against ~1.5 ms for a `structuredClone` of the same 500 `LogEvent` objects.

## Consequences

- The main thread no longer parses frames; per batch it copies six typed arrays and two string arrays, and per frame it reads only the visible rows.
- The table and the details view address rows by position, which stays valid until eviction; components must handle an evicted position (`eventAt` returns `undefined`, `has(position)` is false).
- Both stores must stay in lockstep: same capacity and dictionary cap, batches appended in order, `clear()` on both sides. A batch that starts before the replica's end throws, so a protocol bug surfaces at once instead of corrupting rows.
- Opening a row's details is asynchronous (a round trip to the worker).
- Strings are held twice, once per thread. That is the price of synchronous rendering on the main thread; the main store is still about 40% smaller than the worker's.
- B3 filtering and search can run in the same worker against the authoritative store; B4 reconnection stays inside the worker as well.
- The UI stores read only snapshots and the replica; tests drive the worker host with a fake port and the existing fake WebSocket, and `@lsv/core` with plain numbers for time.

## Alternatives considered

- **Comlink** (closes the open question in the product spec, §9) — RPC proxies hide that every call is an asynchronous `postMessage`, make streaming (many worker-initiated batches) awkward, need `transfer()` wrappers for transferables and add a dependency. A handful of typed messages with a `session` field is easier to test, keeps transfers explicit and lets stale messages be dropped in one place.
- **`SharedArrayBuffer` shared by both threads** — no copies at all, but it requires cross-origin isolation (COOP/COEP headers) on Cloudflare and in `vite preview`, which constrains embedding and third-party resources, and strings still cannot live in it. Concurrent writes would also need atomics or a seqlock for readers. Revisit if copying batches shows up in profiles.
- **Posting `LogEvent` arrays via structured clone** — the simplest protocol, but it clones every object and payload (about five times slower than a column batch in the benchmark above) and leaves the main thread with one object per row, the most memory-hungry layout.
- **A buffer only in the worker, with range requests from the table** — one copy of the strings, but every scroll becomes an asynchronous round trip, rows flash empty while they load, and follow-tail at 10K events per second turns into a request storm. Synchronous reads of visible rows are worth the duplicated strings.
- **Parsing on the main thread with an object ring buffer** (the B1 shape, extended) — no worker, but parsing, buffering and later filtering compete with rendering, and per-row objects cost more memory than columns.
