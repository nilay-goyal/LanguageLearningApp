// Connects an episode's lines to the translator and to S6r.
//
// S6r plans ahead of the playhead, but a line only changes the learner's state once
// it has really played. A line with no translation in time simply stays English, and
// a line already on screen never changes.

import type { LineResult, TranslateRequest, TranslateResponse } from '../../../shared/protocol';
import { FRENCH, type Tier, WORDS_PER_HOUR } from '../engine/constants';
import { targetDensity } from '../engine/schedule';
import { type Candidate, cloneState, createState, type EngineLine, type EngineState, hoursOf, processLine, retainedCount } from '../engine/s6r';
import type { Cue, Run } from '../subtitles/ttml';
import { hybridRuns } from './hybrid';
import { cueKeyOf, type Line } from './lines';

export type TranslateOutcome =
  | { ok: true; response: TranslateResponse }
  | { ok: false; reason: 'over_budget' | 'unconfigured' | 'failed' };

export interface SessionDeps {
  translate(request: TranslateRequest): Promise<TranslateOutcome>;
  save(state: EngineState): void;
}

/** Lines per request. The first is small, so French starts soon after an episode does. */
const BATCH_LINES = 40;
const FIRST_BATCH_LINES = 10;
/** How many lines S6r plans past the playhead. */
const PLAN_AHEAD_LINES = 80;
const LOOKAHEAD_LINES = 99;
/** A bigger jump in playback position than this counts as a seek. */
const SEEK_SECONDS = 2.5;
const MAX_ATTEMPTS = 3;
const RETRY_MS = 5000;
const SAVE_EVERY_LINES = 10;
const GLOSSARY_SIZE = 80;
const GLOSSARY_MAX_WORDS = 3;

interface Planned {
  placed: Candidate[];
  after: EngineState;
}

export function tierForLength(length: number): Tier | null {
  if (length === 1) return 1;
  if (length <= 3) return 2;
  if (length <= 5) return 3;
  return null;
}

export function toEngineLine(line: Line, result: LineResult | undefined): EngineLine {
  const candidates: Candidate[] = [];
  for (const unit of result?.units ?? []) {
    const tier = tierForLength(unit.end - unit.start);
    if (tier) candidates.push({ tier, start: unit.start, end: unit.end, lemmas: unit.lemmas, score: unit.score, text: unit.text });
  }
  if (result?.full && line.words.length >= 2) {
    candidates.push({ tier: 4, start: 0, end: line.words.length, lemmas: result.full.lemmas, text: result.full.text });
  }
  return { id: line.id, words: line.words.length, candidates };
}

export class LearningSession {
  private lines: Line[] = [];
  private byCue = new Map<string, Line[]>();
  private indexOf = new Map<string, number>();
  private videoId = '';

  private results = new Map<string, LineResult>();
  private attempts = new Map<string, number>();
  private glossary: Record<string, string> = {};
  private inFlight = false;
  private retryAt = 0;
  private stopped: 'over_budget' | 'unconfigured' | null = null;

  private state: EngineState;
  private planState: EngineState;
  private planned = new Map<number, Planned>();
  private shown = new Map<string, Candidate[]>();
  /** The first line that hasn't played yet, and the next line to plan. */
  private frontier = 0;
  private planIndex = 0;
  private lastT = 0;
  private unsaved = 0;
  private costUsd = 0;
  private cachedLines = 0;
  private requests = 0;

  pace = 1;
  relaxTicks = false;

  constructor(private deps: SessionDeps, initial?: EngineState) {
    this.state = initial ?? createState();
    this.planState = cloneState(this.state);
  }

  setEpisode(videoId: string): void {
    if (videoId === this.videoId) return;
    this.videoId = videoId;
    this.results.clear();
    this.attempts.clear();
    this.requests = 0;
    this.glossary = {};
    this.shown.clear();
    this.setLines([], 0);
  }

  /** Call when cue times or the file change. Translations are kept, since they go by line text. */
  setLines(lines: Line[], t: number): void {
    this.flush();
    this.lines = lines;
    this.byCue.clear();
    this.indexOf.clear();
    lines.forEach((line, i) => {
      this.indexOf.set(line.id, i);
      const group = this.byCue.get(line.cueKey);
      if (group) group.push(line);
      else this.byCue.set(line.cueKey, [line]);
    });
    this.restartPlan(this.firstLineAfter(t));
    this.lastT = t;
  }

