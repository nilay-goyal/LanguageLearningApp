import { describe, expect, it } from 'vitest';
import { mulberry } from './testing';
import { BASELINE_WORDS } from './baseline';
import {
  bucketOf,
  emptyStore,
  type ExposureStore,
  offerHeldOut,
  pickCheckItems,
  POOL_SIZE,
  recordShown,
  shownItemCount,
  unitKey,
} from './exposure';
import { DAY_MS, dueCheck, MAX_CHECKS, newUsage, type Usage } from './usage';

const NOW = Date.UTC(2026, 10, 20, 12);
const unit = (french: string, english: string, lemmas = [french]) => ({ french, english, lemmas });

function show(store: ExposureStore, french: string, english: string, times: number, at = NOW) {
  for (let i = 0; i < times; i++) recordShown(store, unit(french, english), at - (times - i) * 1000);
}

describe('exposure ledger', () => {
  it('counts showings of the same unit, however it is cased or punctuated', () => {
    const store = emptyStore();
    recordShown(store, unit('Mes clés', 'my keys'), NOW);
    recordShown(store, unit('mes clés.', 'My keys'), NOW + 1000);
    expect(shownItemCount(store)).toBe(1);
    const entry = store.shown[unitKey('mes clés', 'my keys')]!;
    expect(entry.count).toBe(2);
    expect(entry.first).toBe(NOW);
    expect(entry.last).toBe(NOW + 1000);
  });

  it('sorts counts into the groups the study reports', () => {
    expect([1, 2, 3, 9, 10, 24, 25, 80].map(bucketOf)).toEqual(['1-2', '1-2', '3-9', '3-9', '10-24', '10-24', '25+', '25+']);
  });

  it('forgets the least-seen units when it gets too big, and keeps the well-known ones', () => {
    const store = emptyStore();
    show(store, 'toujours', 'always', 30);
    for (let i = 0; i < 5100; i++) recordShown(store, unit(`mot${i}`, `word${i}`), NOW + i);
    expect(shownItemCount(store)).toBeLessThanOrEqual(5000);
    expect(store.shown[unitKey('toujours', 'always')]!.count).toBe(30);
  });
});

describe('held-out controls', () => {
  it('keeps at most the pool size, drawn from everything offered', () => {
    const store = emptyStore();
    const rand = mulberry(7);
    for (let i = 0; i < 1000; i++) offerHeldOut(store, unit(`mot${i}`, `word${i}`), rand);
    expect(store.pool).toHaveLength(POOL_SIZE);
    const late = store.pool.filter((h) => Number(h.french.slice(3)) >= 500).length;
    // About half should come from the second half of the offers.
    expect(late).toBeGreaterThan(POOL_SIZE * 0.3);
    expect(late).toBeLessThan(POOL_SIZE * 0.7);
  });

  it('ignores a unit already shown or already in the pool', () => {
    const store = emptyStore();
    recordShown(store, unit('maison', 'house'), NOW);
    offerHeldOut(store, unit('maison', 'house'), Math.random);
    offerHeldOut(store, unit('chien', 'dog'), Math.random);
    offerHeldOut(store, unit('chien', 'dog'), Math.random);
    expect(store.pool.map((h) => h.french)).toEqual(['chien']);
  });
});

