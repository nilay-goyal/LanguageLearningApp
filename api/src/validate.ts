// Checks Claude's output against each line. Anything that fails is dropped, not repaired.

import type { LineResult, RequestLine, Unit } from '../../shared/protocol';

export type Verdict = 'NATURAL' | 'ACCEPTABLE' | 'FAIL';

export interface RawUnit {
  start: number;
  end: number;
  /** The words Claude says it is replacing, to catch miscounted positions. */
  english?: string;
  text: string;
  lemmas: string[];
  verdict: Verdict;
}

export interface RawLine {
  i: number;
  units: RawUnit[];
  full: { text: string; lemmas: string[]; verdict: Verdict } | null;
}

const MAX_UNIT_WORDS = 5;

const comparable = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const isCapitalised = (word: string) => /^\p{Lu}/u.test(word);
const cleanLemmas = (lemmas: string[]) => lemmas.map((l) => l.trim().toLowerCase()).filter(Boolean);

/** Why a unit is rejected, or null if it is fine. */
export function unitProblem(unit: RawUnit, words: string[]): string | null {
  const length = unit.end - unit.start;
  if (unit.verdict === 'FAIL') return 'verdict';
  if (!Number.isInteger(unit.start) || !Number.isInteger(unit.end)) return 'not a word index';
  if (unit.start < 0 || unit.end > words.length || length < 1) return 'out of range';
  if (length > MAX_UNIT_WORDS) return 'too long';
  // Your scope rule: at most half the line, though 2 words are always allowed.
  if (length > 1 && length > Math.max(2, Math.floor(words.length / 2))) return 'too much of the line';
  if (!unit.text.trim()) return 'empty';

  const english = words.slice(unit.start, unit.end);
  if (unit.english !== undefined && comparable(unit.english) !== comparable(english.join(' '))) return 'positions do not match';
  if (comparable(unit.text) === comparable(english.join(' '))) return 'same as English';
  // Names only: every word capitalised, ignoring the line's first word.
  if (english.every((w, k) => isCapitalised(w) && !(unit.start === 0 && k === 0))) return 'name only';
  return null;
}

/** Applies the checks to Claude's lines. Lines it skipped or numbered wrongly get nothing. */
export function validateLines(raw: RawLine[], lines: RequestLine[]): { results: Record<string, LineResult>; dropped: number } {
  const results: Record<string, LineResult> = {};
  let dropped = 0;
  for (const line of lines) results[line.hash] = { units: [], full: null };

  for (const rawLine of raw) {
    const line = lines[rawLine.i];
    if (!line) {
      dropped++;
      continue;
    }
    const units: Unit[] = [];
    for (const unit of rawLine.units) {
      if (unitProblem(unit, line.words)) {
        dropped++;
        continue;
      }
      units.push({
        start: unit.start,
        end: unit.end,
        text: unit.text.trim(),
        lemmas: cleanLemmas(unit.lemmas),
        score: unit.verdict === 'NATURAL' ? 2 : 1,
      });
    }
    let full: LineResult['full'] = null;
    const rawFull = rawLine.full;
    if (rawFull) {
      const usable =
        rawFull.verdict !== 'FAIL' &&
        rawFull.text.trim() &&
        line.words.length >= 2 &&
        comparable(rawFull.text) !== comparable(line.text);
      if (usable) full = { text: rawFull.text.trim(), lemmas: cleanLemmas(rawFull.lemmas) };
      else dropped++;
    }
    results[line.hash] = { units, full };
  }
  return { results, dropped };
}
