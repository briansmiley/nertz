import { describe, expect, it } from 'vitest';
import { SLOTS_PER_PLAYER } from './protocol';
import { cardSize, CARD_RATIO, clash, offFelt, onTable, openPlace, pileGap, roomAt, spots, TABLE, tiltAt, type Pt } from './table';

const COUNTS = [2, 3, 4, 5, 6];
function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
}
/** Somewhere in the box round the felt. */
const anywhere = (r: () => number, reach = 1): Pt => ({ x: (r() * 2 - 1) * TABLE.hw * reach, y: (r() * 2 - 1) * reach });

/** A card's rectangle with its middle at `p`, grown by `m` all round. */
const rect = (p: Pt, n: number, m = 0) => {
  const { w, h } = cardSize(n);
  return { l: p.x - w / 2 - m, r: p.x + w / 2 + m, t: p.y - h / 2 - m, b: p.y + h / 2 + m };
};
type R = ReturnType<typeof rect>;
const intersect = (a: R, b: R): boolean => a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b;
/** The four corners of a card at `p`. */
const corners = (p: Pt, n: number): Pt[] => {
  const c = rect(p, n);
  return [{ x: c.l, y: c.t }, { x: c.r, y: c.t }, { x: c.l, y: c.b }, { x: c.r, y: c.b }];
};
/** Is `p` on the felt, worked out the long way: in the cross of the two plain rectangles, or within the radius of a corner's centre. */
const onFelt = (p: Pt): boolean => {
  const [x, y] = [Math.abs(p.x), Math.abs(p.y)];
  if (x > TABLE.hw || y > 1) return false;
  if (x <= TABLE.hw - TABLE.corner || y <= 1 - TABLE.corner) return true;
  return Math.hypot(x - (TABLE.hw - TABLE.corner), y - (1 - TABLE.corner)) <= TABLE.corner;
};

describe('the felt', () => {
  it('is one wide shape with rounded corners, the same for any number of players', () => {
    expect(TABLE.hw).toBeGreaterThan(2);
    expect(TABLE.corner).toBeGreaterThan(0);
    expect(TABLE.corner).toBeLessThanOrEqual(1);
    const r = rng(1);
    for (let k = 0; k < 4000; k++) {
      const p = anywhere(r, 1.3);
      expect(offFelt(p) <= 0, `${p.x}, ${p.y}`).toBe(onFelt(p));
    }
    // A distance: so far inside in the middle, zero on the edge, so far outside beyond it.
    expect(offFelt({ x: 0, y: 0 })).toBeCloseTo(-1);
    expect(offFelt({ x: TABLE.hw, y: 0 })).toBeCloseTo(0);
    expect(offFelt({ x: 0, y: -1 })).toBeCloseTo(0);
    expect(offFelt({ x: 0, y: 1.5 })).toBeCloseTo(0.5);
    expect(offFelt({ x: -TABLE.hw - 2, y: 0 })).toBeCloseTo(2);
    expect(offFelt({ x: TABLE.hw, y: 1 })).toBeCloseTo(TABLE.corner * (Math.SQRT2 - 1)); // the corner of the box is cut off
  });

  it('gives a card the same shape for everyone, smaller the more players there are, never tiny', () => {
    for (const n of COUNTS) {
      const { w, h } = cardSize(n);
      expect(h / w).toBeCloseTo(CARD_RATIO); // one unit is one distance both ways: a card is card-shaped in table space
      expect(pileGap(n)).toBeGreaterThan(0);
      expect(pileGap(n)).toBeLessThan(w * 0.2); // a small gap
      if (n > 2) expect(w).toBeLessThanOrEqual(cardSize(n - 1).w);
      if (n > 3) expect(w).toBeLessThan(cardSize(n - 1).w);
      expect(w).toBeGreaterThan(0.3); // more than 0.15 of the felt's height: 42px where the felt is 280px high
      expect(1.5 * h + pileGap(n)).toBeLessThanOrEqual(0.9 + 1e-9); // a pile near the middle line leaves room above and below it
    }
    expect(cardSize(1)).toEqual(cardSize(2));
    expect(cardSize(9)).toEqual(cardSize(6));
    expect(cardSize(NaN)).toEqual(cardSize(2));
  });
});

