import { describe, expect, it } from 'vitest';

import {
  createStringDictionary,
  DICTIONARY_OVERFLOW_ID,
  DICTIONARY_OVERFLOW_LABEL,
} from './string-dictionary.ts';

describe('createStringDictionary', () => {
  it('assigns ids from 1 in order of first appearance and reuses them', () => {
    const dictionary = createStringDictionary(8);

    expect(dictionary.intern('orders')).toBe(1);
    expect(dictionary.intern('payments')).toBe(2);
    expect(dictionary.intern('orders')).toBe(1);

    expect(dictionary.size).toBe(2);
    expect(dictionary.stringOf(1)).toBe('orders');
    expect(dictionary.stringOf(2)).toBe('payments');
  });

  it('maps new strings to the overflow id once the cap is reached, and keeps known ones', () => {
    const dictionary = createStringDictionary(2);
    dictionary.intern('a');
    dictionary.intern('b');

    expect(dictionary.intern('c')).toBe(DICTIONARY_OVERFLOW_ID);
    expect(dictionary.intern('b')).toBe(2);
    expect(dictionary.size).toBe(2);
  });

  it('labels the overflow id and unknown ids', () => {
    const dictionary = createStringDictionary(2);

    expect(dictionary.stringOf(DICTIONARY_OVERFLOW_ID)).toBe(DICTIONARY_OVERFLOW_LABEL);
    expect(dictionary.stringOf(7)).toBe(DICTIONARY_OVERFLOW_LABEL);
  });

  it('assigns the same ids in two dictionaries fed the same strings', () => {
    const source = createStringDictionary(4);
    const replica = createStringDictionary(4);
    const names = ['auth', 'search', 'auth', 'orders', 'billing', 'mail'];

    const sourceIds = names.map((name) => source.intern(name));
    const replicaIds = names.map((name) => replica.intern(name));

    expect(replicaIds).toEqual(sourceIds);
  });

  it('forgets every entry on clear', () => {
    const dictionary = createStringDictionary(2);
    dictionary.intern('a');
    dictionary.intern('b');

    dictionary.clear();

    expect(dictionary.size).toBe(0);
    expect(dictionary.intern('c')).toBe(1);
  });

  it('rejects a capacity that does not fit into 16-bit ids', () => {
    expect(() => createStringDictionary(0)).toThrow(RangeError);
    expect(() => createStringDictionary(0x10000)).toThrow(RangeError);
    expect(() => createStringDictionary(1.5)).toThrow(RangeError);
  });
});
