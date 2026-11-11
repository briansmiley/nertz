import { describe, expect, it } from 'vitest';
import { SLOTS_PER_PLAYER } from './protocol';
import { cardSize, CARD_RATIO, clash, fromView, onDisc, openPlace, roomAt, rotate, seatAngle, seatDir, spots, tableAspect, tiltAt, toView, type Pt, type TableMode } from './table';

const COUNTS = [2, 3, 4, 5, 6];
const MODES: TableMode[] = ['spots', 'free'];
const close = (a: Pt, b: Pt, digits = 9) => {
  expect(a.x).toBeCloseTo(b.x, digits);
  expect(a.y).toBeCloseTo(b.y, digits);
};
function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
}
/** Would two upright cards at these places of ONE view touch? (What `clash` asks of every view.) */
const touchIn = (a: Pt, b: Pt, n: number, mode: TableMode) => {
  const { w, h } = cardSize(n, mode);
  return Math.abs(a.x - b.x) < w && Math.abs(a.y - b.y) < h;
};

describe('seats around the table', () => {
  it('are evenly spaced, clockwise from seat 0, which sits straight down the y axis', () => {
    for (const n of COUNTS) {
      close(seatDir(0, n), { x: 0, y: 1 });
      for (let i = 0; i < n; i++) {
        expect(seatAngle(i, n)).toBeCloseTo((2 * Math.PI * i) / n);
        expect(Math.hypot(seatDir(i, n).x, seatDir(i, n).y)).toBeCloseTo(1);
        // Every neighbour is the same angle on: the dot product of adjacent directions is cos(2 pi / n).
        const [a, b] = [seatDir(i, n), seatDir((i + 1) % n, n)];
        expect(a.x * b.x + a.y * b.y).toBeCloseTo(Math.cos((2 * Math.PI) / n));
      }
    }
    // Clockwise as drawn (y down the screen): with four players the next one sits to the left, then opposite, then right.
    close(seatDir(1, 4), { x: -1, y: 0 });
    close(seatDir(2, 4), { x: 0, y: -1 });
    close(seatDir(3, 4), { x: 1, y: 0 });
  });

  it('each player sees their own seat at the bottom, and the same neighbours in the same order', () => {
    for (const n of COUNTS) {
      for (let me = 0; me < n; me++) {
        close(toView(seatDir(me, n), me, n), { x: 0, y: 1 });
        // Whoever sits k places on from me is where player k is for player 0.
        for (let k = 1; k < n; k++) close(toView(seatDir((me + k) % n, n), me, n), seatDir(k, n));
      }
    }
  });

  it("one player's bottom is the opposite player's top", () => {
    for (const n of [2, 4, 6]) {
      for (let a = 0; a < n; a++) {
        const b = (a + n / 2) % n;
        close(toView(seatDir(a, n), b, n), { x: 0, y: -1 });
        // And any point of the table is seen the other way up: nearest to me is farthest from them.
        for (const p of [{ x: 0.3, y: 0.7 }, { x: -0.5, y: 0.1 }]) {
          const [mine, theirs] = [toView(p, a, n), toView(p, b, n)];
          close(theirs, { x: -mine.x, y: -mine.y });
        }
      }
    }
  });
});

describe('views', () => {
  it('turning to a view and back is the identity, on the disc and off it, and keeps distances', () => {
    const r = rng(3);
    for (const n of COUNTS) {
      for (let i = 0; i < n; i++) {
        for (let k = 0; k < 40; k++) {
          const p = { x: r() * 4 - 2, y: r() * 4 - 2 };
          const v = toView(p, i, n);
          close(fromView(v, i, n), p);
          close(toView(fromView(p, i, n), i, n), p);
          expect(Math.hypot(v.x, v.y)).toBeCloseTo(Math.hypot(p.x, p.y)); // so the disc maps onto the disc, one to one
        }
      }
      close(toView({ x: 0, y: 0 }, 1, n), { x: 0, y: 0 });
    }
    close(rotate({ x: 1, y: 0 }, Math.PI / 2), { x: 0, y: 1 });
  });

  it('a card is the same shape on every table: 1.4 times as high as wide once the drawing is stretched', () => {
    for (const n of COUNTS) {
      for (const mode of MODES) {
        const { w, h } = cardSize(n, mode);
        expect(h / w / tableAspect(n)).toBeCloseTo(CARD_RATIO);
      }
      expect(cardSize(n, 'free').w).toBeLessThan(cardSize(n, 'spots').w);
      expect(tableAspect(n)).toBeGreaterThan(1);
    }
  });
});

