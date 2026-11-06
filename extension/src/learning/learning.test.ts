import { describe, expect, it } from 'vitest';
import type { LineResult, TranslateRequest } from '../../../shared/protocol';
import { createState } from '../engine/s6r';
import type { Cue } from '../subtitles/ttml';
import { hybridRuns } from './hybrid';
import { buildLines, type Line } from './lines';
import { deserializeState, LearningSession, serializeState, toEngineLine, type TranslateOutcome } from './session';

const cue = (i: number, text: string): Cue => ({ id: `c${i}`, begin: i * 3, end: i * 3 + 2, text, lines: [[{ text }]] });
const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

async function line(text: string): Promise<Line> {
  return (await buildLines([cue(0, text)]))[0]!;
}

describe('buildLines', () => {
  it('splits two speakers, skips sound cues, and numbers words without punctuation', async () => {
    const lines = await buildLines([cue(0, "- I don't know.\n- Ask Ross."), cue(1, '[door slams]')]);
    expect(lines.map((l) => l.words)).toEqual([["I", "don't", 'know'], ['Ask', 'Ross']]);
    expect(lines[0]!.dash).toBe(true);
    expect(lines[0]!.cueKey).toBe(lines[1]!.cueKey);
  });
});

describe('hybridRuns', () => {
  it('replaces the chosen words and keeps surrounding punctuation', async () => {
    const l = await line('Where are the keys, Ross?');
    expect(hybridRuns(l, [{ tier: 2, start: 2, end: 4, lemmas: [], text: 'les clés' }])).toEqual([
      { text: 'Where are ' },
      { text: 'les clés', l2: true },
      { text: ', Ross?' },
    ]);
  });

  it('keeps a capital at the start of the line, and all-caps', async () => {
    const l = await line('The keys are HERE NOW');
    expect(hybridRuns(l, [{ tier: 2, start: 0, end: 2, lemmas: [], text: 'les clés' }])[0]).toEqual({ text: 'Les clés', l2: true });
    expect(hybridRuns(l, [{ tier: 2, start: 3, end: 5, lemmas: [], text: 'ici maintenant' }])[1]).toEqual({ text: 'ICI MAINTENANT', l2: true });
  });

  it('shows a full sentence untinted, with its dash', async () => {
    const lines = await buildLines([cue(0, '- Go home.\n- No.')]);
    expect(hybridRuns(lines[0]!, [{ tier: 4, start: 0, end: 2, lemmas: [], text: 'Rentre.' }])).toEqual([{ text: '- Rentre.' }]);
  });

  it('skips overlapping units rather than garbling text', async () => {
    const l = await line('one two three four');
    const runs = hybridRuns(l, [
      { tier: 2, start: 0, end: 2, lemmas: [], text: 'un deux' },
      { tier: 2, start: 1, end: 3, lemmas: [], text: 'x' },
    ]);
    expect(runs.map((r) => r.text).join('')).toBe('un deux three four');
  });
});

describe('toEngineLine', () => {
  it('assigns tiers by length and adds the full sentence', async () => {
    const l = await line('one two three four five six');
    const result: LineResult = {
      units: [
        { start: 0, end: 1, text: 'a', lemmas: [], score: 2 },
        { start: 0, end: 3, text: 'b', lemmas: [], score: 1 },
        { start: 0, end: 5, text: 'c', lemmas: [], score: 2 },
        { start: 0, end: 6, text: 'too long', lemmas: [], score: 2 },
      ],
      full: { text: 'd', lemmas: ['x'] },
    };
    expect(toEngineLine(l, result).candidates.map((c) => c.tier)).toEqual([1, 2, 3, 4]);
  });
});

/** Every line has a full sentence, so S6r has something to place at any stage. */
function fullFor(request: TranslateRequest): TranslateOutcome {
  const results: Record<string, LineResult> = {};
  for (const l of request.lines) results[l.hash] = { units: [], full: { text: `FR ${l.text}`, lemmas: l.words } };
  return { ok: true, response: { results, stats: { cached: 0, translated: request.lines.length, dropped: 0, refused: false, costUsd: 0.01 } } };
}

async function session(count: number, translate: (r: TranslateRequest) => TranslateOutcome | Promise<TranslateOutcome>, hour = 400) {
  const cues = Array.from({ length: count }, (_, i) => cue(i, `line number ${i} says something here`));
  const lines = await buildLines(cues);
  const saved: number[] = [];
  const s = new LearningSession({ translate: async (r) => translate(r), save: (st) => saved.push(st.wordsParsed) }, createState(hour));
  s.relaxTicks = true;
  s.setEpisode('1');
  s.setLines(lines, 0);
  return { s, cues, lines, saved };
}

const anyFrench = (s: LearningSession, cues: Cue[]) => cues.some((c) => s.linesFor(c) !== null);

