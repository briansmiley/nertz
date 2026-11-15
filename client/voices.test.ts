import { describe, expect, it } from 'vitest';
import { dealTimes } from './layout';
import { Voices } from './voices';

/** The longest flick: the longest recording (0.26 s) at the slowest rate a deal plays it (0.9). */
const FLICK = 0.261 / 0.9;

describe('Voices', () => {
  it('admits every flick of a full deal, though all are scheduled at once', () => {
    for (const work of [10, 7]) {
      const cap = new Voices(18);
      const starts = dealTimes(work);
      expect(starts.every((s) => cap.take(0, s, s + FLICK))).toBe(true);
      expect(Math.max(...starts.map((s) => cap.sounding(s)))).toBeLessThanOrEqual(6);
    }
  });

  it('still drops a real pile-up beyond the cap', () => {
    const cap = new Voices(18);
    const taken = Array.from({ length: 25 }, () => cap.take(0, 0.1, 0.4));
    expect(taken.filter(Boolean)).toHaveLength(18);
    expect(cap.sounding(0.2)).toBe(18);
  });

  it('turns away a shot now that would overlap shots already scheduled to start while it sounds', () => {
    const cap = new Voices(3);
    for (let i = 0; i < 3; i++) cap.take(0, 0.5, 0.8);
    expect(cap.take(0, 0, 0.4)).not.toBeNull();
    expect(cap.take(0, 0, 0.6)).toBeNull();
  });

  it('counts a shot cut short only until it was cut', () => {
    const cap = new Voices(1);
    const v = cap.take(0, 0, 1)!;
    expect(cap.take(0, 0.5, 0.7)).toBeNull();
    v.end = 0.3;
    expect(cap.take(0, 0.5, 0.7)).not.toBeNull();
  });

  it('forgets shots once they have ended', () => {
    const cap = new Voices(18);
    for (let s = 0; s < 1000; s++) cap.take(s, s, s + 0.3);
    expect(cap.size).toBe(1);
  });
});