describe('fixed spots', () => {
  it('are four per player, on the disc, clear of each other in every view, and always the same', () => {
    for (const n of COUNTS) {
      const s = spots(n);
      expect(s).toHaveLength(SLOTS_PER_PLAYER * n);
      expect(spots(n)).toEqual(s); // deterministic
      for (const [i, a] of s.entries()) {
        expect(onDisc(a, n), `${n} players, spot ${i}`).toBe(true);
        expect(Math.abs(a.r)).toBeLessThanOrEqual(2.5);
        for (const [j, b] of s.entries()) {
          if (j <= i) continue;
          expect(clash(a, b, n), `${n} players, spots ${i} and ${j}`).toBe(false);
          // Spelled out: in every seat's view the two upright cards do not touch.
          for (let seat = 0; seat < n; seat++) expect(touchIn(toView(a, seat, n), toView(b, seat, n), n, 'spots')).toBe(false);
        }
      }
      // A loose cluster: not one row, and not all on a few lines of a grid.
      expect(new Set(s.map((p) => p.y.toFixed(2))).size).toBeGreaterThan(n);
      expect(new Set(s.map((p) => p.x.toFixed(2))).size).toBeGreaterThan(n);
      expect(s.some((p) => p.r !== 0)).toBe(true);
    }
  });

  it('look the same from every chair: each seat has four spots laid out alike in front of it', () => {
    for (const n of COUNTS) {
      const s = spots(n);
      const { w, h } = cardSize(n);
      for (let seat = 1; seat < n; seat++) {
        // Turned by one seat, every spot lands on (very nearly: they are nudged off their marks) another spot.
        for (const p of s) {
          const turned = toView(p, seat, n);
          expect(s.some((q) => Math.abs(q.x - turned.x) < 0.2 * w + 0.01 && Math.abs(q.y - turned.y) < 0.2 * h + 0.01)).toBe(true);
        }
      }
    }
  });
});

