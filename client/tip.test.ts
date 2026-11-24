import { describe, expect, it } from 'vitest';
import { place } from './tip';

const view = { left: 0, top: 0, width: 400, height: 300 };
const tip = { width: 100, height: 30 };

describe('where a tip goes', () => {
  it('under the element, centred on it', () => {
    expect(place({ left: 150, top: 100, width: 40, height: 40 }, tip, view)).toEqual({ x: 120, y: 146, above: false });
  });

  it('over it when there is no room under it', () => {
    expect(place({ left: 150, top: 250, width: 40, height: 40 }, tip, view)).toEqual({ x: 120, y: 214, above: true });
  });

  it('never past either side of the window', () => {
    expect(place({ left: 0, top: 10, width: 30, height: 30 }, tip, view).x).toBe(8);
    expect(place({ left: 380, top: 10, width: 20, height: 20 }, tip, view).x).toBe(292);
  });

  it('on screen when it fits neither under nor over: on the roomier side, held inside the window', () => {
    const tall = { width: 100, height: 200 };
    const p = place({ left: 150, top: 120, width: 40, height: 40 }, tall, view);
    expect(p.y).toBeGreaterThanOrEqual(8);
    expect(p.y + tall.height).toBeLessThanOrEqual(view.height - 8);
  });

  it('a tip wider than the window starts at its left margin', () => {
    expect(place({ left: 150, top: 10, width: 40, height: 40 }, { width: 500, height: 30 }, view).x).toBe(8);
  });
});

describe('a tip for a finger', () => {
  const tip = { width: 100, height: 30 };
  const view = { left: 0, top: 0, width: 400, height: 400 };
  it('goes over the element, clear of the finger', () => {
    expect(place({ left: 150, top: 100, width: 40, height: 40 }, tip, view, true)).toEqual({ x: 120, y: 64, above: true });
  });
  it('goes under it when there is no room over it', () => {
    expect(place({ left: 150, top: 10, width: 40, height: 40 }, tip, view, true)).toEqual({ x: 120, y: 56, above: false });
  });
});

describe('a tip on a page pinched in', () => {
  const seen = { left: 50, top: 120, width: 200, height: 300 };
  it('stands by its element, which is not where the window would put it', () => {
    expect(place({ left: 130, top: 300, width: 40, height: 40 }, tip, seen, true)).toEqual({ x: 100, y: 264, above: true });
  });
  it('stays inside what is seen, on every side', () => {
    expect(place({ left: 50, top: 200, width: 20, height: 20 }, tip, seen).x).toBe(58);
    expect(place({ left: 230, top: 200, width: 20, height: 20 }, tip, seen).x).toBe(142);
    expect(place({ left: 130, top: 125, width: 40, height: 10 }, tip, seen, true)).toMatchObject({ y: 141, above: false });
    expect(place({ left: 130, top: 400, width: 40, height: 15 }, tip, seen)).toMatchObject({ y: 364, above: true });
  });
});
