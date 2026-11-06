// Turns a displayed cue into the "lines" the speed limit reasons about:
// sound descriptions and music removed, two-speaker cues split per speaker.

export interface Segment {
  /** Text as it should be translated and displayed. */
  text: string;
  /** Leading dash kept for display when the cue had two speakers. */
  dash: boolean;
}

const SOUND_CUE = /\[[^\]]*\]|\([A-Z][^)a-z]*\)/g; // [door slams], (LAUGHS)
const SPEAKER_LABEL = /^[A-Z][A-Z .'-]{1,24}:\s*/; // JOEY: ...
const MUSIC = /[♪♫]/;

export function cleanCue(text: string): Segment[] {
  const lines = text.split('\n');
  const twoSpeakers = lines.filter((l) => /^\s*-/.test(l)).length >= 2;
  const raw = twoSpeakers ? lines : [lines.join(' ')];

  return raw
    .map((l) => ({
      text: l
        .replace(SOUND_CUE, ' ')
        .replace(/^\s*-\s*/, '')
        .replace(SPEAKER_LABEL, '')
        .replace(/\s+/g, ' ')
        .trim(),
      dash: twoSpeakers,
    }))
    .filter((s) => s.text.length > 0 && !MUSIC.test(s.text));
}

/** Non-punctuation word count, the unit the speed limit counts in. */
export function countWords(text: string): number {
  return (text.match(/[\p{L}\p{N}]+(?:['’][\p{L}]+)*/gu) ?? []).length;
}

export async function lineHash(text: string): Promise<string> {
  const normalised = text.toLowerCase().replace(/\s+/g, ' ').trim();
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalised));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}
