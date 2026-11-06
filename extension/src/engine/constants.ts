// Constants from "05 Documentation V2/Speed Limit Algo.md" (S6r, French, corpus order 101).

export type Tier = 1 | 2 | 3 | 4; // 1 single word, 2 functional phrase, 3 short phrase, 4 full sentence
export const TIERS: readonly Tier[] = [1, 2, 3, 4];
export const TIER_NAMES: Record<Tier, string> = { 1: 'RW', 2: 'FUNC', 3: 'SHORT', 4: 'FULL' };

export interface LanguageProfile {
  /** Course length in viewing hours (FSI hours for the target language). */
  courseHours: number;
  /** Mean non-punctuation words per subtitle line. */
  meanWordsPerLine: number;
  /** Mean unit length in English tokens for RW / FUNC / SHORT / FULL. */
  unitLength: Record<Tier, number>;
}

export const FRENCH: LanguageProfile = {
  courseHours: 600,
  meanWordsPerLine: 6.121,
  unitLength: { 1: 1, 2: 2.409, 3: 4.408, 4: 6.651 },
};

// Spanish is also a 600 h course; m and unit lengths are re-measured once real
// Spanish candidates are cached. Until then it uses the French measurements.
export const SPANISH: LanguageProfile = { ...FRENCH };

export const WORDS_PER_HOUR = 8400; // 140 words per minute
export const DENSITY_TARGET_CAP = 0.2375; // 95% of the 0.25 cap
export const DENSITY_CAP = 0.25;
export const DENSITY_WINDOW_LINES = 100;
export const CREDIT_CAP = 20;
export const TICK_WORDS = 20; // one tick per 20 words parsed
export const TICK_CAP = 10;
export const RETAINED_AT = 25; // showings until a lemma is retained
export const LEDGER_SIZE = 40;
export const SPACING_TOKENS = 10;
export const MAX_SWITCHES_PER_LINE = 2;
export const RESERVE: Record<Tier, number> = { 1: 1, 2: 3, 3: 5, 4: 8 };
