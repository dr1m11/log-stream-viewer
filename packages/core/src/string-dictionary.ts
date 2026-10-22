/**
 * Id reserved for strings that did not fit into a full dictionary. Its label is
 * {@link DICTIONARY_OVERFLOW_LABEL}; real entries start at 1.
 */
export const DICTIONARY_OVERFLOW_ID = 0;
/** What a row shows for a service or host that arrived after its dictionary filled up. */
export const DICTIONARY_OVERFLOW_LABEL = '(other)';
/**
 * Default number of distinct strings per dictionary. A stream has a handful of services and a few
 * dozen hosts; the cap only guards against a source that invents a new name per event.
 */
export const DEFAULT_DICTIONARY_CAPACITY = 4096;
/** Ids are stored in a `Uint16Array`, and id 0 is reserved. */
const MAX_DICTIONARY_CAPACITY = 0xffff;

/**
 * Append-only interning of a low-cardinality string column (service, host) into small integer
 * ids, so a row stores two bytes instead of a pointer and the main thread receives each name once.
 * Entries are never evicted; the size cap bounds the memory instead. Two dictionaries that receive
 * the same strings in the same order assign the same ids — that is how the worker and the main
 * thread stay in sync without sending names per event.
 */
export interface StringDictionary {
  /** Distinct strings stored, the overflow label not counted. */
  readonly size: number;
  /** The id of `value`, adding it when it is new; {@link DICTIONARY_OVERFLOW_ID} once the cap is reached. */
  readonly intern: (value: string) => number;
  /** The string of an id; the overflow label for id 0 and for ids that were never assigned. */
  readonly stringOf: (id: number) => string;
  /** Forgets every entry. */
  readonly clear: () => void;
}

export function createStringDictionary(capacity: number): StringDictionary {
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > MAX_DICTIONARY_CAPACITY) {
    throw new RangeError(
      `Dictionary capacity must be an integer in [1, ${String(MAX_DICTIONARY_CAPACITY)}]`,
    );
  }
  const ids = new Map<string, number>();
  // values[id]; index 0 holds the overflow label.
  const values: string[] = [DICTIONARY_OVERFLOW_LABEL];

  return {
    get size() {
      return values.length - 1;
    },
    intern(value) {
      const known = ids.get(value);
      if (known !== undefined) return known;
      if (values.length > capacity) return DICTIONARY_OVERFLOW_ID;
      const id = values.length;
      values.push(value);
      ids.set(value, id);
      return id;
    },
    stringOf: (id) => values[id] ?? DICTIONARY_OVERFLOW_LABEL,
    clear() {
      ids.clear();
      values.length = 1;
    },
  };
}
