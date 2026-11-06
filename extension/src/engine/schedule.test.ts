import { describe, expect, it } from 'vitest';
import { FRENCH } from './constants';
import { scheduledShares, targetDensity, tierLevel } from './schedule';

// Checkpoint table from "Speed Limit Algo.md" (h, p, RW, FUNC, SHORT, FULL, D*).
const CHECKPOINTS: [number, number, number, number, number, number, number][] = [
  [0, 1.0, 0.75, 0.25, 0, 0, 0.0552],
  [10, 1.5, 0.5, 0.5, 0, 0, 0.0696],
  [20, 1.542, 0.469, 0.51, 0.021, 0, 0.0731],
  [50, 1.669, 0.383, 0.539, 0.078, 0, 0.0827],
  [90, 1.839, 0.283, 0.572, 0.145, 0, 0.094],
  [100, 1.881, 0.26, 0.58, 0.16, 0, 0.0965],
  [175, 2.199, 0.131, 0.565, 0.304, 0, 0.1157],
  [250, 2.517, 0, 0.487, 0.504, 0.008, 0.141],
  [350, 2.941, 0, 0.229, 0.59, 0.181, 0.1779],
  [450, 3.364, 0, 0.063, 0.532, 0.405, 0.2119],
  [550, 3.788, 0, 0, 0.356, 0.644, 0.2375],
  [600, 4.0, 0, 0, 0.25, 0.75, 0.2375],
];

describe('S6r schedule', () => {
  it.each(CHECKPOINTS)('matches the documented checkpoint at %s h', (h, p, rw, func, short, full, d) => {
    expect(tierLevel(h, FRENCH)).toBeCloseTo(p, 3);
    const s = scheduledShares(h, FRENCH);
    expect(s[1]).toBeCloseTo(rw, 3);
    expect(s[2]).toBeCloseTo(func, 3);
    expect(s[3]).toBeCloseTo(short, 3);
    expect(s[4]).toBeCloseTo(full, 3);
    expect(targetDensity(h, FRENCH)).toBeCloseTo(d, 4);
  });

  it('reaches the 0.2375 target cap at about 542 h', () => {
    expect(targetDensity(540, FRENCH)).toBeLessThan(0.2375);
    expect(targetDensity(545, FRENCH)).toBe(0.2375);
  });

  it('stretches time for longer courses', () => {
    const chinese = { ...FRENCH, courseHours: 2200 };
    expect(tierLevel(2200, chinese)).toBe(4);
    expect(tierLevel(1100, chinese)).toBeCloseTo(tierLevel(300, FRENCH), 10);
  });
});