describe('picking check items', () => {
  function fullStore() {
    const store = emptyStore();
    for (let i = 0; i < 6; i++) show(store, `haut${i}`, `high${i}`, 30 + i);
    for (let i = 0; i < 5; i++) show(store, `moyen${i}`, `mid${i}`, 12 + i);
    for (let i = 0; i < 4; i++) show(store, `bas${i}`, `low${i}`, 4 + i);
    for (let i = 0; i < 3; i++) show(store, `rare${i}`, `rare${i}`, 1);
    for (let i = 0; i < 20; i++) offerHeldOut(store, unit(`libre${i}`, `free${i}`), mulberry(i));
    return store;
  }

  it('takes 4, 3 and 2 from the groups and adds 3 controls', () => {
    const items = pickCheckItems(fullStore(), NOW, mulberry(1));
    const count = (b: string) => items.filter((i) => i.bucket === b).length;
    expect([count('25+'), count('10-24'), count('3-9'), count('control')]).toEqual([4, 3, 2, 3]);
    expect(items).toHaveLength(12);
  });

  it('records how often and how long ago each word was shown', () => {
    const store = emptyStore();
    show(store, 'toujours', 'always', 26, NOW - 3 * DAY_MS);
    const [item] = pickCheckItems(store, NOW, mulberry(1)).filter((i) => i.bucket === '25+');
    expect(item!.count).toBe(26);
    expect(item!.sinceLastDays).toBeCloseTo(3, 1);
    expect(item!.gold).toBe('always');
  });

  it('fills from other groups when one runs short', () => {
    const store = emptyStore();
    for (let i = 0; i < 8; i++) show(store, `bas${i}`, `low${i}`, 4);
    const shown = pickCheckItems(store, NOW, mulberry(2)).filter((i) => i.bucket !== 'control');
    // Only 8 exist, and all of them are used even though the 25+ and 10-24 groups are empty.
    expect(shown).toHaveLength(8);
  });

  it('never uses a control that shares a word with something that was shown', () => {
    const store = emptyStore();
    recordShown(store, unit('la maison', 'the house', ['le', 'maison']), NOW);
    offerHeldOut(store, unit('ma maison', 'my house', ['mon', 'maison']), Math.random);
    offerHeldOut(store, unit('le chien', 'the dog', ['le', 'chien']), Math.random);
    offerHeldOut(store, unit('un oiseau', 'a bird', ['un', 'oiseau']), Math.random);
    const controls = pickCheckItems(store, NOW, mulberry(3)).filter((i) => i.bucket === 'control');
    expect(controls.map((c) => c.french)).toEqual(['un oiseau']);
  });

  it('gives different controls and order for different draws, but the same for the same draw', () => {
    const a = pickCheckItems(fullStore(), NOW, mulberry(5)).map((i) => i.id);
    const b = pickCheckItems(fullStore(), NOW, mulberry(5)).map((i) => i.id);
    const c = pickCheckItems(fullStore(), NOW, mulberry(6)).map((i) => i.id);
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });
});

describe('when a check is due', () => {
  const ready = (over: Partial<Usage> = {}): Usage => ({ ...newUsage(NOW - 4 * DAY_MS), secsSinceCheck: 3600, ...over });

  it('is not due in the first two days, or with too little use, or too few words', () => {
    expect(dueCheck({ ...ready(), installedAt: NOW - DAY_MS }, 30, NOW)).toBeNull();
    expect(dueCheck(ready({ secsSinceCheck: 600 }), 30, NOW)).toBeNull();
    expect(dueCheck(ready(), 3, NOW)).toBeNull();
  });

  it('is due after two days with enough use and words', () => {
    expect(dueCheck(ready(), 30, NOW)).toBe('recall');
  });

  it('waits two days after the last check, and stops after five', () => {
    expect(dueCheck(ready({ lastCheckAt: NOW - DAY_MS, checksDone: 1 }), 30, NOW)).toBeNull();
    expect(dueCheck(ready({ lastCheckAt: NOW - 3 * DAY_MS, checksDone: 1 }), 30, NOW)).toBe('recall');
    expect(dueCheck(ready({ lastCheckAt: NOW - 3 * DAY_MS, checksDone: MAX_CHECKS }), 30, NOW)).toBeNull();
  });

  it('asks for the day-14 baseline, then the day-21 follow-up only after a check', () => {
    const day14 = ready({ installedAt: NOW - 14 * DAY_MS, checksDone: 3 });
    expect(dueCheck(day14, 30, NOW)).toBe('baseline14');
    expect(dueCheck({ ...day14, baseline14Done: true }, 30, NOW)).toBeNull();
    const day21 = { ...day14, installedAt: NOW - 21 * DAY_MS, baseline14Done: true };
    expect(dueCheck(day21, 30, NOW)).toBe('followup');
    expect(dueCheck({ ...day21, checksDone: 0 }, 30, NOW)).toBeNull();
    expect(dueCheck({ ...day21, followUpDone: true }, 30, NOW)).toBeNull();
  });
});

describe('baseline words', () => {
  it('are twenty distinct words with meanings', () => {
    expect(BASELINE_WORDS).toHaveLength(20);
    expect(new Set(BASELINE_WORDS.map((w) => w.french)).size).toBe(20);
    expect(BASELINE_WORDS.every((w) => w.gold.length > 1)).toBe(true);
  });
});
