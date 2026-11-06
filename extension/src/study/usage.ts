// How much each tester has used it, and when a recall check is due.

export interface Usage {
  installedAt: number;
  /** Seconds of playback since the last check. */
  secsSinceCheck: number;
  totalSecs: number;
  lastCheckAt: number | null;
  checksDone: number;
  baseline0Done: boolean;
  baseline14Done: boolean;
  followUpDone: boolean;
}

export const DAY_MS = 24 * 3600 * 1000;
/** At most this many recall checks in the 14 days of the study. */
export const MAX_CHECKS = 5;
const STUDY_DAYS = 14;
const FOLLOW_UP_DAY = 21;
const MIN_GAP_DAYS = 2;
const MIN_WATCHED_SECS = 45 * 60;
export const MIN_ITEMS_TO_CHECK = 6;

export const newUsage = (now: number): Usage => ({
  installedAt: now,
  secsSinceCheck: 0,
  totalSecs: 0,
  lastCheckAt: null,
  checksDone: 0,
  baseline0Done: false,
  baseline14Done: false,
  followUpDone: false,
});

export function addPlaySeconds(usage: Usage, secs: number): Usage {
  return { ...usage, secsSinceCheck: usage.secsSinceCheck + secs, totalSecs: usage.totalSecs + secs };
}

export type Due = 'baseline14' | 'followup' | 'recall';

/** Which check, if any, is waiting. It never interrupts a show: this only decides what the panel offers. */
export function dueCheck(usage: Usage, shownItems: number, now: number): Due | null {
  const days = (now - usage.installedAt) / DAY_MS;
  if (days >= STUDY_DAYS && !usage.baseline14Done) return 'baseline14';
  if (days >= FOLLOW_UP_DAY && !usage.followUpDone && usage.checksDone >= 1) return 'followup';
  if (days >= STUDY_DAYS || days < MIN_GAP_DAYS) return null;
  if (usage.checksDone >= MAX_CHECKS) return null;
  if (usage.lastCheckAt !== null && now - usage.lastCheckAt < MIN_GAP_DAYS * DAY_MS) return null;
  if (usage.secsSinceCheck < MIN_WATCHED_SECS) return null;
  if (shownItems < MIN_ITEMS_TO_CHECK) return null;
  return 'recall';
}
