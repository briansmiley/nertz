// The table, defined once for everybody. Pure geometry: no IO, no randomness.
//
// TABLE SPACE. The middle of the table is the unit disc: centre (0, 0), radius
// 1, y pointing towards seat 0. The players of a round sit around it at evenly
// spaced angles, in the order of `GameState.players`: player i of n looks at
// the centre from direction `seatDir(i, n)`. A centre pile is a point of the
// disc, the same point for everyone.
//
// A VIEW is that same table turned so that the viewer's own seat is at the
// bottom (`toView`), exactly like sitting at a real table: the pile nearest
// me is the farthest from the player opposite. Only positions turn. Cards are
// always drawn upright for whoever is looking.
//
// THE DRAWING. A window is wider than it is tall, so a client draws the disc
// as an ellipse `aspect` times as wide as it is high, like a round table seen
// from a chair: a view point (x, y) is drawn at (cx + x * rx, cy + y * ry)
// with rx = aspect * ry (see `toScreen` in client/layout.ts). That is a linear
// map, so every point of the disc has exactly one place on every screen and
// back. `aspect` depends only on the number of players and is the same in
// every window; that makes the size of a card a fact about the table, not
// about a window: an upright card covers `card.w` x `card.h` of every view.
//
// So "do two piles overlap" has one answer for the whole table: they clash if
// in ANY seat's view their upright cards (plus a gap) would touch. The fixed
// spots are laid out to that rule, and so is every Ace put down on a table
// where piles go wherever they are started ('free').

export interface Pt {
  x: number;
  y: number;
}

/** A pile's place on the table: a point of the disc, and a degree or two of tilt (nobody squares a pile up). */
export interface Spot extends Pt {
  /** Degrees. */
  r: number;
}

/** 'spots': centre piles go on fixed places. 'free': a pile lies wherever its Ace was put down. */
export type TableMode = 'spots' | 'free';
export const TABLE_MODES: readonly TableMode[] = ['spots', 'free'];

/** Height over width of a playing card (client/cards/Face.tsx draws 90 x 126). */
export const CARD_RATIO = 1.4;
/** The clear felt kept between two piles, as a share of a card's width (the same on screen in both directions). */
const GAP = 0.14;
const TAU = Math.PI * 2;

/**
 * One table per number of players: how wide its drawing is for its height,
 * the width of a card in table units, and where the fixed spots go. The spots
 * are four per player, given for one player's sector as [radius, angle as a
 * share of the sector] and repeated around the table, so every seat sees the
 * same loose rosette. Found by search (the largest card for which no two spots
 * clash in any view), then the card was made a little smaller than that so the
 * spots can be nudged off their marks.
 *
 * `free` is how much smaller again the cards of a table without fixed places
 * are, so that piles put down carelessly still leave room for all four per
 * player (measured: dropped anywhere at random, they nearly always all fit).
 */
const TABLES: Record<number, { aspect: number; card: number; free: number; sector: readonly (readonly [number, number])[] }> = {
  2: { aspect: 2.4, card: 0.235, free: 0.75, sector: [[0.761, 0], [0.52, 0.405], [0.516, 0.595], [0.562, 0.802]] },
  3: { aspect: 2.8, card: 0.152, free: 0.72, sector: [[0.263, 0.753], [0.65, 0.909], [0.651, 0.591], [0.508, 0.249]] },
  4: { aspect: 2.4, card: 0.14, free: 0.8, sector: [[0.298, 0.08], [0.722, 0.733], [0.676, 0.5], [0.723, 0.267]] },
  5: { aspect: 2, card: 0.105, free: 0.88, sector: [[0.825, 0.817], [0.824, 0.177], [0.579, 0.498], [0.312, 0.995]] },
  6: { aspect: 2.4, card: 0.111, free: 0.75, sector: [[0.293, 0.999], [0.776, 0.681], [0.776, 0.318], [0.586, 0.999]] },
};
const tableFor = (n: number) => TABLES[Math.max(2, Math.min(6, Math.round(n) || 2))]!;

/** How many times as wide as it is high a table for `n` players is drawn. */
export const tableAspect = (n: number): number => tableFor(n).aspect;

/** What an upright card covers of any view of a table for `n` players. (It is tall and thin there: the drawing is wide.) */
export function cardSize(n: number, mode: TableMode = 'spots'): { w: number; h: number } {
  const t = tableFor(n);
  const w = t.card * (mode === 'free' ? t.free : 1);
  return { w, h: w * CARD_RATIO * t.aspect };
}

/** Turns `p` about the centre by `a` radians: clockwise as drawn (y points down the screen). */
export const rotate = (p: Pt, a: number): Pt => ({ x: p.x * Math.cos(a) - p.y * Math.sin(a), y: p.x * Math.sin(a) + p.y * Math.cos(a) });

