import { describe, expect, it } from 'vitest';
import type { RequestLine } from '../../shared/protocol';
import { type RawUnit, unitProblem, validateLines } from './validate';

const WORDS = ['Where', 'did', 'you', 'put', 'the', 'old', 'red', 'keys', 'last', 'night'];
const unit = (start: number, end: number, text = 'les clés', verdict: RawUnit['verdict'] = 'NATURAL'): RawUnit => ({
  start,
  end,
  text,
  lemmas: ['LE', ' clé '],
  verdict,
});

describe('unitProblem', () => {
  it('accepts a good phrase', () => {
    expect(unitProblem(unit(4, 8), WORDS)).toBeNull();
  });

  it('rejects FAIL verdicts, bad ranges and empty text', () => {
    expect(unitProblem(unit(4, 8, 'x', 'FAIL'), WORDS)).toBe('verdict');
    expect(unitProblem(unit(-1, 2), WORDS)).toBe('out of range');
    expect(unitProblem(unit(8, 11), WORDS)).toBe('out of range');
    expect(unitProblem(unit(3, 3), WORDS)).toBe('out of range');
    expect(unitProblem(unit(4, 6, '  '), WORDS)).toBe('empty');
  });

  it('rejects units longer than 5 words or half the line', () => {
    expect(unitProblem(unit(0, 6), WORDS)).toBe('too long');
    expect(unitProblem(unit(0, 3), ['one', 'two', 'three', 'four'])).toBe('too much of the line');
  });

  it('always allows 2 words, even on a short line', () => {
    expect(unitProblem(unit(0, 2), ['Go', 'home'])).toBeNull();
  });

  it('rejects a unit that is the same as the English', () => {
    expect(unitProblem(unit(4, 6, 'The OLD,'), WORDS)).toBe('same as English');
  });

  it('rejects names on their own, but not a capitalised first word', () => {
    expect(unitProblem(unit(2, 4, 'x'), ['I', 'saw', 'New', 'York', 'today', 'with'])).toBe('name only');
    expect(unitProblem(unit(0, 1, 'x'), ['Thanks', 'a', 'lot'])).toBeNull();
  });
});

describe('validateLines', () => {
  const lines: RequestLine[] = [
    { hash: 'aaaaaaaa', words: WORDS, text: WORDS.join(' ') },
    { hash: 'bbbbbbbb', words: ['Okay'], text: 'Okay.' },
  ];

  it('keeps good units, drops bad ones and cleans lemmas', () => {
    const { results, dropped } = validateLines(
      [{ i: 0, units: [unit(4, 8), unit(0, 9)], full: { text: 'Où as-tu mis les clés ?', lemmas: ['où'], verdict: 'NATURAL' } }],
      lines,
    );
    expect(dropped).toBe(1);
    expect(results.aaaaaaaa!.units).toEqual([{ start: 4, end: 8, text: 'les clés', lemmas: ['le', 'clé'], score: 2 }]);
    expect(results.aaaaaaaa!.full?.text).toBe('Où as-tu mis les clés ?');
  });

  it('gives every line an entry, even when Claude skips it', () => {
    expect(validateLines([], lines).results.bbbbbbbb).toEqual({ units: [], full: null });
  });

  it('ignores wrongly numbered lines', () => {
    expect(validateLines([{ i: 9, units: [], full: null }], lines).dropped).toBe(1);
  });

  it('does not offer a full translation of a one-word line, or a failed one', () => {
    const full = { text: "D'accord.", lemmas: [], verdict: 'NATURAL' as const };
    expect(validateLines([{ i: 1, units: [], full }], lines).results.bbbbbbbb!.full).toBeNull();
    const failed = { text: 'Où ?', lemmas: [], verdict: 'FAIL' as const };
    expect(validateLines([{ i: 0, units: [], full: failed }], lines).results.aaaaaaaa!.full).toBeNull();
  });

  it('scores acceptable units below natural ones', () => {
    const { results } = validateLines([{ i: 0, units: [unit(4, 8, 'les clés', 'ACCEPTABLE')], full: null }], lines);
    expect(results.aaaaaaaa!.units[0]!.score).toBe(1);
  });
});
