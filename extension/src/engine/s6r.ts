// S6r speed limit, rebuilt from "05 Documentation V2/Speed Limit Algo.md".
// For each subtitle line it decides whether L2 is shown and in which form.

import {
  CREDIT_CAP,
  DENSITY_CAP,
  DENSITY_WINDOW_LINES,
  type LanguageProfile,
  LEDGER_SIZE,
  MAX_SWITCHES_PER_LINE,
  RESERVE,
  RETAINED_AT,
  SPACING_TOKENS,
  TICK_CAP,
  TICK_WORDS,
  type Tier,
  TIERS,
  WORDS_PER_HOUR,
} from './constants';
import { nextRandom } from './rng';
import { placementHour, scheduledShares, targetDensity } from './schedule';

export interface Candidate {
  tier: Tier;
  /** First English word index in the line (non-punctuation words only). */
  start: number;
  /** One past the last English word index. For FULL this is the line's word count. */
  end: number;
  /** L2 lemmas the unit shows, in order. Proper nouns and numbers already removed. */
  lemmas: string[];
  /** Selector score for phrases; higher is better. */
  score?: number;
}

export interface EngineLine {
  id: string;
  /** Non-punctuation English words in the line. */
  words: number;
  candidates: Candidate[];
}

export interface EngineState {
  wordsParsed: number;
  credit: number;
  ticks: number;
  /** Tiers of the last LEDGER_SIZE switches, oldest first. */
  ledger: Tier[];
  /** Words and L2 words of the previous DENSITY_WINDOW_LINES - 1 lines, oldest first. */
  window: { words: number; l2: number }[];
  /** Global word index one past the end of the last partial switch. */
  lastPartialEnd: number;
  lemmaCounts: Map<string, number>;
  rng: number;
}

export interface EngineOptions {
  profile: LanguageProfile;
  /** Multiplies the target density: 0.75 gentle, 1 balanced, 1.2 immersive. */
  pace?: number;
  /** Word counts of the lines that follow, for the density-cap lookahead. */
  upcomingWords?: number[];
  /** Called when a chosen unit is blocked, for diagnostics. */
  onBlock?: (reason: 'credit' | 'ticks' | 'cap', tier: Tier) => void;
}

export function createState(startHour = 0, seed = 1): EngineState {
  return {
    wordsParsed: Math.round(startHour * WORDS_PER_HOUR),
    credit: 0,
    ticks: 0,
    ledger: [],
    window: [],
    lastPartialEnd: -Infinity,
    lemmaCounts: new Map(),
    rng: seed >>> 0,
  };
}

export function cloneState(s: EngineState): EngineState {
  return {
    ...s,
    ledger: [...s.ledger],
    window: [...s.window],
    lemmaCounts: new Map(s.lemmaCounts),
  };
}

export function hoursOf(s: EngineState): number {
  return s.wordsParsed / WORDS_PER_HOUR;
}

export function retainedCount(s: EngineState): number {
  let n = 0;
  for (const c of s.lemmaCounts.values()) if (c >= RETAINED_AT) n++;
  return n;
}

const isPartial = (t: Tier) => t !== 4;

function unitLength(c: Candidate): number {
  return c.end - c.start;
}

/** Ticks a unit would spend: one per showing of a lemma not yet retained. */
function ticksNeeded(lemmas: string[], counts: Map<string, number>): number {
  const pending = new Map<string, number>();
  let n = 0;
  for (const l of lemmas) {
    const seen = (counts.get(l) ?? 0) + (pending.get(l) ?? 0);
    if (seen < RETAINED_AT) n++;
    pending.set(l, (pending.get(l) ?? 0) + 1);
  }
  return n;
}

/**
 * Rolling density over the last 100 lines must stay at or under the cap, checked
 * for every window that will still contain this line. Unknown upcoming lines are
 * assumed to have the mean line length.
 */
function densityAllows(
  s: EngineState,
  lineWords: number,
  lineL2: number,
  upcoming: number[],
  meanWords: number,
): boolean {
  const past = s.window;
  let pastWords = 0;
  let pastL2 = 0;
  for (const p of past) {
    pastWords += p.words;
    pastL2 += p.l2;
  }
  // With a short history the first windows reach back before the stream started.
  const missing = DENSITY_WINDOW_LINES - 1 - past.length;
  let futureWords = 0;
  for (let k = 0; k < DENSITY_WINDOW_LINES; k++) {
    // Window k drops the k oldest past lines and adds k upcoming lines.
    if (k > 0) {
      const dropped = past[k - 1 - missing];
      if (dropped) {
        pastWords -= dropped.words;
        pastL2 -= dropped.l2;
      }
      futureWords += upcoming[k - 1] ?? meanWords;
    }
    const words = pastWords + lineWords + futureWords;
    if (words > 0 && (pastL2 + lineL2) / words > DENSITY_CAP) return false;
  }
  return true;
}

interface Pick {
  candidate: Candidate;
  rng: number;
}

