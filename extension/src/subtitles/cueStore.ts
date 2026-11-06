// Holds captured subtitle files and places them on the episode timeline.
//
// A file long enough to be a whole episode is assumed to use episode time, so it
// needs no anchoring and works even with Netflix's captions switched off. A shorter
// file is anchored by matching a caption Netflix displays to one of its cues.
//
// A displayed caption only bounds the offset: it may have been first seen partway
// through the cue (page load, seek), so the true offset lies somewhere in
// [seen - cue duration, seen]. Each observation narrows that range. If captions keep
// disagreeing with the range, the timeline moved (an ad break, say), so it restarts.

import type { Cue } from './ttml';

interface Range {
  lo: number;
  hi: number;
}

interface Chunk extends Range {
  key: string;
  cues: Cue[];
  offset: number | null;
  isEpisode: boolean;
  /** Captions that disagreed with the current range, and the range they agree on. */
  disagreements: number;
  rival: Range | null;
}

/** Spans at least this long are treated as a whole-episode file. */
const EPISODE_FILE_SECONDS = 300;
/** Slack for the delay between a caption changing and us reading it. */
const LATE_MARGIN = 0.25;
const EARLY_MARGIN = 0.05;
/** Disagreeing captions needed before a placed file is moved. */
const REPLACE_AFTER = 3;

/** Whether cues span enough time to be a whole episode's file. */
export function isEpisodeLength(cues: Cue[]): boolean {
  const first = cues[0];
  const last = cues.at(-1);
  return !!first && !!last && last.end - first.begin >= EPISODE_FILE_SECONDS;
}

export const normText = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

export class CueStore {
  private chunks: Chunk[] = [];
  private cached: Cue[] | null = null;
  private longestCue = 0;

  /** Returns false when the file was already stored. */
  addChunk(cues: Cue[]): boolean {
    if (cues.length === 0) return false;
    const key = cues.map((c) => `${c.begin}|${c.text}`).join('\n');
    if (this.chunks.some((c) => c.key === key)) return false;

    const isEpisode = isEpisodeLength(cues);
    // Only one episode file is live. A later one (the next episode prefetched, or
    // the closed-caption track) waits until a displayed caption shows it is in use.
    const live = isEpisode && !this.chunks.some((c) => c.isEpisode && c.offset !== null);
    this.chunks.push({
      key,
      cues,
      offset: live ? 0 : null,
      lo: -Infinity,
      hi: Infinity,
      isEpisode,
      disagreements: 0,
      rival: null,
    });
    this.cached = null;
    return true;
  }

  /** Records a native caption seen at media time `t`. Returns the chunk's offset, if placed. */
  anchor(text: string, t: number): number | null {
    const target = normText(text);
    if (!target) return null;
    const matches: ({ chunk: Chunk } & Range)[] = [];
    for (const chunk of this.chunks) {
      for (const cue of chunk.cues) {
        if (normText(cue.text) !== target) continue;
        const seen = t - cue.begin;
        matches.push({ chunk, lo: seen - (cue.end - cue.begin) - LATE_MARGIN, hi: seen + EARLY_MARGIN });
      }
    }

    // Prefer a placed chunk this caption is consistent with.
    const consistent = matches.filter((m) => m.chunk.offset !== null && m.lo <= m.chunk.hi && m.hi >= m.chunk.lo);
    const known = consistent.find((m) => m.lo <= m.chunk.offset! && m.chunk.offset! <= m.hi) ?? consistent[0];
    if (known) {
      known.chunk.disagreements = 0;
      known.chunk.rival = null;
      return this.narrow(known.chunk, known.lo, known.hi);
    }

    // Place a new chunk only when the text is unambiguous ("Okay." can repeat).
    const fresh = matches.filter((m) => m.chunk.offset === null);
    const [only] = fresh;
    if (fresh.length === 1 && only) {
      // A waiting episode file that matches on its own is the one actually playing.
      if (only.chunk.isEpisode) this.chunks = this.chunks.filter((c) => c === only.chunk || !c.isEpisode);
      return this.narrow(only.chunk, only.lo, only.hi);
    }

    const [lone] = matches;
    if (matches.length === 1 && lone && lone.chunk.offset !== null) return this.disagree(lone.chunk, lone);
    return null;
  }