describe('placing piles freely', () => {
  it('clash is symmetric, the same whoever asks, and exactly "the cards would touch on somebody\'s screen"', () => {
    const r = rng(11);
    for (const n of COUNTS) {
      for (const mode of MODES) {
        const { w, h } = cardSize(n, mode);
        let clashes = 0;
        for (let k = 0; k < 400; k++) {
          const a = { x: r() * 1.6 - 0.8, y: r() * 1.6 - 0.8 };
          const b = { x: a.x + (r() - 0.5) * 4 * h, y: a.y + (r() - 0.5) * 4 * h };
          const c = clash(a, b, n, mode);
          if (c) clashes++;
          expect(clash(b, a, n, mode)).toBe(c);
          // Turning the whole table by a seat changes nothing.
          expect(clash(fromView(a, 1, n), fromView(b, 1, n), n, mode)).toBe(c);
          // Cards that touch in some view always clash; cards that clear every view by a gap never do.
          const touching = Array.from({ length: n }, (_, i) => touchIn(toView(a, i, n), toView(b, i, n), n, mode)).some(Boolean);
          if (touching) expect(c).toBe(true);
          if (Math.hypot(a.x - b.x, a.y - b.y) > Math.hypot(w, h) * 1.2) expect(c).toBe(false);
        }
        expect(clashes).toBeGreaterThan(20);
        expect(clash({ x: 0, y: 0 }, { x: 0, y: 0 }, n, mode)).toBe(true);
        // Side by side in my view: one card width plus the gap apart is enough, one card width is not.
        expect(clash({ x: 0, y: 0 }, { x: w * 1.01, y: 0 }, n, mode)).toBe(true);
        expect(clash({ x: 0, y: 0 }, { x: h * 1.3, y: h * 1.3 }, n, mode)).toBe(false);
      }
    }
  });

  it('a pile must lie on the disc with its whole card, in every view', () => {
    for (const n of COUNTS) {
      for (const mode of MODES) {
        const { w, h } = cardSize(n, mode);
        expect(onDisc({ x: 0, y: 0 }, n, mode)).toBe(true);
        expect(onDisc({ x: 1, y: 0 }, n, mode)).toBe(false); // centre on the rim: half the card hangs off
        expect(onDisc({ x: 0, y: 1 - h / 2 + 0.01 }, n, mode)).toBe(false);
        expect(onDisc({ x: 0, y: 1 - h / 2 - 0.01 }, n, mode)).toBe(true);
        expect(onDisc({ x: 1.5, y: 1.5 }, n, mode)).toBe(false);
        for (const bad of [NaN, Infinity, -Infinity]) expect(onDisc({ x: bad, y: 0 }, n, mode)).toBe(false);
        // Spelled out for random points: all four corners inside the unit circle, from every chair.
        const r = rng(n);
        for (let k = 0; k < 200; k++) {
          const p = { x: r() * 2 - 1, y: r() * 2 - 1 };
          const inside = Array.from({ length: n }, (_, i) => toView(p, i, n)).every((v) => Math.hypot(Math.abs(v.x) + w / 2, Math.abs(v.y) + h / 2) <= 1);
          expect(onDisc(p, n, mode)).toBe(inside);
        }
      }
    }
  });

  it('there is room on a free table for every pile the round can have, even put down carelessly', () => {
    for (const n of COUNTS) {
      // Tidy: always the nearest clear place to the middle.
      const tidy: Pt[] = [];
      for (let at = openPlace(tidy, n); at && tidy.length < 30; at = openPlace(tidy, n)) {
        expect(roomAt(at, tidy, n)).toBe(true);
        tidy.push(at);
      }
      expect(tidy.length).toBeGreaterThanOrEqual(SLOTS_PER_PLAYER * n);
      // Careless: anywhere at random that happens to be free. Nearly all of them still fit.
      const r = rng(100 + n);
      let fitted = 0;
      const trials = 20;
      for (let t = 0; t < trials; t++) {
        const placed: Pt[] = [];
        for (let k = 0; k < 3000 && placed.length < SLOTS_PER_PLAYER * n; k++) {
          const p = { x: r() * 2 - 1, y: r() * 2 - 1 };
          if (roomAt(p, placed, n)) placed.push(p);
        }
        fitted += placed.length;
      }
      expect(fitted / trials).toBeGreaterThan(SLOTS_PER_PLAYER * n * 0.9);
    }
  });

  it('openPlace finds the clear place nearest to where it is asked, or says the table is full', () => {
    const n = 4;
    expect(openPlace([], n)).toEqual({ x: 0, y: 0 });
    const near = openPlace([], n, 'free', { x: 0.4, y: -0.3 })!;
    expect(Math.hypot(near.x - 0.4, near.y + 0.3)).toBeLessThan(0.05);
    const taken = [{ x: 0, y: 0 }];
    const next = openPlace(taken, n)!;
    expect(clash(next, taken[0]!, n, 'free')).toBe(false);
    expect(openPlace(taken, n)).toEqual(next); // deterministic
    const full: Pt[] = [];
    for (let at = openPlace(full, n); at; at = openPlace(full, n)) full.push(at);
    expect(openPlace(full, n)).toBeNull();
    expect(openPlace(full, n, 'free', { x: 0.2, y: 0.2 })).toBeNull();
    expect(roomAt({ x: 0.2, y: 0.2 }, full, n)).toBe(false);
  });

  it('a pile started somewhere gets a small tilt that depends only on where', () => {
    expect(tiltAt({ x: 0.123, y: -0.4 })).toBe(tiltAt({ x: 0.123, y: -0.4 }));
    const tilts = [0.1, 0.2, 0.3, 0.4, 0.5].map((x) => tiltAt({ x, y: 0.1 }));
    expect(new Set(tilts).size).toBeGreaterThan(2);
    for (const t of tilts) expect(Math.abs(t)).toBeLessThanOrEqual(2.5);
  });
});
