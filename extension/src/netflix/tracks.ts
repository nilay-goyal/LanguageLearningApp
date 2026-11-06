// Chooses which Netflix subtitle track the extension needs. Field names match the
// objects returned by the player's getTimedTextTrackList().

export interface NetflixTrack {
  trackId: string;
  bcp47: string | null;
  rawTrackType?: string;
  isNoneTrack?: boolean;
  isForcedNarrative?: boolean;
  isImageBased?: boolean;
}

const isUsableEnglish = (t: NetflixTrack) =>
  !t.isNoneTrack && !t.isForcedNarrative && !t.isImageBased && (t.bcp47 ?? '').toLowerCase().startsWith('en');

/** Returns 'keep' when English is already on, the track to switch to, or null if there is none. */
export function chooseEnglishTrack(current: NetflixTrack | null, list: NetflixTrack[]): 'keep' | NetflixTrack | null {
  if (current && isUsableEnglish(current)) return 'keep';
  const english = list.filter(isUsableEnglish);
  return english.find((t) => t.rawTrackType === 'SUBTITLES') ?? english[0] ?? null;
}
