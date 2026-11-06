import { describe, expect, it } from 'vitest';
import { baselineGrowth, bySpeed, engagement, gates, median, percentile, recall, summarise, type StoredEvent, wilson } from './analysis';

const DAY = 24 * 3600 * 1000;
const t0 = Date.UTC(2026, 10, 10, 12);
const ev = (tester: string, kind: string, data: Record<string, unknown>, at = t0): StoredEvent => ({ tester, at, kind, data });
const tick = (tester: string, at: number, over: Record<string, unknown> = {}) =>
  ev(tester, 'tick', { secs: 60, words: 150, l2Words: 10, lines: 25, linesFrench: 5, late: 0, tiers: [2, 2, 1, 0], bySpeed: [1, 2, 1, 1], hour: 5, pace: '90to120', build: 'v', ...over }, at);

describe('statistics helpers', () => {
  it('finds medians and percentiles', () => {
    expect(median([])).toBeNull();
    expect(median([5, 1, 3])).toBe(3);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)).toBe(10);
  });

  it('gives a sensible range for small samples', () => {
    expect(wilson(0, 0)).toBeNull();
    const range = wilson(8, 10)!;
    expect(range.rate).toBe(0.8);
    expect(range.low).toBeGreaterThan(0.4);
    expect(range.high).toBeLessThan(1);
    expect(wilson(10, 10)!.high).toBe(1);
  });
});

describe('engagement', () => {
  it('counts only days with enough use, and adds up minutes', () => {
    const events = [
      ...Array.from({ length: 25 }, (_, i) => tick('a', t0 + (i % 2) * 0)), // 25 minutes on day 0
      ...Array.from({ length: 5 }, () => tick('a', t0 + DAY)), // 5 minutes on day 1
      ...Array.from({ length: 30 }, () => tick('a', t0 + 2 * DAY)),
      tick('b', t0),
    ];
    const [a, b] = engagement(events);
    expect(a!.minutes).toBe(60);
    expect(a!.activeDays).toBe(2);
    expect(b!.activeDays).toBe(0);
  });
});

describe('speed analysis', () => {
  it('divides presses by the French shown at that speed', () => {
    const events = [
      tick('a', t0, { bySpeed: [10, 10, 10, 10] }),
      ev('a', 'reveal', { tier: 2, hour: 5, wps: 1.5, ms: 500 }),
      ev('a', 'reveal', { tier: 2, hour: 5, wps: 4.5, ms: 500 }),
      ev('a', 'reveal', { tier: 3, hour: 5, wps: 4.2, ms: 500 }),
      ev('a', 'struggle', { type: 'pause', tier: 1, hour: 5, wps: 3.5 }),
    ];
    const rows = bySpeed(events);
    expect(rows.map((r) => r.reveals)).toEqual([1, 0, 0, 2]);
    expect(rows[3]!.revealsPer100).toBe(20);
    expect(rows[0]!.revealsPer100).toBe(10);
    expect(rows[2]!.strugglesPer100).toBe(10);
  });

  it('reports no rate where nothing was shown', () => {
    expect(bySpeed([])[0]!.revealsPer100).toBeNull();
  });
});

describe('recall', () => {
  const item = (grade: string, bucket: string, count: number, sinceLast = 3, phase = 'check') =>
    ev('a', 'recall', { phase, n: 1, bucket, count, sinceLastDays: sinceLast, sinceFirstDays: 9, grade, ms: 3000 });

  it('groups by times shown, keeps controls apart, and ignores baselines', () => {
    const events = [
      item('correct', '25+', 30), item('correct', '25+', 26), item('wrong', '25+', 40),
      item('wrong', 'control', 0), item('wrong', 'control', 0), item('correct', 'control', 0),
      item('close', '10-24', 12),
      item('correct', 'baseline', 0, 0, 'baseline0'),
    ];
    const rows = recall(events);
    expect(rows.map((r) => r.group)).toEqual(['never shown (control)', 'shown 10 to 24 times', 'shown 25 or more times']);
    expect(rows[2]!.items).toBe(3);
    expect(rows[2]!.correct!.rate).toBeCloseTo(2 / 3);
    expect(rows[0]!.correct!.rate).toBeCloseTo(1 / 3);
    expect(rows[1]!.correctOrClose!.rate).toBe(1);
  });

  it('can limit to words tested some days after they were last shown', () => {
    const events = [item('correct', '25+', 30, 1), item('wrong', '25+', 30, 4)];
    expect(recall(events, 3)[0]!.items).toBe(1);
  });

  it('compares day 0 with day 14 per tester', () => {
    const base = (phase: string, grade: string) => ev('a', 'recall', { phase, n: 0, bucket: 'baseline', count: 0, sinceLastDays: null, sinceFirstDays: null, grade, ms: 1 });
    const rows = baselineGrowth([base('baseline0', 'correct'), base('baseline0', 'wrong'), base('baseline14', 'correct'), base('baseline14', 'correct')]);
    expect(rows).toEqual([{ tester: 'a', day0: '1/2', day14: '2/2' }]);
  });
});

describe('summary and gates', () => {
  it('works out late lines, first French, errors and reports', () => {
    const events = [
      tick('a', t0, { secs: 3600, lines: 1000, late: 10, tiers: [30, 30, 20, 20] }),
      ev('a', 'episode', { firstFrenchSecs: 40, lines: 100, lateLines: 1, restarts: 0, refetches: 0, minutes: 40, length: 'mid', pace: '90to120' }),
      ev('a', 'episode', { firstFrenchSecs: 80, lines: 100, lateLines: 1, restarts: 0, refetches: 0, minutes: 40, length: 'mid', pace: '90to120' }),
      ev('a', 'error', { message: 'x', build: 'v' }),
      ev('a', 'rate', { enjoy: 5, follow: 'yes' }),
      ev('a', 'rate', { enjoy: 4, follow: 'mostly' }),
      ev('a', 'rate', { enjoy: 2, follow: 'no' }),
    ];
    const s = summarise(events, 2);
    expect(s.lateRate).toBeCloseTo(0.01);
    expect(s.firstFrenchSecs.median).toBe(60);
    expect(s.errorsPer10Hours).toBe(10);
    expect(s.enjoyMedian).toBe(4);
    expect(s.followedShare).toBeCloseTo(2 / 3);
    expect(s.unitsShown).toBe(100);
    expect(s.reportsPer100Units).toBe(2);
  });

  it('marks gates as passed or not, and says when there is no data', () => {
    const empty = gates(summarise([], 0), [], []);
    expect(empty.every((g) => !g.pass)).toBe(true);
    expect(empty.some((g) => g.result === 'no data')).toBe(true);

    const events = [
      ...Array.from({ length: 30 }, (_, i) => tick('a', t0 + (i % 6) * DAY)),
      ev('a', 'rate', { enjoy: 5, follow: 'yes' }),
    ];
    const per = engagement(events);
    const result = gates(summarise(events, 0), per, []);
    expect(result.find((g) => g.gate.startsWith('Enjoyment'))!.pass).toBe(true);
  });
});