  /** Moves the learner, from the dev panel. */
  jump(hour: number, reset: boolean, t: number): void {
    const next = createState(hour);
    if (!reset) next.lemmaCounts = this.state.lemmaCounts;
    this.state = next;
    this.shown.clear();
    this.deps.save(this.state);
    this.restartPlan(this.firstLineAfter(t));
  }

  /** Plan again from `index` with the settled state, forgetting what was planned from there. */
  private restartPlan(index: number): void {
    this.frontier = index;
    this.planIndex = index;
    this.planned.clear();
    this.planState = cloneState(this.state);
  }

  private firstLineAfter(t: number): number {
    let lo = 0;
    let hi = this.lines.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.lines[mid]!.end <= t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  private isReady(line: Line): boolean {
    return this.results.has(line.hash) || this.stopped !== null || (this.attempts.get(line.hash) ?? 0) >= MAX_ATTEMPTS;
  }

  private planLine(index: number, result: LineResult | undefined): void {
    const line = this.lines[index]!;
    const upcomingWords = this.lines.slice(index + 1, index + 1 + LOOKAHEAD_LINES).map((l) => l.words.length);
    const placed = processLine(this.planState, toEngineLine(line, result), {
      profile: FRENCH,
      pace: this.pace,
      upcomingWords,
      ignoreTicks: this.relaxTicks,
    });
    this.planned.set(index, { placed, after: cloneState(this.planState) });
    this.planIndex = index + 1;
  }

  private planAhead(t: number): void {
    const limit = Math.min(this.lines.length, this.frontier + PLAN_AHEAD_LINES);
    while (this.planIndex < limit) {
      const line = this.lines[this.planIndex]!;
      // A line already on screen stays as it is, even if its translation just arrived.
      if (line.begin <= t) this.planLine(this.planIndex, undefined);
      else if (this.isReady(line)) this.planLine(this.planIndex, this.results.get(line.hash));
      else return;
    }
  }

  private commitPlayed(t: number): void {
    while (this.frontier < this.lines.length && this.lines[this.frontier]!.end <= t) {
      if (this.planIndex === this.frontier) this.planLine(this.frontier, undefined);
      const plan = this.planned.get(this.frontier);
      if (!plan) return;
      this.state = plan.after;
      this.shown.set(this.lines[this.frontier]!.id, plan.placed);
      this.planned.delete(this.frontier);
      this.frontier++;
      if (++this.unsaved >= SAVE_EVERY_LINES) this.flush();
    }
  }

  flush(): void {
    if (this.unsaved === 0) return;
    this.unsaved = 0;
    this.deps.save(this.state);
  }

  /** Advances everything for the current playback position. */
  tick(t: number, counting: boolean, now = performance.now()): void {
    if (this.lines.length === 0) return;
    if (Math.abs(t - this.lastT) > SEEK_SECONDS) {
      const target = this.firstLineAfter(t);
      // Replaying what already played changes nothing. Skipping ahead drops the plan,
      // because the lines it assumed would be seen never were.
      if (target > this.frontier) this.restartPlan(target);
    }
    this.lastT = t;

    if (counting) this.commitPlayed(t);
    this.planAhead(t);
    this.pump(t, now);
  }

  /** Requests the next lines without a translation, starting at the playhead. */
  private pump(t: number, now: number): void {
    if (this.inFlight || this.stopped || now < this.retryAt) return;
    const start = this.firstLineAfter(t);
    const batch = this.nextBatch(start, this.requests === 0 ? FIRST_BATCH_LINES : BATCH_LINES);
    if (batch.length === 0) return;

    const request: TranslateRequest = {
      videoId: this.videoId,
      lang: 'fr',
      glossary: this.glossary,
      lines: batch.map((i) => {
        const line = this.lines[i]!;
        const prev = this.lines[i - 1]?.text;
        const next = this.lines[i + 1]?.text;
        return { hash: line.hash, words: line.words, text: line.text, ...(prev ? { prev } : {}), ...(next ? { next } : {}) };
      }),
    };

    this.inFlight = true;
    this.requests++;
    void this.deps.translate(request).then((outcome) => {
      this.inFlight = false;
      if (outcome.ok) {
        this.accept(outcome.response, batch);
        return;
      }
      if (outcome.reason === 'failed') {
        this.retryAt = performance.now() + RETRY_MS;
        for (const i of batch) {
          const hash = this.lines[i]?.hash;
          if (hash) this.attempts.set(hash, (this.attempts.get(hash) ?? 0) + 1);
        }
      } else {
        this.stopped = outcome.reason;
      }
    });
  }

  private nextBatch(start: number, size: number): number[] {
    const batch: number[] = [];
    const seen = new Set<string>();
    const consider = (i: number) => {
      const line = this.lines[i]!;
      if (this.isReady(line) || seen.has(line.hash)) return;
      seen.add(line.hash);
      batch.push(i);
    };
    for (let i = start; i < this.lines.length && batch.length < size; i++) consider(i);
    // Then whatever is behind the playhead, for skipping back.
    for (let i = 0; i < start && batch.length < size; i++) consider(i);
    return batch;
  }

  private accept(response: TranslateResponse, batch: number[]): void {
    this.costUsd += response.stats.costUsd;
    this.cachedLines += response.stats.cached;
    for (const i of batch) {
      const line = this.lines[i];
      if (!line) continue;
      const result = response.results[line.hash] ?? { units: [], full: null };
      this.results.set(line.hash, result);
      for (const unit of result.units) {
        if (unit.end - unit.start > GLOSSARY_MAX_WORDS) continue;
        const english = line.words.slice(unit.start, unit.end).join(' ').toLowerCase();
        delete this.glossary[english];
        this.glossary[english] = unit.text;
      }
    }
    const keys = Object.keys(this.glossary);
    for (const key of keys.slice(0, Math.max(0, keys.length - GLOSSARY_SIZE))) delete this.glossary[key];
  }

  /** What to display for a cue, or null to show its original text. */
  linesFor(cue: Cue): Run[][] | null {
    const lines = this.byCue.get(cueKeyOf(cue));
    if (!lines) return null;
    let changed = false;
    const out = lines.map((line): Run[] => {
      const index = this.indexOf.get(line.id)!;
      const placed = this.shown.get(line.id) ?? this.planned.get(index)?.placed ?? [];
      if (placed.length === 0) return [{ text: (line.dash ? '- ' : '') + line.text }];
      changed = true;
      return hybridRuns(line, placed);
    });
    return changed ? out : null;
  }

  /** The English of every line, for the eval export. */
  exportLines(): { text: string; prev?: string; next?: string }[] {
    return this.lines.map((line, i) => ({ text: line.text, prev: this.lines[i - 1]?.text, next: this.lines[i + 1]?.text }));
  }

  /** How far along translation is, for the dev panel. */
  progress(): { lines: number; translated: number; stopped: string | null } {
    return { lines: this.lines.length, translated: this.lines.filter((l) => this.results.has(l.hash)).length, stopped: this.stopped };
  }

  /** Summary for the development label. */
  describe(): string {
    const h = hoursOf(this.state);
    let words = 0;
    let l2 = 0;
    for (const w of this.state.window) {
      words += w.words;
      l2 += w.l2;
    }
    const ready = this.lines.filter((l) => this.results.has(l.hash)).length;
    const mix = [1, 2, 3, 4].map((t) => this.state.ledger.filter((x) => x === t).length);
    const stop = this.stopped ? ` · ${this.stopped}` : '';
    return (
      `h ${h.toFixed(1)} · density ${(words ? l2 / words : 0).toFixed(3)}/${(targetDensity(h, FRENCH) * this.pace).toFixed(3)} · ` +
      `mix ${mix.join('/')} · known ${retainedCount(this.state)} · ready ${ready}/${this.lines.length} ` +
      `(cached ${this.cachedLines}) · $${this.costUsd.toFixed(3)}${stop}`
    );
  }

  get hourNow(): number {
    return this.state.wordsParsed / WORDS_PER_HOUR;
  }
}

/** Learner state as stored in chrome.storage. */
export function serializeState(s: EngineState): object {
  return { ...s, lastPartialEnd: Number.isFinite(s.lastPartialEnd) ? s.lastPartialEnd : null, lemmaCounts: Object.fromEntries(s.lemmaCounts) };
}

export function deserializeState(value: unknown): EngineState | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const v = value as Omit<EngineState, 'lemmaCounts' | 'lastPartialEnd'> & { lemmaCounts: Record<string, number>; lastPartialEnd: number | null };
  return {
    ...createState(),
    ...v,
    lastPartialEnd: v.lastPartialEnd ?? -Infinity,
    lemmaCounts: new Map(Object.entries(v.lemmaCounts ?? {})),
  };
}
