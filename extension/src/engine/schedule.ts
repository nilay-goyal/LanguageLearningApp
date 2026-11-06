import { DENSITY_TARGET_CAP, type LanguageProfile, type Tier, TIERS } from './constants';

/** Hours on the 600 h reference clock, so other course lengths stretch by T / 600. */
function referenceHours(h: number, profile: LanguageProfile): number {
  return (h * 600) / profile.courseHours;
}

/** Tier level p(h): 1 single words … 4 full sentences. */
export function tierLevel(h: number, profile: LanguageProfile): number {
  const r = referenceHours(h, profile);
  if (r <= 10) return 1 + 0.05 * r;
  if (r <= 600) return 1.5 + (2.5 * (r - 10)) / 590;
  return 4;
}

/** Scheduled share of switches per tier at hour h. */
export function scheduledShares(h: number, profile: LanguageProfile): Record<Tier, number> {
  const p = tierLevel(h, profile);
  const [w1, w2, w3, w4] = TIERS.map((i) => Math.max(0, 1 - Math.abs(p - i) / 1.5)) as [number, number, number, number];
  const total = w1 + w2 + w3 + w4;
  return { 1: w1 / total, 2: w2 / total, 3: w3 / total, 4: w4 / total };
}

/** Target L2 density D*(h), before the pace multiplier. */
export function targetDensity(h: number, profile: LanguageProfile): number {
  const s = scheduledShares(h, profile);
  const meanLength = TIERS.reduce((acc, i) => acc + s[i] * profile.unitLength[i], 0);
  const pace = 4 * profile.meanWordsPerLine; // W: words per switch at one switch every 4 lines
  return Math.min(DENSITY_TARGET_CAP, meanLength / pace);
}

/** Placement reads the schedule at the midpoint of each 1% of the course. */
export function placementHour(h: number, profile: LanguageProfile): number {
  const step = profile.courseHours / 100;
  return Math.floor(h / step) * step + step / 2;
}
