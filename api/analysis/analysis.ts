// Turns the study's events into the numbers the Phase 3 gates are judged on.
// Pure functions, so they can be tested on made-up data.

export interface StoredEvent {
  tester: string;
  at: number;
  kind: string;
  data: Record<string, any>;
}

const DAY_MS = 24 * 3600 * 1000;
const dayOf = (at: number) => new Date(at).toISOString().slice(0, 10);

export const median = (values: number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

export const percentile = (values: number[], q: number): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
};

/** A 95% range for a share, which behaves sensibly for small counts. */
export function wilson(successes: number, n: number): { rate: number; low: number; high: number } | null {
  if (n === 0) return null;
  const z = 1.96;
  const p = successes / n;
  const denominator = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denominator;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denominator;
  return { rate: p, low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}

export interface Engagement {
  tester: string;
  firstDay: string;
  lastDay: string;
  minutes: number;
  hoursAdvanced: number;
  /** Days with at least the threshold of use. */
  activeDays: number;
}

/** Per tester: how much they used it, and on how many days they used it for at least `minMinutes`. */
export function engagement(events: StoredEvent[], minMinutes = 20): Engagement[] {
  const byTester = new Map<string, StoredEvent[]>();
  for (const e of events) byTester.set(e.tester, [...(byTester.get(e.tester) ?? []), e]);

  return [...byTester.entries()].map(([tester, list]) => {
    const secsByDay = new Map<string, number>();
    const hours: number[] = [];
    for (const e of list) {
      if (e.kind !== 'tick') continue;
      secsByDay.set(dayOf(e.at), (secsByDay.get(dayOf(e.at)) ?? 0) + e.data.secs);
      hours.push(e.data.hour);
    }
    const days = [...list.map((e) => dayOf(e.at))].sort();
    return {
      tester,
      firstDay: days[0] ?? '',
      lastDay: days.at(-1) ?? '',
      minutes: [...secsByDay.values()].reduce((a, b) => a + b, 0) / 60,
      hoursAdvanced: hours.length ? Math.max(...hours) - Math.min(...hours) : 0,
      activeDays: [...secsByDay.values()].filter((s) => s >= minMinutes * 60).length,
    };
  });
}

export interface SpeedRow {
  bin: string;
  unitsShown: number;
  reveals: number;
  revealsPer100: number | null;
  struggles: number;
  strugglesPer100: number | null;
}

const BIN_LABELS = ['under 2 words/s', '2 to 3', '3 to 4', 'over 4'];

/** Does French on faster lines get more Hold-E presses and more pausing than French on slower ones? */
export function bySpeed(events: StoredEvent[]): SpeedRow[] {
  const shown = [0, 0, 0, 0];
  const reveals = [0, 0, 0, 0];
  const struggles = [0, 0, 0, 0];
  const bin = (wps: number) => (wps < 2 ? 0 : wps < 3 ? 1 : wps < 4 ? 2 : 3);
  for (const e of events) {
    if (e.kind === 'tick') e.data.bySpeed.forEach((n: number, i: number) => (shown[i]! += n));
    if (e.kind === 'reveal') reveals[bin(e.data.wps)]!++;
    if (e.kind === 'struggle') struggles[bin(e.data.wps)]!++;
  }
  return BIN_LABELS.map((label, i) => ({
    bin: label,
    unitsShown: shown[i]!,
    reveals: reveals[i]!,
    revealsPer100: shown[i]! > 0 ? (reveals[i]! / shown[i]!) * 100 : null,
    struggles: struggles[i]!,
    strugglesPer100: shown[i]! > 0 ? (struggles[i]! / shown[i]!) * 100 : null,
  }));
}

export interface RecallRow {
  group: string;
  items: number;
  correct: ReturnType<typeof wilson>;
  correctOrClose: ReturnType<typeof wilson>;
}

const exposureGroup = (count: number) => (count >= 25 ? '25 or more' : count >= 10 ? '10 to 24' : count >= 5 ? '5 to 9' : '1 to 4');

/** Recall of words by how many times they had been shown, against words never shown. Checks only, not baselines. */
export function recall(events: StoredEvent[], minDaysSinceLast = 0): RecallRow[] {
  const groups = new Map<string, string[]>();
  const add = (label: string, grade: string) => groups.set(label, [...(groups.get(label) ?? []), grade]);
  for (const e of events) {
    if (e.kind !== 'recall' || e.data.phase === 'baseline0' || e.data.phase === 'baseline14') continue;
    if (e.data.bucket === 'control') {
      add('never shown (control)', e.data.grade);
      continue;
    }
    if ((e.data.sinceLastDays ?? 0) < minDaysSinceLast) continue;
    add(`shown ${exposureGroup(e.data.count)} times`, e.data.grade);
  }
  const order = ['never shown (control)', 'shown 1 to 4 times', 'shown 5 to 9 times', 'shown 10 to 24 times', 'shown 25 or more times'];
  return order
    .filter((g) => groups.has(g))
    .map((group) => {
      const grades = groups.get(group)!;
      return {
        group,
        items: grades.length,
        correct: wilson(grades.filter((g) => g === 'correct').length, grades.length),
        correctOrClose: wilson(grades.filter((g) => g === 'correct' || g === 'close').length, grades.length),
      };
    });
}

/** The 20-word check on day 0 and day 14, per tester: correct out of the words asked. */
export function baselineGrowth(events: StoredEvent[]): { tester: string; day0: string; day14: string }[] {
  const tally = new Map<string, { day0: [number, number]; day14: [number, number] }>();
  for (const e of events) {
    if (e.kind !== 'recall' || (e.data.phase !== 'baseline0' && e.data.phase !== 'baseline14')) continue;
    const entry = tally.get(e.tester) ?? { day0: [0, 0], day14: [0, 0] };
    const slot = e.data.phase === 'baseline0' ? entry.day0 : entry.day14;
    slot[1]++;
    if (e.data.grade === 'correct') slot[0]++;
    tally.set(e.tester, entry);
  }
  const show = ([a, n]: [number, number]) => (n ? `${a}/${n}` : '-');
  return [...tally.entries()].map(([tester, t]) => ({ tester, day0: show(t.day0), day14: show(t.day14) }));
}

export interface Summary {
  testers: number;
  minutes: number;
  /** Share of French-bearing lines that arrived late, over all ticks. */
  lateRate: number | null;
  firstFrenchSecs: { median: number | null; p90: number | null };
  errorsPer10Hours: number | null;
  enjoyMedian: number | null;
  followedShare: number | null;
  episodesRated: number;
  unitsShown: number;
  reportsPer100Units: number | null;
}

export function summarise(events: StoredEvent[], reportCount: number): Summary {
  const ticks = events.filter((e) => e.kind === 'tick');
  const lines = ticks.reduce((n, e) => n + e.data.lines, 0);
  const late = ticks.reduce((n, e) => n + e.data.late, 0);
  const minutes = ticks.reduce((n, e) => n + e.data.secs, 0) / 60;
  const unitsShown = ticks.reduce((n, e) => n + e.data.tiers.reduce((a: number, b: number) => a + b, 0), 0);
  const firstFrench = events.filter((e) => e.kind === 'episode' && e.data.firstFrenchSecs !== null).map((e) => e.data.firstFrenchSecs as number);
  const ratings = events.filter((e) => e.kind === 'rate');
  const errors = events.filter((e) => e.kind === 'error').length;
  return {
    testers: new Set(events.map((e) => e.tester)).size,
    minutes,
    lateRate: lines > 0 ? late / lines : null,
    firstFrenchSecs: { median: median(firstFrench), p90: percentile(firstFrench, 0.9) },
    errorsPer10Hours: minutes > 0 ? (errors / (minutes / 60)) * 10 : null,
    enjoyMedian: median(ratings.map((e) => e.data.enjoy)),
    followedShare: ratings.length ? ratings.filter((e) => e.data.follow !== 'no').length / ratings.length : null,
    episodesRated: ratings.length,
    unitsShown,
    reportsPer100Units: unitsShown > 0 ? (reportCount / unitsShown) * 100 : null,
  };
}

/** Which of the Phase 3 gates the data meets so far. Reviewer quality is scored separately. */
export function gates(summary: Summary, perTester: Engagement[], recallRows: RecallRow[]) {
  const learners = perTester.length;
  const keepWatching = perTester.filter((t) => t.activeDays >= 6).length;
  const control = recallRows.find((r) => r.group === 'never shown (control)');
  const top = recallRows.find((r) => r.group === 'shown 25 or more times');
  return [
    { gate: 'Keep watching: 6+ active days for 7 of 10', result: `${keepWatching} of ${learners}`, pass: learners >= 10 ? keepWatching >= 7 : keepWatching / Math.max(1, learners) >= 0.7 },
    { gate: 'Enjoyment: median at least 4 of 5', result: summary.enjoyMedian === null ? 'no ratings' : String(summary.enjoyMedian), pass: (summary.enjoyMedian ?? 0) >= 4 },
    { gate: 'Followed it (yes or mostly): at least 85%', result: summary.followedShare === null ? 'no ratings' : `${Math.round(summary.followedShare * 100)}%`, pass: (summary.followedShare ?? 0) >= 0.85 },
    { gate: 'Recall of words shown 25+ times: at least 60%', result: top?.correct ? `${Math.round(top.correct.rate * 100)}% of ${top.items}` : 'no data', pass: (top?.correct?.rate ?? 0) >= 0.6 },
    {
      gate: 'Recall of shown words clearly above controls',
      result: top?.correct && control?.correct ? `${Math.round(top.correct.low * 100)}% (low end) against ${Math.round(control.correct.high * 100)}% (high end)` : 'no data',
      pass: !!(top?.correct && control?.correct && top.correct.low > control.correct.high),
    },
    { gate: 'First French within 60 s (median)', result: summary.firstFrenchSecs.median === null ? 'no data' : `${Math.round(summary.firstFrenchSecs.median)} s`, pass: (summary.firstFrenchSecs.median ?? Infinity) <= 60 },
    { gate: 'Late lines at most 2%', result: summary.lateRate === null ? 'no data' : `${(summary.lateRate * 100).toFixed(1)}%`, pass: (summary.lateRate ?? 1) <= 0.02 },
    { gate: 'At most 1 caption failure per 10 hours', result: summary.errorsPer10Hours === null ? 'no data' : summary.errorsPer10Hours.toFixed(2), pass: (summary.errorsPer10Hours ?? Infinity) <= 1 },
    { gate: 'Reports at most 2 per 100 units shown', result: summary.reportsPer100Units === null ? 'no data' : summary.reportsPer100Units.toFixed(2), pass: (summary.reportsPer100Units ?? Infinity) <= 2 },
  ];
}

export { DAY_MS };
