/** Outcome of an operation that can fail in an expected way (invalid input, unknown version…). */
export type Result<T, E> = Ok<T> | Err<E>;

export interface Ok<T> {
  readonly ok: true;
  readonly value: T;
}

export interface Err<E> {
  readonly ok: false;
  readonly error: E;
}

/** Wraps a successful value. */
export function ok<T>(value: T): Ok<T> {
  return { ok: true, value };
}

/** Wraps an expected failure. */
export function err<E>(error: E): Err<E> {
  return { ok: false, error };
}
