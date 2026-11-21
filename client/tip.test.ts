import { describe, expect, it } from 'vitest';
import { place } from './tip';

const view = { width: 400, height: 300 };
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
