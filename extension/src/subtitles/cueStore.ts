// Holds captured subtitle files and places them on the episode timeline.
//
// A file long enough to be a whole episode is assumed to use episode time, so it
// needs no anchoring and works even with Netflix's captions switched off. A shorter
// file is anchored by matching a caption Netflix displays to one of its cues.
//
// A displayed caption only bounds the offset: it may have been first seen partway
// through the cue (page load, seek), so the true offset lies somewhere in
// [seen - cue duration, seen]. Each observation narrows that range.

import type { Cue } from './ttml';

interface Chunk {
  key: string;
  cues: Cue[];
  offset: number | null;
  /** Range the true offset must lie in. */
  lo: number;
  hi: number;
  isEpisode: boolean;
}

/** Spans at least this long are treated as a whole-episode file. */
const EPISODE_FILE_SECONDS = 300;
/** Slack for the delay between a caption changing and us reading it. */
const LATE_MARGIN = 0.25;
const EARLY_MARGIN = 0.05;

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

export class CueStore {
  private chunks: Chunk[] = [];
  private cached: Cue[] | null = null;

  /** Returns false when the file was already stored. */
  addChunk(cues: Cue[]): boolean {
    const first = cues[0];
    const last = cues.at(-1);
    if (!first || !last) return false;
    const key = cues.map((c) => `${c.begin}|${c.text}`).join('\n');
    if (this.chunks.some((c) => c.key === key)) return false;

    const isEpisode = last.end - first.begin >= EPISODE_FILE_SECONDS;
    // Only one episode file is live. A later one (the next episode prefetched, or
    // the closed-caption track) waits until a displayed caption shows it is in use.
    const live = isEpisode && !this.chunks.some((c) => c.isEpisode && c.offset !== null);
    this.chunks.push({ key, cues, offset: live ? 0 : null, lo: -Infinity, hi: Infinity, isEpisode });
    this.cached = null;
    return true;
  }

  /** Records a native caption seen at media time `t`. Returns the chunk's offset, if placed. */
  anchor(text: string, t: number): number | null {
    const target = norm(text);
    if (!target) return null;
    const matches: { chunk: Chunk; lo: number; hi: number }[] = [];
    for (const chunk of this.chunks) {
      for (const cue of chunk.cues) {
        if (norm(cue.text) !== target) continue;
        const seen = t - cue.begin;
        matches.push({ chunk, lo: seen - (cue.end - cue.begin) - LATE_MARGIN, hi: seen + EARLY_MARGIN });
      }
    }

    // Prefer a placed chunk this caption is consistent with.
    const placed = matches.filter((m) => m.chunk.offset !== null && m.lo <= m.chunk.hi && m.hi >= m.chunk.lo);
    const known = placed.find((m) => m.lo <= m.chunk.offset! && m.chunk.offset! <= m.hi) ?? placed[0];
    if (known) return this.narrow(known.chunk, known.lo, known.hi);

    // Place a new chunk only when the text is unambiguous ("Okay." can repeat).
    const fresh = matches.filter((m) => m.chunk.offset === null);
    const [only] = fresh;
    if (fresh.length !== 1 || !only) return null;
    // A waiting episode file that matches on its own is the one actually playing.
    if (only.chunk.isEpisode) this.chunks = this.chunks.filter((c) => c === only.chunk || !c.isEpisode);
    return this.narrow(only.chunk, only.lo, only.hi);
  }

  private narrow(chunk: Chunk, lo: number, hi: number): number {
    chunk.lo = Math.max(chunk.lo, lo);
    chunk.hi = Math.min(chunk.hi, hi);
    // Times that already fit the episode clock are exact; don't add measurement noise.
    chunk.offset = chunk.lo <= 0 && 0 <= chunk.hi ? 0 : chunk.hi - EARLY_MARGIN;
    this.cached = null;
    return chunk.offset;
  }

  /** Cues on the episode timeline, from placed chunks only. */
  timeline(): Cue[] {
    if (this.cached) return this.cached;
    const out: Cue[] = [];
    for (const chunk of this.chunks) {
      if (chunk.offset === null) continue;
      for (const c of chunk.cues) out.push({ ...c, begin: c.begin + chunk.offset, end: c.end + chunk.offset });
    }
    this.cached = out.sort((a, b) => a.begin - b.begin);
    return this.cached;
  }

  activeAt(t: number): Cue[] {
    return this.timeline().filter((c) => c.begin <= t && t < c.end);
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
