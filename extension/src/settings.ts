// Keys in chrome.storage.local.

/** Whether the extension is switched on. Missing means on. */
export const ENABLED_KEY = 'enabled';
export const isEnabledValue = (value: unknown) => value !== false;

/** Saved learner state. */
export const LEARNER_KEY = 'learner';
/** Multiplies target density: 0.75 gentle, 1 balanced, 1.2 immersive. */
export const PACE_KEY = 'pace';
/** Skip the tick gate, for test stages (see EngineOptions.ignoreTicks). */
export const RELAX_TICKS_KEY = 'relaxTicks';
/** A request from the dev panel to move the learner: { hour, reset, nonce }. */
export const JUMP_KEY = 'jump';
/** What last stopped the caption layer, for the dev panel: "time · message". */
export const LAST_ERROR_KEY = 'lastError';
/** Development only: { url, token } to use instead of the built-in API settings. */
export const API_OVERRIDE_KEY = 'apiOverride';

export interface JumpRequest {
  hour: number;
  reset: boolean;
  nonce: number;
}

/** Sent from the dev panel to the Netflix tab. */
export const EXPORT_LINES_MESSAGE = 'subtitle-learning:export-lines';
/** Dev panel asks the Netflix tab how it's doing. */
export const STATUS_MESSAGE = 'subtitle-learning:status';
/** Development only: a command from the page, so test tools can reach the session. */
export const DEV_COMMAND_MESSAGE = 'subtitle-learning:dev';

export interface TabStatus {
  /** Whether an episode's subtitles have been captured. */
  lines: number;
  translated: number;
  stopped: string | null;
  running: boolean;
}
/** Sent from the content script to the background script. */
export const TRANSLATE_MESSAGE = 'subtitle-learning:translate';
