import { describe, expect, it } from 'vitest';
import { chooseEnglishTrack, type NetflixTrack } from './tracks';

const off: NetflixTrack = { trackId: 'off', bcp47: null, isNoneTrack: true, rawTrackType: 'SUBTITLES' };
const en: NetflixTrack = { trackId: 'en', bcp47: 'en', rawTrackType: 'SUBTITLES' };
const cc: NetflixTrack = { trackId: 'cc', bcp47: 'en', rawTrackType: 'CLOSEDCAPTIONS' };
const fr: NetflixTrack = { trackId: 'fr', bcp47: 'fr', rawTrackType: 'SUBTITLES' };
const forced: NetflixTrack = { trackId: 'forced', bcp47: 'en', rawTrackType: 'SUBTITLES', isForcedNarrative: true };
const image: NetflixTrack = { trackId: 'img', bcp47: 'en', rawTrackType: 'SUBTITLES', isImageBased: true };

describe('chooseEnglishTrack', () => {
  it('leaves English alone, including closed captions the viewer chose', () => {
    expect(chooseEnglishTrack(en, [off, en, cc])).toBe('keep');
    expect(chooseEnglishTrack(cc, [off, en, cc])).toBe('keep');
  });

  it('turns on English subtitles when off or in another language', () => {
    expect(chooseEnglishTrack(off, [off, cc, en, fr])).toBe(en);
    expect(chooseEnglishTrack(fr, [off, cc, en, fr])).toBe(en);
    expect(chooseEnglishTrack(null, [off, en])).toBe(en);
  });

  it('falls back to closed captions', () => {
    expect(chooseEnglishTrack(off, [off, cc, fr])).toBe(cc);
  });

  it('does not count forced-narrative or image tracks as English', () => {
    expect(chooseEnglishTrack(forced, [off, forced, en])).toBe(en);
    expect(chooseEnglishTrack(off, [off, forced, image, fr])).toBeNull();
  });
});
