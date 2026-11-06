// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { cleanCue, countWords } from './hygiene';
import { isTtml, parseTime, parseTtml } from './ttml';

// Same structure as the Netflix chunks observed on 2026-10-25, with made-up text.
const SAMPLE = `<?xml version="1.0" encoding="utf-8"?>
<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttp="http://www.w3.org/ns/ttml#parameter"
    xmlns:tts="http://www.w3.org/ns/ttml#styling" ttp:tickRate="10000000" ttp:timeBase="media" xml:lang="en">
  <head><layout><region xml:id="region0"/></layout></head>
  <body><div>
    <p xml:id="subtitle1" begin="22400000t" end="45000000t" region="region0"><span>Where did you</span><br/><span>put the keys?</span></p>
    <p xml:id="subtitle2" begin="50000000t" end="61000000t" region="region0">- I have no idea.<br/>- Check the kitchen.</p>
    <p xml:id="subtitle3" begin="70000000t" end="80000000t" region="region0">[door slams]</p>
  </div></body>
</tt>`;

describe('TTML parsing', () => {
  it('detects TTML documents', () => {
    expect(isTtml(SAMPLE)).toBe(true);
    expect(isTtml('{"json":true}')).toBe(false);
  });

  it('reads tick times, line breaks and regions', () => {
    const cues = parseTtml(SAMPLE);
    expect(cues).toHaveLength(3);
    expect(cues[0]!).toEqual({
      id: 'subtitle1',
      begin: 2.24,
      end: 4.5,
      text: 'Where did you\nput the keys?',
      lines: [[{ text: 'Where did you' }], [{ text: 'put the keys?' }]],
      region: 'region0',
    });
  });

  it('keeps italics from attributes and referenced styles', () => {
    const cues = parseTtml(`<tt xmlns="http://www.w3.org/ns/ttml" xmlns:tts="http://www.w3.org/ns/ttml#styling">
      <head><styling><style xml:id="it" tts:fontStyle="italic"/></styling></head>
      <body><div>
        <p begin="0t" end="10t"><span tts:fontStyle="italic">Off screen</span> on screen</p>
        <p begin="0t" end="10t" style="it">All of it</p>
      </div></body></tt>`);
    expect(cues[0]!.lines).toEqual([[{ text: 'Off screen', italic: true }, { text: ' on screen' }]]);
    expect(cues[0]!.text).toBe('Off screen on screen');
    expect(cues[1]!.lines).toEqual([[{ text: 'All of it', italic: true }]]);
  });

  it('reads placement from regions', () => {
    const cues = parseTtml(`<tt xmlns="http://www.w3.org/ns/ttml" xmlns:tts="http://www.w3.org/ns/ttml#styling">
      <head><layout>
        <region xml:id="high" tts:origin="10% 5%" tts:extent="80% 10%"/>
        <region xml:id="low" tts:origin="10% 80%" tts:extent="80% 10%"/>
      </layout></head>
      <body><div>
        <p begin="0t" end="10t" region="high">Top</p>
        <p begin="0t" end="10t" region="low">Bottom</p>
        <p begin="0t" end="10t" region="missing">Unknown</p>
      </div></body></tt>`);
    expect(cues[0]!.position).toEqual({ x: 0.5, y: 'top', offset: 0.05 });
    expect(cues[1]!.position?.y).toBe('bottom');
    expect(cues[1]!.position?.offset).toBeCloseTo(0.1, 6);
    expect(cues[2]!.position).toBeUndefined();
  });

  it('applies a chunk offset', () => {
    expect(parseTtml(SAMPLE, 75)[0]!.begin).toBeCloseTo(77.24, 6);
  });

  it('parses clock times', () => {
    expect(parseTime('00:01:02.500', 1)).toBeCloseTo(62.5, 6);
    expect(parseTime('1500ms', 1)).toBe(1.5);
  });
});

describe('cue hygiene', () => {
  it('joins a single speaker across line breaks', () => {
    expect(cleanCue('Where did you\nput the keys?')).toEqual([{ text: 'Where did you put the keys?', dash: false }]);
  });

  it('splits two speakers', () => {
    expect(cleanCue('- I have no idea.\n- Check the kitchen.').map((s) => s.text)).toEqual([
      'I have no idea.',
      'Check the kitchen.',
    ]);
  });

  it('drops sound descriptions, speaker labels and music', () => {
    expect(cleanCue('[door slams]')).toEqual([]);
    expect(cleanCue('JOEY: (LAUGHS) How you doin?')[0]!.text).toBe('How you doin?');
    expect(cleanCue('♪ la la la ♪')).toEqual([]);
  });

  it('counts words without punctuation', () => {
    expect(countWords("I don't know, Ross.")).toBe(4);
  });
});