/** Edge of the line first; then best score for phrases, a seeded draw for single words. */
function pickWithinTier(cands: [Candidate, ...Candidate[]], lineWords: number, rng: number): Pick {
  const edge = cands.filter((c) => c.start === 0 || c.end === lineWords);
  const pool = edge.length > 0 ? (edge as [Candidate, ...Candidate[]]) : cands;
  if (pool[0].tier === 1) {
    const [r, next] = nextRandom(rng);
    return { candidate: pool[Math.floor(r * pool.length)] ?? pool[0], rng: next };
  }
  let best = pool[0];
  for (const c of pool) if ((c.score ?? 0) > (best.score ?? 0)) best = c;
  return { candidate: best, rng };
}

/**
 * Runs S6r on one line, mutating the state, and returns the units to show.
 * Callers that need a preview should pass a cloned state.
 */
export function processLine(s: EngineState, line: EngineLine, opts: EngineOptions): Candidate[] {
  const { profile } = opts;
  const pace = opts.pace ?? 1;
  const h = hoursOf(s);
  const lineStart = s.wordsParsed;

  s.credit = Math.min(CREDIT_CAP, s.credit + line.words * targetDensity(h, profile) * pace);
  s.ticks = Math.min(TICK_CAP, s.ticks + line.words / TICK_WORDS);

  const shares = scheduledShares(placementHour(h, profile), profile);
  const placed: Candidate[] = [];
  let lineL2 = 0;

  for (let n = 0; n < MAX_SWITCHES_PER_LINE; n++) {
    const ledgerShare = (t: Tier) =>
      s.ledger.length === 0 ? 0 : s.ledger.filter((x) => x === t).length / s.ledger.length;
    const deficit = (t: Tier) => shares[t] - ledgerShare(t);
    const inSeason = (t: Tier) => shares[t] > 0;

    // D: largest scheduled share, ties to the longer tier.
    let D: Tier = 1;
    for (const t of TIERS) if (shares[t] >= shares[D]) D = t;
    // G: in-season tier furthest below its share (or least above), ties to the longer tier.
    let G: Tier | null = null;
    for (const t of TIERS) if (inSeason(t) && (G === null || deficit(t) >= deficit(G))) G = t;

    // Candidates per tier that don't overlap a placed unit and pass spacing.
    const available = new Map<Tier, Candidate[]>();
    for (const c of line.candidates) {
      if (placed.some((p) => c.start < p.end && p.start < c.end)) continue;
      if (isPartial(c.tier) && lineStart + c.start - s.lastPartialEnd < SPACING_TOKENS) continue;
      const list = available.get(c.tier) ?? [];
      list.push(c);
      available.set(c.tier, list);
    }
    const has = (t: Tier) => available.has(t);

    let chosen: Tier | null = null;
    const behind = TIERS.filter((t) => inSeason(t) && has(t) && deficit(t) > 0);
    if (behind.length > 0) {
      chosen = behind.reduce((a, b) => (deficit(b) >= deficit(a) ? b : a));
    } else if (has(D)) {
      chosen = D;
    } else {
      for (let t = D - 1; t >= 1 && chosen === null; t--) if (has(t as Tier)) chosen = t as Tier;
      if (chosen === null && D < 4 && has((D + 1) as Tier)) chosen = (D + 1) as Tier;
    }
    if (chosen === null) break;

    const pick = pickWithinTier(available.get(chosen) as [Candidate, ...Candidate[]], line.words, s.rng);
    const cand = pick.candidate;
    const L = unitLength(cand);
    const needTicks = ticksNeeded(cand.lemmas, s.lemmaCounts);

    const creditOk = chosen === G ? s.credit > 0 : s.credit - L >= RESERVE[G ?? chosen];
    const ticksOk = needTicks <= s.ticks;
    const capOk = densityAllows(
      s,
      line.words,
      lineL2 + L,
      opts.upcomingWords ?? [],
      profile.meanWordsPerLine,
    );
    // Blocked: show nothing more on this line and keep the credit.
    if (!creditOk || !ticksOk || !capOk) {
      opts.onBlock?.(!creditOk ? 'credit' : !ticksOk ? 'ticks' : 'cap', chosen);
      break;
    }

    s.rng = pick.rng;
    s.credit -= L;
    s.ticks -= needTicks;
    for (const l of cand.lemmas) s.lemmaCounts.set(l, (s.lemmaCounts.get(l) ?? 0) + 1);
    s.ledger.push(chosen);
    if (s.ledger.length > LEDGER_SIZE) s.ledger.shift();
    if (isPartial(chosen)) s.lastPartialEnd = lineStart + cand.end;
    lineL2 += L;
    placed.push(cand);
  }

  s.window.push({ words: line.words, l2: lineL2 });
  if (s.window.length > DENSITY_WINDOW_LINES - 1) s.window.shift();
  s.wordsParsed += line.words;
  return placed;
}
