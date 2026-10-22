/**
 * Rows of an {@link EventStore} in columns, as the stream worker posts them to the main thread
 * (docs/adr/0006). Numbers travel in typed arrays whose buffers are transferred, not copied;
 * strings cannot be transferred and are structured-cloned. Payloads stay in the worker; the main
 * thread only learns whether a row has one.
 *
 * Every column holds `count` entries for the positions `firstPosition … firstPosition + count - 1`.
 *
 * @see EventStore.takeColumnBatch, EventStore.appendColumns
 */
export interface ColumnBatch {
  /** Store position of the first row. */
  readonly firstPosition: number;
  /** Number of rows. */
  readonly count: number;
  readonly seq: Float64Array<ArrayBuffer>;
  readonly ts: Float64Array<ArrayBuffer>;
  /** Index into `LOG_LEVELS`. */
  readonly level: Uint8Array<ArrayBuffer>;
  /** Dictionary id of the service (`DICTIONARY_OVERFLOW_ID` for overflow). */
  readonly service: Uint16Array<ArrayBuffer>;
  /** Dictionary id of the host. */
  readonly host: Uint16Array<ArrayBuffer>;
  readonly message: readonly string[];
  readonly traceId: readonly (string | undefined)[];
  /** 1 when the event carries a payload (kept by the worker, fetched on demand), else 0. */
  readonly hasPayload: Uint8Array<ArrayBuffer>;
  /**
   * Services the source dictionary added since the previous batch, in id order. The receiver adds
   * them before reading `service`, so both dictionaries assign the same ids.
   */
  readonly newServices: readonly string[];
  /** Hosts added since the previous batch, in id order. */
  readonly newHosts: readonly string[];
}

/** The buffers to list as transferables when posting `batch`; they are detached afterwards. */
export function columnBatchTransferables(batch: ColumnBatch): ArrayBuffer[] {
  return [
    batch.seq.buffer,
    batch.ts.buffer,
    batch.level.buffer,
    batch.service.buffer,
    batch.host.buffer,
    batch.hasPayload.buffer,
  ];
}
