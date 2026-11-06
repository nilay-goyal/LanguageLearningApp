import { describe, expect, it } from 'vitest';
import { DENSITY_CAP, FRENCH, type Tier, WORDS_PER_HOUR } from './constants';
import { nextRandom } from './rng';
import { targetDensity } from './schedule';
import { type Candidate, createState, type EngineLine, processLine, retainedCount } from './s6r';

// Synthetic stream with the documented French eligibility rates: a single-word
// candidate on about 8.9% of lines, func spans at 0.329, short spans at 0.375,
// full sentences on any line of 2+ words. Lemmas follow a Zipf-like distribution.
function* syntheticStream(seed: number): Generator<EngineLine> {
  let rng = seed;
  const rand = () => {
    const [r, next] = nextRandom(rng);
    rng = next;
    return r;
  };
  // Zipf (s = 1.1) over 8,000 lemmas: the head covers most tokens, as in subtitles.
  const cdf: number[] = [];
  let total = 0;
  for (let k = 1; k <= 8000; k++) cdf.push((total += 1 / k ** 1.1));
  const lemma = () => {
    const x = rand() * total;
    let lo = 0;
    let hi = cdf.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cdf[mid]! < x) lo = mid + 1;
      else hi = mid;
    }
    return `l${lo}`;
  };
  for (let i = 0; ; i++) {
    const words = 1 + Math.floor(rand() * 11) + (rand() < 0.12 ? 1 : 0);
    const lemmas = Array.from({ length: words }, lemma);
    const candidates: Candidate[] = [];
    const maxSpan = Math.max(2, Math.floor(0.5 * words));
    const span = (tier: Tier, start: number, len: number) =>
      candidates.push({ tier, start, end: start + len, lemmas: lemmas.slice(start, start + len), score: rand() });
    if (rand() < 0.089) span(1, Math.floor(rand() * words), 1);
    // Phrase eligibility rates are per candidate span, not per line.
    for (let len = 2; len <= Math.min(5, maxSpan); len++) {
      const rate = len <= 3 ? 0.329 : 0.375;
      for (let start = 0; start + len <= words; start++) {
        if (rand() < rate) span(len <= 3 ? 2 : 3, start, len);
      }
    }
    if (words >= 2) candidates.push({ tier: 4, start: 0, end: words, lemmas });
    yield { id: `line-${i}`, words, candidates };
  }
}

// Interval end (h) → measured RW / FUNC / SHORT / FULL shares in "Speed Limit Algo.md".
const DOCUMENTED_MIX: [number, number[]][] = [
  [10, [0.28, 0.72, 0, 0]],
  [100, [0.18, 0.69, 0.13, 0]],
  [200, [0.13, 0.57, 0.3, 0]],
  [300, [0.03, 0.48, 0.45, 0.04]],
  [400, [0, 0.24, 0.58, 0.18]],
  [500, [0, 0.08, 0.51, 0.4]],
  [600, [0, 0, 0.35, 0.65]],
];

describe('S6r placement on a synthetic stream', () => {
  it('tracks the target density, never exceeds the cap and follows the tier schedule', () => {
    const state = createState(0, 101);
    const intervals = [10, 20, 30, 50, 75, 100, 150, 200, 300, 400, 500, 600];
    const results: { to: number; target: number; density: number; mix: number[] }[] = [];

    let words = 0;
    let l2 = 0;
    let targetSum = 0;
    let mix = [0, 0, 0, 0];
    let next = 0;
    const recent: { words: number; l2: number }[] = [];
    let recentWords = 0;
    let recentL2 = 0;
    let maxRolling = 0;

    const stream = syntheticStream(7);
    // The engine sees the next 99 lines, as the extension does with chunk lookahead.
    const buffer: EngineLine[] = Array.from({ length: 100 }, () => stream.next().value as EngineLine);
    while (state.wordsParsed < 600 * WORDS_PER_HOUR) {
      const line = buffer.shift()!;
      buffer.push(stream.next().value as EngineLine);
      const h = state.wordsParsed / WORDS_PER_HOUR;
      const placed = processLine(state, line, {
        profile: FRENCH,
        upcomingWords: buffer.slice(0, 99).map((l) => l.words),
      });
      const lineL2 = placed.reduce((a, c) => a + (c.end - c.start), 0);
      for (const c of placed) mix[c.tier - 1]!++;
      words += line.words;
      l2 += lineL2;
      targetSum += targetDensity(h, FRENCH) * line.words;

      recent.push({ words: line.words, l2: lineL2 });
      recentWords += line.words;
      recentL2 += lineL2;
      if (recent.length > 100) {
        const old = recent.shift()!;
        recentWords -= old.words;
        recentL2 -= old.l2;
      }
      if (recent.length === 100) maxRolling = Math.max(maxRolling, recentL2 / recentWords);

      if (state.wordsParsed >= intervals[next]! * WORDS_PER_HOUR) {
        const total = mix.reduce((a, b) => a + b, 0) || 1;
        results.push({
          to: intervals[next]!,
          target: targetSum / words,
          density: l2 / words,
          mix: mix.map((m) => Math.round((m / total) * 100) / 100),
        });
        words = l2 = targetSum = 0;
        mix = [0, 0, 0, 0];
        next++;
      }
    }

    console.table(results.map((r) => ({ ...r, mix: r.mix.join(' / ') })));
    console.log('retained lemmas by 600 h:', retainedCount(state), 'max rolling density:', maxRolling.toFixed(4));

    expect(maxRolling).toBeLessThanOrEqual(DENSITY_CAP + 1e-9);
    // The doc reports a largest gap of 0.001 between measured and target density.
    for (const r of results) expect(Math.abs(r.density - r.target)).toBeLessThan(0.001);
    // Measured tier mix from the doc's results table (RW / FUNC / SHORT / FULL).
    for (const [to, mixDoc] of DOCUMENTED_MIX) {
      const r = results.find((x) => x.to === to)!;
      r.mix.forEach((share, i) => expect(Math.abs(share - mixDoc[i]!)).toBeLessThan(0.06));
    }
  }, 300_000);
});
