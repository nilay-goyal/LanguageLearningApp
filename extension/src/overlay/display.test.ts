import { describe, expect, it } from 'vitest';
import type { Cue, CuePosition } from '../subtitles/ttml';
import { buildBlocks, chooseSource, DEFAULT_BOTTOM_OFFSET, type Placement, syncSummary } from './display';

const cue = (text: string, position?: CuePosition): Cue => ({
  id: text,
  begin: 0,
  end: 1,
  text,
  lines: [[{ text }]],
  ...(position ? { position } : {}),
});
const native: Placement = { x: 0.5, y: 'bottom', offset: 0.14 };

describe('chooseSource', () => {
  it('uses our cue when it agrees with Netflix, or Netflix shows nothing', () => {
    expect(chooseSource([cue('Hello there.')], 'Hello there.', false)).toBe('timeline');
    expect(chooseSource([cue('Hello there.')], '', false)).toBe('timeline');
  });

  it('ignores line breaks and punctuation when comparing', () => {
    expect(chooseSource([cue('Hello\nthere')], 'Hello there.', false)).toBe('timeline');
  });

  it('mirrors Netflix when we have nothing or disagree', () => {
    expect(chooseSource([], 'Hello there.', false)).toBe('mirror');
    expect(chooseSource([cue('Wrong line')], 'Hello there.', false)).toBe('mirror');
  });

  it('trusts the timeline just after a seek, when Netflix is stale', () => {
    expect(chooseSource([cue('New line')], 'Old line', true)).toBe('timeline');
    expect(chooseSource([], 'Old line', true)).toBe('idle');
  });

  it('is idle with nothing to show', () => {
    expect(chooseSource([], '', false)).toBe('idle');
  });
});

describe('buildBlocks', () => {
  it('copies the position of the caption Netflix is showing', () => {
    expect(buildBlocks('timeline', [cue('A')], 'A', native, null)).toEqual([{ ...native, lines: [[{ text: 'A' }]] }]);
  });

  it('keeps top placement from the file when no caption can be copied', () => {
    const top: CuePosition = { x: 0.5, y: 'top', offset: 0.05 };
    expect(buildBlocks('timeline', [cue('Sign', top)], '', null, 0.14)[0]).toMatchObject(top);
  });

  it('uses the last known bottom position, then the default', () => {
    expect(buildBlocks('timeline', [cue('A')], '', null, 0.14)[0]).toMatchObject({ y: 'bottom', offset: 0.14 });
    expect(buildBlocks('timeline', [cue('A')], '', null, null)[0]).toMatchObject({ y: 'bottom', offset: DEFAULT_BOTTOM_OFFSET });
  });

  it('stacks cues in the same place and separates cues elsewhere', () => {
    const top: CuePosition = { x: 0.5, y: 'top', offset: 0.05 };
    const stacked = buildBlocks('timeline', [cue('A'), cue('B')], '', null, null);
    expect(stacked).toHaveLength(1);
    expect(stacked[0]!.lines).toHaveLength(2);
    expect(buildBlocks('timeline', [cue('Sign', top), cue('A')], '', null, null)).toHaveLength(2);
  });

  it('mirrors native text line by line', () => {
    expect(buildBlocks('mirror', [], 'A\nB', native, null)[0]!.lines).toEqual([[{ text: 'A' }], [{ text: 'B' }]]);
  });

  it('is empty when idle', () => {
    expect(buildBlocks('idle', [cue('A')], 'A', native, null)).toEqual([]);
  });
});

describe('syncSummary', () => {
  it('gives median and 95th percentile in milliseconds, ignoring sign', () => {
    expect(syncSummary([])).toBeNull();
    expect(syncSummary([0.01, -0.02, 0.03, 0.04, 0.5])).toEqual({ median: 30, p95: 500 });
  });
});
