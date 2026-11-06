import { describe, expect, it } from 'vitest';
import { CueStore } from './cueStore';
import type { Cue } from './ttml';

const cue = (begin: number, end: number, text: string): Cue => ({ id: text, begin, end, text });
const episodeFile = (name: string) => [cue(10, 12, `${name} opening`), cue(20, 23, 'Okay.'), cue(1200, 1203, `${name} ending`)];

describe('CueStore anchoring', () => {
  it('anchors a short chunk from a native caption and refines toward the earliest appearance', () => {
    const store = new CueStore();
    store.addChunk([cue(2, 4, 'Where are the keys?'), cue(5, 7, 'In the kitchen.')]);
    expect(store.timeline()).toHaveLength(0);

    expect(store.anchor('Where are the keys?', 1652.08)).toBeCloseTo(1650.08, 6);
    expect(store.anchor('In the kitchen.', 1655.03)).toBeCloseTo(1650.03, 6);
    expect(store.activeAt(1655.5).map((c) => c.text)).toEqual(['In the kitchen.']);
  });

  it('recovers when the first caption was seen seconds into its cue', () => {
    const store = new CueStore();
    store.addChunk([cue(2, 6, 'A long first line'), cue(10, 12, 'The next line')]);
    // Page loaded 3 s into the first cue, so this first estimate is 3 s late.
    expect(store.anchor('A long first line', 105)).toBeCloseTo(103, 6);
    expect(store.anchor('The next line', 110)).toBeCloseTo(100, 6);
  });

  it('ignores ambiguous text until a unique line arrives', () => {
    const store = new CueStore();
    store.addChunk([cue(1, 2, 'Okay.'), cue(3, 4, 'First chunk line')]);
    store.addChunk([cue(1, 2, 'Okay.'), cue(3, 4, 'Second chunk line')]);
    expect(store.anchor('Okay.', 101)).toBeNull();
    expect(store.anchor('Second chunk line', 178)).toBeCloseTo(175, 6);
    expect(store.anchoredChunks).toBe(1);
  });

  it('skips duplicate chunks', () => {
    const store = new CueStore();
    expect(store.addChunk([cue(1, 2, 'Hi')])).toBe(true);
    expect(store.addChunk([cue(1, 2, 'Hi')])).toBe(false);
  });
});

describe('CueStore episode files', () => {
  it('uses episode time immediately, with no native caption needed', () => {
    const store = new CueStore();
    store.addChunk(episodeFile('Pilot'));
    expect(store.activeAt(11).map((c) => c.text)).toEqual(['Pilot opening']);
  });

  it('stays exact when a caption is first seen partway through its cue', () => {
    const store = new CueStore();
    store.addChunk(episodeFile('Pilot'));
    expect(store.anchor('Pilot opening', 11.5)).toBe(0);
    expect(store.activeAt(20.01).map((c) => c.text)).toEqual(['Okay.']);
  });

  it('moves off zero if displayed captions prove the file uses different times', () => {
    const store = new CueStore();
    store.addChunk(episodeFile('Pilot'));
    expect(store.anchor('Pilot opening', 70)).toBeCloseTo(60, 6);
    expect(store.activeAt(70.5).map((c) => c.text)).toEqual(['Pilot opening']);
  });

  it('does not overlay a second episode file fetched ahead of time', () => {
    const store = new CueStore();
    store.addChunk(episodeFile('Pilot'));
    store.addChunk(episodeFile('Next'));
    expect(store.activeAt(11).map((c) => c.text)).toEqual(['Pilot opening']);
    expect(store.anchoredChunks).toBe(1);
  });

  it('switches when a waiting file is the one being displayed', () => {
    const store = new CueStore();
    store.addChunk(episodeFile('Pilot'));
    store.addChunk(episodeFile('Closed captions'));
    expect(store.anchor('Closed captions opening', 10.02)).toBe(0);
    expect(store.activeAt(11).map((c) => c.text)).toEqual(['Closed captions opening']);
    expect(store.totalChunks).toBe(1);
  });

  it('promotes a prefetched file on the next episode', () => {
    const store = new CueStore();
    store.addChunk(episodeFile('Pilot'));
    store.addChunk(episodeFile('Next'));
    store.nextEpisode();
    expect(store.activeAt(11).map((c) => c.text)).toEqual(['Next opening']);
  });
});