describe('where piles may go', () => {
  it('two piles clash exactly when their cards, grown by half the gap each, overlap: what everyone sees', () => {
    for (const n of COUNTS) {
      const r = rng(n);
      const { w, h } = cardSize(n);
      const gap = pileGap(n);
      let clashes = 0;
      for (let k = 0; k < 3000; k++) {
        const [a, b] = [anywhere(r, 0.5), anywhere(r, 0.5)];
        const c = clash(a, b, n);
        if (c) clashes++;
        expect(clash(b, a, n)).toBe(c);
        expect(c).toBe(intersect(rect(a, n, gap / 2), rect(b, n, gap / 2)));
        // The same thing, as the table draws it: the one card against the other's keep-out (the card grown by the whole gap).
        expect(c).toBe(intersect(rect(a, n), rect(b, n, gap)));
        // It is about the two cards only: wherever on the table they are.
        expect(clash({ x: a.x + 1.3, y: a.y - 0.4 }, { x: b.x + 1.3, y: b.y - 0.4 }, n)).toBe(c);
      }
      expect(clashes).toBeGreaterThan(100);
      expect(clash({ x: 0, y: 0 }, { x: 0, y: 0 }, n)).toBe(true);
      // Side by side: touching is too close, the gap is enough. Likewise one above the other.
      expect(clash({ x: 0, y: 0 }, { x: w + gap * 0.99, y: 0 }, n)).toBe(true);
      expect(clash({ x: 0, y: 0 }, { x: w + gap * 1.01, y: 0 }, n)).toBe(false);
      expect(clash({ x: 0, y: 0 }, { x: 0, y: h + gap * 0.99 }, n)).toBe(true);
      expect(clash({ x: 0, y: 0 }, { x: 0, y: -(h + gap * 1.01) }, n)).toBe(false);
      // Clear one way is clear, however close the other way.
      expect(clash({ x: 0, y: 0 }, { x: w + gap * 1.01, y: h * 0.9 }, n)).toBe(false);
    }
  });

  it('a pile is on the table exactly when all four corners of its card are on the felt', () => {
    for (const n of COUNTS) {
      const { w, h } = cardSize(n);
      const r = rng(50 + n);
      let on = 0;
      for (let k = 0; k < 4000; k++) {
        const p = anywhere(r, 1.1);
        const inside = corners(p, n).every(onFelt);
        if (inside) on++;
        expect(onTable(p, n), `${n}: ${p.x}, ${p.y}`).toBe(inside);
      }
      expect(on).toBeGreaterThan(1000);
      expect(onTable({ x: 0, y: 0 }, n)).toBe(true);
      // Right up to the edge, and not over it.
      expect(onTable({ x: 0, y: 1 - h / 2 }, n)).toBe(true);
      expect(onTable({ x: 0, y: 1 - h / 2 + 0.002 }, n)).toBe(false);
      expect(onTable({ x: -(TABLE.hw - w / 2), y: 0 }, n)).toBe(true);
      expect(onTable({ x: -(TABLE.hw - w / 2) - 0.002, y: 0 }, n)).toBe(false);
      expect(onTable({ x: TABLE.hw - w / 2, y: 1 - h / 2 }, n)).toBe(false); // the corner of the box is rounded off
      for (const bad of [NaN, Infinity, -Infinity]) {
        expect(onTable({ x: bad, y: 0 }, n)).toBe(false);
        expect(onTable({ x: 0, y: bad }, n)).toBe(false);
      }
    }
  });

  it('nearly all of the felt can be used: wherever there is visibly room for a card, a pile may go', () => {
    for (const n of COUNTS) {
      const { w, h } = cardSize(n);
      const step = 0.02;
      let felt = 0;
      let covered = 0;
      for (let x = -TABLE.hw; x <= TABLE.hw; x += step) {
        for (let y = -1; y <= 1; y += step) {
          if (offFelt({ x, y }) > 0) continue;
          felt++;
          // Can some pile on an empty table cover this point of the felt? Try the card with this point at its
          // middle, and at each of its edges and corners on the side away from the middle of the table.
          const tries = [0, w / 2 - 1e-6].flatMap((dx) => [0, h / 2 - 1e-6].map((dy) => ({ x: x - Math.sign(x) * dx, y: y - Math.sign(y) * dy })));
          if (tries.some((p) => roomAt(p, [], n))) covered++;
        }
      }
      expect(covered / felt, `${n} players`).toBeGreaterThan(0.97); // (asked for: more than 0.85)
      // And the rule is exactly the shape: no place where a card fits on the felt is refused, none where it does not is allowed.
      const r = rng(70 + n);
      for (let k = 0; k < 2000; k++) {
        const p = anywhere(r);
        expect(roomAt(p, [], n)).toBe(corners(p, n).every(onFelt));
      }
    }
  });

  it('beside one pile there is room again a card and a gap away: one pile shuts off no more than that', () => {
    for (const n of COUNTS) {
      const { w, h } = cardSize(n);
      const gap = pileGap(n);
      const pile = { x: 0, y: 0 };
      expect(roomAt({ x: w + gap + 0.001, y: 0 }, [pile], n)).toBe(true);
      expect(roomAt({ x: -(w + gap + 0.001), y: h / 3 }, [pile], n)).toBe(true);
      expect(roomAt({ x: w * 0.3, y: h + gap + 0.001 }, [pile], n)).toBe(true); // (even under a pile in the very middle, with the largest cards)
      expect(roomAt({ x: w + gap - 0.001, y: 0 }, [pile], n)).toBe(false);
      // The share of the felt's places that one pile takes away: about four cards' worth, a few per cent.
      const r = rng(90 + n);
      let free = 0;
      let shut = 0;
      for (let k = 0; k < 6000; k++) {
        const p = anywhere(r);
        if (!roomAt(p, [], n)) continue;
        free++;
        if (!roomAt(p, [pile], n)) shut++;
      }
      expect(shut / free, `${n} players`).toBeLessThan(0.22);
      expect(shut / free).toBeGreaterThan(0.02);
    }
  });

  it('there is room on a free table for every pile the round can have, even put down carelessly', () => {
    for (const n of COUNTS) {
      const all = SLOTS_PER_PLAYER * n;
      // Tidy: always the nearest clear place to the middle. Room for half as many again.
      const tidy: Pt[] = [];
      for (let at = openPlace(tidy, n); at && tidy.length < 60; at = openPlace(tidy, n)) {
        expect(roomAt(at, tidy, n)).toBe(true);
        tidy.push(at);
      }
      expect(tidy.length, `${n} players, tidy`).toBeGreaterThanOrEqual(all * 1.5);
      // One careless row: piles along the middle line, a little up and down, with wasteful spaces between. There is
      // still room for the rest above and below it.
      const row: Pt[] = [];
      const { w } = cardSize(n);
      const jog = rng(40 + n);
      for (let x = -TABLE.hw + w; x < TABLE.hw - w; x += w * 1.7) row.push({ x, y: (jog() - 0.5) * 0.18 });
      expect(row.every((p, i) => roomAt(p, row.slice(0, i), n))).toBe(true);
      for (let at = openPlace(row, n); at && row.length < 60; at = openPlace(row, n)) row.push(at);
      expect(row.length, `${n} players, after a careless row`).toBeGreaterThanOrEqual(all);
      // Careless: each pile anywhere at random that happens to be free. All four per player fit, nearly every time.
      const r = rng(100 + n);
      const trials = 60;
      let full = 0;
      let fitted = 0;
      for (let t = 0; t < trials; t++) {
        const placed: Pt[] = [];
        for (let k = 0; k < 4000 && placed.length < all; k++) {
          const p = anywhere(r);
          if (roomAt(p, placed, n)) placed.push(p);
        }
        fitted += placed.length;
        if (placed.length === all) full++;
      }
      expect(full / trials, `${n} players, careless`).toBeGreaterThanOrEqual(0.9);
      expect(fitted / trials).toBeGreaterThan(all * 0.98);
    }
  });

  it('openPlace finds the clear place nearest to where it is asked, or says the table is full', () => {
    const n = 4;
    expect(openPlace([], n)).toEqual({ x: 0, y: 0 });
    const near = openPlace([], n, { x: 1.4, y: -0.3 })!;
    expect(Math.hypot(near.x - 1.4, near.y + 0.3)).toBeLessThan(0.05);
    const taken = [{ x: 0, y: 0 }];
    const next = openPlace(taken, n)!;
    expect(clash(next, taken[0]!, n)).toBe(false);
    expect(openPlace(taken, n)).toEqual(next); // deterministic
    const full: Pt[] = [];
    for (let at = openPlace(full, n); at; at = openPlace(full, n)) full.push(at);
    expect(openPlace(full, n)).toBeNull();
    expect(openPlace(full, n, { x: 0.2, y: 0.2 })).toBeNull();
    expect(roomAt({ x: 0.2, y: 0.2 }, full, n)).toBe(false);
  });

  it('a pile started somewhere gets a small tilt that depends only on where', () => {
    expect(tiltAt({ x: 0.123, y: -0.4 })).toBe(tiltAt({ x: 0.123, y: -0.4 }));
    const tilts = [0.1, 0.2, 0.3, 0.4, 0.5].map((x) => tiltAt({ x, y: 0.1 }));
    expect(new Set(tilts).size).toBeGreaterThan(2);
    for (const t of tilts) expect(Math.abs(t)).toBeLessThanOrEqual(2.5);
  });
});

