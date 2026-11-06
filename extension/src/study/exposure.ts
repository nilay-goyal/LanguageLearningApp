// What a learner has been shown, kept on their own device, for the recall checks.
//
// Every French unit of up to three words is counted, with the English words it replaced.
// Alongside, a sample of units the speed limit could have shown but didn't is kept as
// "held out": words picked the same way as the shown ones, but never shown, so they make
// a fair comparison for what people remember.

import type { ExposureBucket } from '../../../shared/protocol';

export interface ShownUnit {
  french: string;
  english: string;
  lemmas: string[];
  count: number;
  first: number;
  last: number;
}

export interface HeldOut {
  french: string;
  english: string;
  lemmas: string[];
}

export interface ExposureStore {
  shown: Record<string, ShownUnit>;
  pool: HeldOut[];
  /** How many held-out candidates have been offered, for sampling evenly. */
  offered: number;
}

export interface CheckItem {
  id: string;
  french: string;
  /** The English the French stood for: what a correct answer means. */
  gold: string;
  bucket: ExposureBucket;
  count: number;
  sinceLastDays: number | null;
  sinceFirstDays: number | null;
}

const DAY_MS = 24 * 3600 * 1000;
export const POOL_SIZE = 150;
const MAX_SHOWN = 5000;
const KEEP_AFTER_TRIM = 4500;

/** How many items a check takes from each group, and how many controls. */
const TARGETS: [ExposureBucket, number][] = [
  ['25+', 4],
  ['10-24', 3],
  ['3-9', 2],
];
const CONTROLS = 3;
/** Below this many shown words there isn't enough to test. */
export const MIN_SHOWN_ITEMS = 4;

const normalise = (text: string) => text.toLowerCase().normalize('NFC').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
export const unitKey = (french: string, english: string) => `${normalise(french)}|${normalise(english)}`;

export const emptyStore = (): ExposureStore => ({ shown: {}, pool: [], offered: 0 });

export function bucketOf(count: number): Exclude<ExposureBucket, 'control' | 'baseline'> {
  return count >= 25 ? '25+' : count >= 10 ? '10-24' : count >= 3 ? '3-9' : '1-2';
}

export function recordShown(store: ExposureStore, unit: { french: string; english: string; lemmas: string[] }, now: number): void {
  const key = unitKey(unit.french, unit.english);
  const existing = store.shown[key];
  if (existing) {
    existing.count++;
    existing.last = now;
    return;
  }
  store.shown[key] = { ...unit, count: 1, first: now, last: now };
  const keys = Object.keys(store.shown);
  if (keys.length > MAX_SHOWN) {
    // Forget the least-seen, longest-ago units first.
    const order = keys.sort((a, b) => store.shown[a]!.count - store.shown[b]!.count || store.shown[a]!.last - store.shown[b]!.last);
    for (const k of order.slice(0, keys.length - KEEP_AFTER_TRIM)) delete store.shown[k];
  }
}

/** Keeps an even sample of units that were available but not shown (reservoir sampling). */
export function offerHeldOut(store: ExposureStore, unit: HeldOut, rand: () => number): void {
  const key = unitKey(unit.french, unit.english);
  if (store.shown[key] || store.pool.some((h) => unitKey(h.french, h.english) === key)) return;
  store.offered++;
  if (store.pool.length < POOL_SIZE) {
    store.pool.push(unit);
    return;
  }
  const slot = Math.floor(rand() * store.offered);
  if (slot < POOL_SIZE) store.pool[slot] = unit;
}

function shuffle<T>(values: T[], rand: () => number): T[] {
  const out = [...values];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

export function shownItemCount(store: ExposureStore): number {
  return Object.keys(store.shown).length;
}

/** Twelve items when there is enough: shown words from three groups, and never-shown controls, mixed. */
export function pickCheckItems(store: ExposureStore, now: number, rand: () => number): CheckItem[] {
  const shown = Object.entries(store.shown)
    .filter(([, u]) => u.french.trim() && u.english.trim())
    .map(([key, u]) => ({ key, ...u }));
  const groups: Record<string, typeof shown> = { '25+': [], '10-24': [], '3-9': [], '1-2': [] };
  for (const u of shown) groups[bucketOf(u.count)]!.push(u);
  for (const g of Object.keys(groups)) groups[g] = shuffle(groups[g]!, rand);

  const picked: typeof shown = [];
  let shortfall = 0;
  for (const [bucket, n] of TARGETS) {
    const take = groups[bucket]!.splice(0, n);
    picked.push(...take);
    shortfall += n - take.length;
  }
  // If a group ran short, fill from what's left, most-seen first.
  for (const bucket of ['25+', '10-24', '3-9', '1-2']) {
    if (shortfall <= 0) break;
    const take = groups[bucket]!.splice(0, shortfall);
    picked.push(...take);
    shortfall -= take.length;
  }

  const items: CheckItem[] = picked.map((u) => ({
    id: u.key,
    french: u.french,
    gold: u.english,
    bucket: bucketOf(u.count),
    count: u.count,
    sinceLastDays: (now - u.last) / DAY_MS,
    sinceFirstDays: (now - u.first) / DAY_MS,
  }));

  // A control must share no word with anything the learner was shown.
  const shownLemmas = new Set(shown.flatMap((u) => u.lemmas));
  const eligible = store.pool.filter((h) => !store.shown[unitKey(h.french, h.english)] && !h.lemmas.some((l) => shownLemmas.has(l)));
  for (const h of shuffle(eligible, rand).slice(0, CONTROLS)) {
    items.push({ id: `control:${unitKey(h.french, h.english)}`, french: h.french, gold: h.english, bucket: 'control', count: 0, sinceLastDays: null, sinceFirstDays: null });
  }
  return shuffle(items, rand);
}