/** How far round the table player `i` of `n` sits from player 0, in radians, clockwise as seen from above. */
export const seatAngle = (i: number, n: number): number => (TAU * i) / Math.max(1, n);

/** The direction, from the centre of the table, in which player `i` of `n` sits. A unit vector. */
export const seatDir = (i: number, n: number): Pt => rotate({ x: 0, y: 1 }, seatAngle(i, n));

/** A point of the table as player `i` of `n` sees it: turned so that their own seat is straight down. */
export const toView = (p: Pt, i: number, n: number): Pt => rotate(p, -seatAngle(i, n));

/** The inverse of `toView`: a point of player `i`'s view, as a point of the table. */
export const fromView = (p: Pt, i: number, n: number): Pt => rotate(p, seatAngle(i, n));

/** Would piles at `a` and `b` touch (or leave less than the gap) on anybody's screen? */
export function clash(a: Pt, b: Pt, n: number, mode: TableMode = 'spots'): boolean {
  const { w, h } = cardSize(n, mode);
  const gap = GAP * w;
  const d = { x: b.x - a.x, y: b.y - a.y };
  for (let i = 0; i < n; i++) {
    const v = toView(d, i, n);
    if (Math.abs(v.x) < w + gap && Math.abs(v.y) < h + gap * tableAspect(n)) return true;
  }
  return false;
}

/** Does a pile at `p` lie on the table in everybody's view: all four corners of its card inside the disc? */
export function onDisc(p: Pt, n: number, mode: TableMode = 'spots'): boolean {
  if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return false;
  const { w, h } = cardSize(n, mode);
  for (let i = 0; i < n; i++) {
    const v = toView(p, i, n);
    if (Math.hypot(Math.abs(v.x) + w / 2, Math.abs(v.y) + h / 2) > 1) return false;
  }
  return true;
}

/** Repeatable noise in [-1, 1) from two integers. */
function noise(i: number, salt: number): number {
  let t = (Math.imul(i + 1, 0x9e3779b1) ^ Math.imul(salt + 1, 0x85ebca6b)) >>> 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return (((t ^ (t >>> 14)) >>> 0) / 2147483648) - 1;
}
const round3 = (v: number): number => Math.round(v * 1000) / 1000;

/** The tilt of a pile started at `p` on a free table: a degree or two, the same for everyone. */
export const tiltAt = (p: Pt): number => round3(noise(Math.round(p.x * 1000), Math.round(p.y * 1000)) * 2.5);

/** How far a fixed spot is nudged off its mark, as a share of a card. */
const NUDGE = 0.03;

/**
 * The fixed spots of a table for `n` players: four per player, in a loose
 * rosette, each a little off its mark and a little askew. Always the same for
 * the same `n`. No two clash and all lie on the disc (shared/table.test.ts).
 */
export function spots(n: number): Spot[] {
  const t = tableFor(n);
  const { w, h } = cardSize(n);
  const out: Spot[] = [];
  for (let k = 0; k < n; k++) {
    for (const [radius, share] of t.sector) {
      const a = (TAU * (k + share)) / n;
      const i = out.length;
      out.push({
        x: round3(radius * Math.cos(a) + noise(i, 11) * NUDGE * w),
        y: round3(radius * Math.sin(a) + noise(i, 12) * NUDGE * h),
        r: round3(noise(i, 13) * 2.5),
      });
    }
  }
  return out;
}

/** Candidate places for a new pile, the middle of the table first. */
const SCAN: readonly Pt[] = (() => {
  const step = 0.05;
  const pts: Pt[] = [];
  for (let x = -1; x <= 1.0001; x += step) for (let y = -1; y <= 1.0001; y += step) if (Math.hypot(x, y) < 1) pts.push({ x: round3(x), y: round3(y) });
  return pts.sort((a, b) => Math.hypot(a.x, a.y) - Math.hypot(b.x, b.y));
})();

/** May a new pile go at `p`, given the piles already `placed`? On the disc, and clear of every one of them. */
export const roomAt = (p: Pt, placed: readonly Pt[], n: number, mode: TableMode = 'free'): boolean =>
  onDisc(p, n, mode) && !placed.some((q) => clash(p, q, n, mode));

/**
 * Some place where a new pile may go (the nearest to `near` of a fixed set of
 * candidates; by default the nearest to the middle), or null when the table is
 * full. Deterministic.
 */
export function openPlace(placed: readonly Pt[], n: number, mode: TableMode = 'free', near?: Pt): Pt | null {
  if (!near) return SCAN.find((p) => roomAt(p, placed, n, mode)) ?? null;
  let best: Pt | null = null;
  let bestD = Infinity;
  for (const p of SCAN) {
    const d = Math.hypot(p.x - near.x, p.y - near.y);
    if (d < bestD && roomAt(p, placed, n, mode)) [best, bestD] = [p, d];
  }
  return best;
}
