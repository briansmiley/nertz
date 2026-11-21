// Shots wait on the page's clock and are handed to the audio clock just before their moment: none is ever heard late,
// however long the page was away (a phone, in another app) while the audio clock stood still.
import { describe, expect, it } from 'vitest';
import { AHEAD_MS, LATE_MS, Pending, type Stop } from './pending';

/** Records each shot handed over: its moment (ms on the page's clock) and when it was handed over. */
function audio() {
  const given: { due: number; at: number; delay: number }[] = [];
  let now = 0;
  const shot = (due: number, cut: Stop = () => {}) => (delay: number) => (given.push({ due, at: now, delay }), cut);
  return { given, shot, at: (t: number) => (now = t) };
}

describe('Pending', () => {
  it('hands a shot near its moment to the audio clock at once', () => {
    const p = new Pending();
    const a = audio();
    p.add(0, 150, a.shot(150));
    expect(a.given).toEqual([{ due: 150, at: 0, delay: 0.15 }]);
    expect(p.next).toBeNull();
  });

  it('keeps one further ahead until just before its moment, then hands it over with the time that is left', () => {
    const p = new Pending();
    const a = audio();
    p.add(0, 1000, a.shot(1000));
    expect(p.next).toBe(1000 - AHEAD_MS);
    p.run(a.at(700));
    expect(a.given).toHaveLength(0);
    p.run(a.at(850));
    expect(a.given).toEqual([{ due: 1000, at: 850, delay: 0.15 }]);
    expect(p.next).toBeNull();
  });

  it('hands shots over earliest first, whatever order they were asked for in', () => {
    const p = new Pending();
    const a = audio();
    for (const due of [3000, 1000, 2000]) p.add(0, due, a.shot(due));
    expect(p.next).toBe(1000 - AHEAD_MS);
    for (let t = 0; t <= 3000; t += 100) p.run(a.at(t));
    expect(a.given.map((g) => g.due)).toEqual([1000, 2000, 3000]);
  });

  it('the wash, with the page away halfway through it: what came due while away is never heard, and the rest is in step', () => {
    const p = new Pending();
    const a = audio();
    const lands = Array.from({ length: 120 }, (_, k) => 1000 + k * 100); // a whisper every 100 ms, for 12 s
    for (const due of lands) p.add(0, due, a.shot(due));
    // The page looks at its timers every 50 ms, except from 3 s to 8 s, when it is in the background and nothing runs.
    for (let t = 0; t <= 14000; t += 50) if (t <= 3000 || t >= 8000) p.run(a.at(t));
    for (const g of a.given) {
      expect(g.at + g.delay * 1000).toBeCloseTo(Math.max(g.due, g.at)); // when it sounds is its moment...
      expect(g.at - g.due).toBeLessThanOrEqual(LATE_MS); // ...or, at the very most, a moment after it
    }
    const heard = a.given.map((g) => g.due);
    expect(heard.filter((d) => d > 3000 + AHEAD_MS && d < 8000 - LATE_MS)).toEqual([]);
    expect(heard.filter((d) => d <= 3000 + AHEAD_MS)).toEqual(lands.filter((d) => d <= 3000 + AHEAD_MS));
    expect(heard.filter((d) => d >= 8000)).toEqual(lands.filter((d) => d >= 8000));
    expect(p.next).toBeNull();
  });

  it('a shot stopped while it waits is never handed over; one stopped after is cut short', () => {
    const p = new Pending();
    const a = audio();
    let cut = 0;
    const waiting = p.add(0, 1000, a.shot(1000));
    const given = p.add(0, 2000, a.shot(2000, () => cut++));
    waiting();
    p.run(a.at(1000));
    p.run(a.at(1900));
    expect(a.given.map((g) => g.due)).toEqual([2000]);
    given();
    expect(cut).toBe(1);
    waiting(); // (and stopping one that is gone does nothing)
    expect(cut).toBe(1);
  });
});
