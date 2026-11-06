// Builds the displayed text of a line from the units S6r chose for it.

import type { Candidate } from '../engine/s6r';
import type { Run } from '../subtitles/ttml';
import type { Line } from './lines';

/** Capitalisation from your display rule: all-caps stays all-caps, a capitalised line start stays capitalised. */
function matchCase(french: string, english: string, atLineStart: boolean): string {
  const letters = english.replace(/[^\p{L}]/gu, '');
  if (letters.length > 1 && letters === letters.toLocaleUpperCase('fr')) return french.toLocaleUpperCase('fr');
  if (atLineStart && /^\p{Lu}/u.test(english)) return french.charAt(0).toLocaleUpperCase('fr') + french.slice(1);
  return french;
}

export function hybridRuns(line: Line, placed: Candidate[]): Run[] {
  const prefix = line.dash ? '- ' : '';
  const full = placed.find((c) => c.tier === 4);
  // A full French sentence isn't tinted: there's no English left to tell it apart from.
  if (full) return [{ text: prefix + (full.text ?? line.text) }];

  const runs: Run[] = [];
  let at = 0;
  for (const unit of [...placed].sort((a, b) => a.start - b.start)) {
    const first = line.tokens[unit.start];
    const last = line.tokens[unit.end - 1];
    if (!first || !last || first.start < at) continue;
    if (first.start > at) runs.push({ text: line.text.slice(at, first.start) });
    const english = line.text.slice(first.start, last.end);
    runs.push({ text: matchCase(unit.text ?? english, english, first.start === 0), l2: true });
    at = last.end;
  }
  if (at < line.text.length) runs.push({ text: line.text.slice(at) });
  if (prefix) runs.unshift({ text: prefix });
  return runs;
}
