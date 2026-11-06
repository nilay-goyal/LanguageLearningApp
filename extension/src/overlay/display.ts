// Decides what the caption layer shows and where. Kept free of the DOM so the rules
// can be tested directly.

import { normText } from '../subtitles/cueStore';
import type { Cue, Run } from '../subtitles/ttml';

export interface Placement {
  /** Horizontal centre, as a fraction of the picture width. */
  x: number;
  y: 'top' | 'bottom';
  /** Distance from that edge, as a fraction of the picture height. */
  offset: number;
}

export interface Block extends Placement {
  lines: Run[][];
}

export const DEFAULT_BOTTOM_OFFSET = 0.09;
const MIN_FILE_BOTTOM_OFFSET = 0.05;
const CENTER = 0.5;

export type DisplaySource = 'timeline' | 'mirror' | 'idle';

/**
 * Our cues are preferred, but Netflix's own caption is always right about what should
 * be on screen, so a disagreement mirrors it. Just after a seek Netflix's caption is
 * stale, so the timeline wins for that moment.
 */
export function chooseSource(active: Cue[], nativeText: string, settling: boolean): DisplaySource {
  if (active.length === 0) return nativeText && !settling ? 'mirror' : 'idle';
  if (!nativeText || settling) return 'timeline';
  return normText(active.map((c) => c.text).join(' ')) === normText(nativeText) ? 'timeline' : 'mirror';
}

const textToLines = (text: string): Run[][] => text.split('\n').map((line) => [{ text: line }]);

/** Placement of one cue when Netflix's own caption can't be copied. */
function filePlacement(cue: Cue, bottomOffset: number | null): Placement {
  const p = cue.position;
  if (p?.y === 'top') return p;
  return {
    x: p?.x ?? CENTER,
    y: 'bottom',
    offset: bottomOffset ?? Math.max(p?.offset ?? DEFAULT_BOTTOM_OFFSET, MIN_FILE_BOTTOM_OFFSET),
  };
}

/**
 * `native` is the position of Netflix's visible caption, if there is one.
 * `bottomOffset` is the last bottom position it was seen at.
 */
export function buildBlocks(
  source: DisplaySource,
  active: Cue[],
  nativeText: string,
  native: Placement | null,
  bottomOffset: number | null,
): Block[] {
  if (source === 'idle') return [];
  if (source === 'mirror') {
    return [{ ...(native ?? { x: CENTER, y: 'bottom', offset: bottomOffset ?? DEFAULT_BOTTOM_OFFSET }), lines: textToLines(nativeText) }];
  }

  const [only] = active;
  if (only && active.length === 1 && native) return [{ ...native, lines: only.lines }];

  const blocks: Block[] = [];
  for (const cue of active) {
    const placement = filePlacement(cue, bottomOffset);
    const same = blocks.find((b) => b.y === placement.y && Math.abs(b.x - placement.x) < 0.02);
    if (same) same.lines = [...same.lines, ...cue.lines];
    else blocks.push({ ...placement, lines: cue.lines });
  }
  return blocks;
}

/** Median and 95th percentile of the absolute values, in milliseconds. */
export function syncSummary(errors: number[]): { median: number; p95: number } | null {
  if (errors.length === 0) return null;
  const sorted = errors.map((e) => Math.abs(e) * 1000).sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
  return { median: Math.round(at(0.5)), p95: Math.round(at(0.95)) };
}
