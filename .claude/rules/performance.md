---
paths:
  - 'apps/web/src/**'
  - 'packages/**'
---

# Performance on the hot path

The stream delivers up to 10K+ events per second; the table holds 100K–1M rows at 60 FPS.

- **Outside React.** Incoming events go into a bounded columnar ring buffer (`EventStore` from `@lsv/core`, docs/adr/0006) that evicts on append. React subscribes with `useSyncExternalStore` to a snapshot that changes at most once per animation frame (`requestAnimationFrame` batching), never per event or per batch.
- **Bounded memory.** Every buffer, queue and index has a size limit and a documented eviction policy. Counters and stats are numbers, not arrays.
- **Off the main thread.** Filtering, substring/regex search and indexing run in a Web Worker. Send batches, not single events; pass large arrays as transferables; cancel stale queries.
- **No allocations in hot loops.** Avoid per-event closures, spread copies, `Array.prototype` chains and temporary objects in code that runs per event; prefer index loops and preallocated storage.
- **Table rows.** Fixed row height for virtualization; row components are memoized and read their data by index; only an expanded row is measured.
- **Parsing.** Use the cheap guards from `@lsv/protocol`; never deep-validate payloads per event.
- **Cleanup.** Sockets, workers, timers, rAF callbacks and listeners are released in effect cleanups or `dispose()`; tests check that nothing keeps running after unmount.
- **Measure.** State the expected effect, measure before and after (FPS, INP, heap — `perf-bench` from B2, chrome-devtools MCP traces) and put numbers in the PR description.
