// Turns timed cues into the lines the speed limit and translator work on.

import { cleanCue, lineHash, type Token, tokenize } from '../subtitles/hygiene';
import type { Cue } from '../subtitles/ttml';

export interface Line {
  id: string;
  /** The cue this line is part of. A two-speaker cue has two lines. */
  cueKey: string;
  begin: number;
  end: number;
  text: string;
  dash: boolean;
  tokens: Token[];
  words: string[];
  hash: string;
}

export const cueKeyOf = (cue: Cue) => `${cue.id}@${cue.begin}`;

/** Cues must be sorted by begin time. Cues with no speech (sound descriptions, music) give no lines. */
export async function buildLines(cues: Cue[]): Promise<Line[]> {
  const lines: Line[] = [];
  for (const cue of cues) {
    const segments = cleanCue(cue.text);
    for (const [k, segment] of segments.entries()) {
      const tokens = tokenize(segment.text);
      if (tokens.length === 0) continue;
      lines.push({
        id: `${cueKeyOf(cue)}#${k}`,
        cueKey: cueKeyOf(cue),
        begin: cue.begin,
        end: cue.end,
        text: segment.text,
        dash: segment.dash,
        tokens,
        words: tokens.map((t) => segment.text.slice(t.start, t.end)),
        hash: await lineHash(segment.text),
      });
    }
  }
  return lines;
}