describe('LearningSession', () => {
  it('shows French once translations arrive, and asks for lines from the playhead', async () => {
    const seen: string[] = [];
    const { s, cues } = await session(120, (r) => {
      seen.push(r.lines[0]!.text);
      return fullFor(r);
    });
    s.tick(100, false);
    await flush();
    expect(seen[0]).toContain('line number 33');
    for (let i = 0; i < 4; i++) {
      s.tick(100, false);
      await flush();
    }
    expect(anyFrench(s, cues.slice(34))).toBe(true);
  });

  it('does not count lines until they have played, or while not counting', async () => {
    const { s, saved } = await session(60, fullFor);
    const start = s.hourNow;
    s.tick(0, true);
    await flush();
    s.tick(0.5, true);
    expect(s.hourNow).toBe(start);
    s.tick(1, false);
    s.tick(2.5, false);
    expect(s.hourNow).toBe(start);
    s.tick(2.5, true);
    expect(s.hourNow).toBeGreaterThan(start);
    expect(saved).toEqual([]);
  });

  it('does not count again when skipping back over played lines', async () => {
    const { s } = await session(60, fullFor);
    for (let t = 0; t <= 30; t += 1) {
      s.tick(t, true);
      await flush();
    }
    const played = s.hourNow;
    s.tick(5, true);
    for (let t = 5; t <= 20; t += 1) s.tick(t, true);
    expect(s.hourNow).toBe(played);
  });

  it('does not count lines skipped over', async () => {
    const { s } = await session(100, fullFor);
    s.tick(1, true);
    await flush();
    const before = s.hourNow;
    s.tick(200, true);
    expect(s.hourNow).toBe(before);
  });

  it('never changes a line that is already on screen', async () => {
    let release: (o: TranslateOutcome) => void = () => {};
    const { s, cues } = await session(20, () => new Promise<TranslateOutcome>((r) => (release = r)));
    let request: TranslateRequest | undefined;
    s.tick(0.5, true);
    await flush();
    // The translation arrives while the first line is on screen.
    s.tick(0.6, true);
    request = { videoId: '1', lang: 'fr', glossary: {}, lines: [] };
    const lines = await buildLines(cues);
    request.lines = lines.slice(0, 20).map((l) => ({ hash: l.hash, words: l.words, text: l.text }));
    release(fullFor(request));
    await flush();
    s.tick(0.7, true);
    expect(s.linesFor(cues[0]!)).toBeNull();
  });

  it('stays English and stops asking when over budget', async () => {
    let calls = 0;
    const { s, cues } = await session(60, () => {
      calls++;
      return { ok: false, reason: 'over_budget' };
    });
    for (let t = 0; t < 10; t++) {
      s.tick(t, true);
      await flush();
    }
    expect(calls).toBe(1);
    expect(anyFrench(s, cues)).toBe(false);
  });

  it('gives up on lines after repeated failures, leaving them English', async () => {
    let calls = 0;
    const { s, cues } = await session(10, () => {
      calls++;
      return { ok: false, reason: 'failed' };
    });
    for (let i = 0; i < 6; i++) {
      s.tick(0.5, true, i * 10_000 + performance.now());
      await flush();
      await new Promise((r) => setTimeout(r, 0));
    }
    expect(calls).toBeGreaterThanOrEqual(1);
    expect(anyFrench(s, cues)).toBe(false);
  });

  it('sends a glossary of what it has chosen, so words stay consistent', async () => {
    const glossaries: Record<string, string>[] = [];
    const { s } = await session(100, (r) => {
      glossaries.push({ ...r.glossary });
      const results: Record<string, LineResult> = {};
      for (const l of r.lines) results[l.hash] = { units: [{ start: 0, end: 2, text: 'la ligne', lemmas: ['ligne'], score: 2 }], full: null };
      return { ok: true, response: { results, stats: { cached: 0, translated: 0, dropped: 0, refused: false, costUsd: 0 } } };
    });
    for (let i = 0; i < 3; i++) {
      s.tick(0, false);
      await flush();
    }
    expect(glossaries[0]).toEqual({});
    expect(glossaries[1]).toEqual({ 'line number': 'la ligne' });
  });

  it('keeps tracking the schedule when jumped to a later stage', async () => {
    const { s } = await session(10, fullFor, 0);
    s.jump(350, false, 0);
    expect(s.hourNow).toBe(350);
  });
});

describe('saved state', () => {
  it('round-trips through JSON', () => {
    const state = createState(12);
    state.lemmaCounts.set('maison', 3);
    state.ledger.push(2);
    const restored = deserializeState(JSON.parse(JSON.stringify(serializeState(state))))!;
    expect(restored.lemmaCounts.get('maison')).toBe(3);
    expect(restored.ledger).toEqual([2]);
    expect(restored.lastPartialEnd).toBe(-Infinity);
    expect(restored.wordsParsed).toBe(state.wordsParsed);
  });

  it('ignores missing state', () => {
    expect(deserializeState(undefined)).toBeUndefined();
  });
});
