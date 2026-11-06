// Messages between the page-context hook and the extension's content script.

/** Page to content script: a TTML subtitle document was downloaded. */
export const TTML_MESSAGE = 'subtitle-learning:ttml';

export interface TtmlMessage {
  type: typeof TTML_MESSAGE;
  xml: string;
  currentTime: number | null;
}

/** Content script to page: make sure the English track is on, or restore the original. */
export const COMMAND_MESSAGE = 'subtitle-learning:command';

export interface CommandMessage {
  type: typeof COMMAND_MESSAGE;
  command: 'ensure-english' | 'restore-track';
}

/** Page to content script: the outcome of ensure-english. */
export const TRACK_STATUS_MESSAGE = 'subtitle-learning:track-status';

export interface TrackStatusMessage {
  type: typeof TRACK_STATUS_MESSAGE;
  /** kept: English was already on. switched: we turned it on. no-english: the title has none. unavailable: the player API couldn't be used. */
  status: 'kept' | 'switched' | 'no-english' | 'unavailable';
}