  private disagree(chunk: Chunk, seen: Range): number | null {
    const rival = chunk.rival;
    const lo = rival ? Math.max(rival.lo, seen.lo) : seen.lo;
    const hi = rival ? Math.min(rival.hi, seen.hi) : seen.hi;
    if (lo > hi) {
      // These captions don't agree with each other either; start the count again.
      chunk.rival = seen;
      chunk.disagreements = 1;
      return null;
    }
    chunk.rival = { lo, hi };
    chunk.disagreements++;
    if (chunk.disagreements < REPLACE_AFTER) return null;
    chunk.lo = lo;
    chunk.hi = hi;
    chunk.rival = null;
    chunk.disagreements = 0;
    return this.narrow(chunk, lo, hi);
  }

  private narrow(chunk: Chunk, lo: number, hi: number): number {
    chunk.lo = Math.max(chunk.lo, lo);
    chunk.hi = Math.min(chunk.hi, hi);
    // Times that already fit the episode clock are exact; don't add measurement noise.
    chunk.offset = chunk.lo <= 0 && 0 <= chunk.hi ? 0 : chunk.hi - EARLY_MARGIN;
    this.cached = null;
    return chunk.offset;
  }

  /** Cues on the episode timeline, from placed chunks only, sorted by begin time. */
  timeline(): Cue[] {
    if (this.cached) return this.cached;
    const out: Cue[] = [];
    this.longestCue = 0;
    for (const chunk of this.chunks) {
      if (chunk.offset === null) continue;
      for (const c of chunk.cues) {
        out.push({ ...c, begin: c.begin + chunk.offset, end: c.end + chunk.offset });
        this.longestCue = Math.max(this.longestCue, c.end - c.begin);
      }
    }
    this.cached = out.sort((a, b) => a.begin - b.begin);
    return this.cached;
  }

  activeAt(t: number): Cue[] {
    const cues = this.timeline();
    // First cue starting after t.
    let lo = 0;
    let hi = cues.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cues[mid]!.begin <= t) lo = mid + 1;
      else hi = mid;
    }
    const active: Cue[] = [];
    for (let i = lo - 1; i >= 0; i--) {
      const cue = cues[i]!;
      if (cue.begin < t - this.longestCue) break;
      if (t < cue.end) active.unshift(cue);
    }
    return active;
  }

  /** How far a caption seen at `t` is from the cue with that text, in seconds. */
  syncError(text: string, t: number): number | null {
    const target = normText(text);
    let best: number | null = null;
    for (const cue of this.timeline()) {
      if (normText(cue.text) !== target) continue;
      const error = t - cue.begin;
      if (best === null || Math.abs(error) < Math.abs(best)) best = error;
    }
    return best;
  }

  get anchoredChunks(): number {
    return this.chunks.filter((c) => c.offset !== null).length;
  }

  get totalChunks(): number {
    return this.chunks.length;
  }

  /** Short state summary for the development label. */
  describe(): string {
    const placed = this.chunks.filter((c) => c.offset !== null);
    const cues = placed.reduce((n, c) => n + c.cues.length, 0);
    const offsets = placed.map((c) => c.offset!.toFixed(2)).join(', ');
    return `${placed.length}/${this.chunks.length} files · ${cues} cues · offset ${offsets || 'none'}`;
  }

  /** Moves to a new episode, keeping an episode file that was fetched ahead of time. */
  nextEpisode(): void {
    const waiting = this.chunks.find((c) => c.isEpisode && c.offset === null);
    this.chunks = waiting ? [{ ...waiting, offset: 0 }] : [];
    this.cached = null;
  }
}
