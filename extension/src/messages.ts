/** postMessage type used by the page-context hook to hand TTML to the content script. */
export const TTML_MESSAGE = 'subtitle-learning:ttml';

export interface TtmlMessage {
  type: typeof TTML_MESSAGE;
  xml: string;
  currentTime: number | null;
}