describe('the marked places', () => {
  it('are four per player, on the table, no two clashing, the same every time', () => {
    for (const n of COUNTS) {
      const s = spots(n);
      expect(s).toHaveLength(SLOTS_PER_PLAYER * n);
      expect(spots(n)).toEqual(s); // deterministic
      for (const [i, a] of s.entries()) {
        expect(onTable(a, n), `${n} players, spot ${i}`).toBe(true);
        expect(Math.abs(a.r)).toBeLessThanOrEqual(2.5);
        for (const [j, b] of s.entries()) if (j > i) expect(clash(a, b, n), `${n} players, spots ${i} and ${j}`).toBe(false);
        // Tilted as far as it is, a card still keeps clear of its neighbours and on the felt.
        const lean = Math.sin((2.5 * Math.PI) / 180) * (cardSize(n).h / 2);
        expect(lean).toBeLessThan(pileGap(n) / 2);
      }
    }
  });

  it('are a loose cluster about the middle: rows, but not a single row, not a ruled grid, and not the whole felt', () => {
    for (const n of COUNTS) {
      const s = spots(n);
      const { w, h } = cardSize(n);
      // About the middle.
      const mid = { x: s.reduce((a, p) => a + p.x, 0) / s.length, y: s.reduce((a, p) => a + p.y, 0) / s.length };
      expect(Math.abs(mid.x)).toBeLessThan(w * 0.5);
      expect(Math.abs(mid.y)).toBeLessThan(h * 0.2);
      // More than one row (places a card apart in height), and no row or column ruled straight.
      const rows = new Set(s.map((p) => Math.round(p.y / h)));
      expect(rows.size).toBeGreaterThan(1);
      expect(new Set(s.map((p) => p.y)).size).toBeGreaterThan(s.length * 0.7);
      expect(new Set(s.map((p) => p.x)).size).toBeGreaterThan(s.length * 0.7);
      // Neighbouring rows are staggered: no place sits squarely above another.
      for (const a of s) for (const b of s) if (a !== b && Math.abs(a.y - b.y) > h * 0.5 && Math.abs(a.y - b.y) < h * 1.5) expect(Math.abs(a.x - b.x)).toBeGreaterThan(w * 0.2);
      // Compact: everyone can reach it, and there is felt left round it.
      expect(Math.max(...s.map((p) => Math.abs(p.x))) + w / 2).toBeLessThan(TABLE.hw * 0.85);
      // Every place has a neighbour close by.
      for (const a of s) expect(Math.min(...s.filter((b) => b !== a).map((b) => Math.hypot(a.x - b.x, a.y - b.y)))).toBeLessThan(h * 1.5);
    }
  });
});
