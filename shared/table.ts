// The table, defined once for everybody. Pure geometry: no IO, no randomness.
//
// TABLE SPACE. The middle of the table is one felt, the same shape and the
// same way up on every screen: a wide rectangle with rounded corners, centre
// (0, 0), reaching to x = ±TABLE.hw and y = ±1, with y pointing down the
// screen. One unit is the same distance in both directions. A centre pile is a
// point of it (the middle of its cards), and that point is drawn at the same
// place of the felt in every window: a client only chooses where on its screen
// the felt goes and how many pixels a unit is (`toScreen` in client/layout.ts).
// Only the seating around the felt differs from window to window: everyone
// sees their own hand at the bottom.
//
// Cards lie upright, and a card is the same share of the felt for everybody
// (`cardSize`). So what a pile covers is the same rectangle on every screen,
// and the rules for putting one down are simply what everyone sees:
//  - two piles CLASH if their cards, with a small gap between, would overlap;
//  - a pile is ON THE TABLE if its whole card lies on the felt.
// A pile lies wherever its Ace was put down, as long as it keeps to those rules.
import { round3 } from './numbers';

export interface Pt {
  x: number;
  y: number;
}

/** A pile's place on the table: a point of the felt, and a degree or two of tilt (nobody squares a pile up). */
export interface Spot extends Pt {
  /** Degrees. */
  r: number;
}

/**
 * The felt: half its width at its widest (half its height is always 1) and the radius of its corners. How wide it is
 * depends on how many are playing (`feltHw`): `hw` is the widest it ever is, and what a message may name.
 */
export const TABLE = { hw: 2.8, corner: 0.62 } as const;
/** Height over width of a playing card (client/cards/Face.tsx draws 90 x 126). */
export const CARD_RATIO = 1.4;
/** The clear felt kept between two piles, as a share of a card's width. */
const GAP = 0.14;
/** The share of the felt that the cards of a full table (four piles per player) cover. */
const COVER = 0.3;
const seatsOf = (n: number): number => Math.max(2, Math.min(10, Math.round(n) || 2));

/**
 * Half the width of the felt of a table for `n` players. Up to three, nobody sits at the sides and the felt is wide.
 * From four on there are hands to the left and right of it: the felt is squarer, so that it can be taller on a screen
 * (and its cards larger) in the room they leave.
 */
export const feltHw = (n: number): number => (seatsOf(n) >= 4 ? 2.2 : TABLE.hw);
/** The area of the felt. */
const area = (n: number): number => 4 * feltHw(n) - (4 - Math.PI) * TABLE.corner ** 2;

/**
 * The widest a card ever is, however few the players: such that a row of piles
 * put down roughly along the middle of the felt (a card and a half and the gap
 * come to 0.9 of half its height) still leaves room for a pile above every one
 * of them and below. Larger, and one careless row would use up the table.
 */
const WIDEST = 0.4;

/**
 * What a card covers of a table for `n` players. The more players, the more
 * piles and the smaller the cards: sized so that all four piles per player
 * (every Ace in the round) together cover the same modest share of the felt,
 * which leaves room for every one of them even when they are put down
 * carelessly (shared/table.test.ts measures it).
 */
export function cardSize(n: number): { w: number; h: number } {
  const w = Math.min(WIDEST, Math.sqrt((COVER * area(n)) / (4 * seatsOf(n) * CARD_RATIO)));
  return { w, h: w * CARD_RATIO };
}

/** The clear felt kept between two piles of a table for `n` players, in table units. */
export const pileGap = (n: number): number => GAP * cardSize(n).w;

/** How far `p` is outside the felt of a table for `n` players (negative: that far inside its edge). */
export function offFelt(p: Pt, n: number): number {
  const x = Math.abs(p.x) - (feltHw(n) - TABLE.corner);
  const y = Math.abs(p.y) - (1 - TABLE.corner);
  return Math.hypot(Math.max(x, 0), Math.max(y, 0)) + Math.min(Math.max(x, y), 0) - TABLE.corner;
}

/** Would piles at `a` and `b` touch, or leave less than the gap between their cards? */
export function clash(a: Pt, b: Pt, n: number): boolean {
  const { w, h } = cardSize(n);
  const gap = GAP * w;
  return Math.abs(b.x - a.x) < w + gap && Math.abs(b.y - a.y) < h + gap;
}

/** Does a pile at `p` lie on the table: all four corners of its card on the felt? */
export function onTable(p: Pt, n: number): boolean {
  if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return false;
  const { w, h } = cardSize(n);
  // The felt is convex and the same in all four quarters: the corner farthest from the middle decides.
  return offFelt({ x: Math.abs(p.x) + w / 2, y: Math.abs(p.y) + h / 2 }, n) <= 1e-9;
}

/** Repeatable noise in [-1, 1) from two integers. */
function noise(i: number, salt: number): number {
  let t = (Math.imul(i + 1, 0x9e3779b1) ^ Math.imul(salt + 1, 0x85ebca6b)) >>> 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return (((t ^ (t >>> 14)) >>> 0) / 2147483648) - 1;
}

/** The tilt of a pile started at `p`: a degree or two, the same for everyone. */
export const tiltAt = (p: Pt): number => round3(noise(Math.round(p.x * 1000), Math.round(p.y * 1000)) * 2.5);

/** Candidate places for a new pile, the middle of the table first. */
const scanOf = (n: number): readonly Pt[] => {
  const hw = feltHw(n);
  const step = 0.05;
  const pts: Pt[] = [];
  for (let i = -Math.floor(hw / step); i * step <= hw; i++) for (let j = -Math.floor(1 / step); j * step <= 1; j++) pts.push({ x: round3(i * step), y: round3(j * step) });
  const from = (p: Pt) => Math.hypot(p.x / hw, p.y);
  return pts.filter((p) => offFelt(p, n) < 0).sort((a, b) => from(a) - from(b));
};
const SCANS = [2, 3, 4, 5, 6, 7, 8, 9, 10].map(scanOf);
const scan = (n: number): readonly Pt[] => SCANS[seatsOf(n) - 2]!;

/** May a new pile go at `p`, given the piles already `placed`? On the table, and clear of every one of them. */
export const roomAt = (p: Pt, placed: readonly Pt[], n: number): boolean => onTable(p, n) && !placed.some((q) => clash(p, q, n));

/**
 * Some place where a new pile may go (the nearest to the middle of a fixed set
 * of candidates), or null when none of them is clear: the table is full.
 * Deterministic.
 */
export function openPlace(placed: readonly Pt[], n: number): Pt | null {
  return scan(n).find((p) => roomAt(p, placed, n)) ?? null;
}

/** Points of a disc of radius 1 on a fine grid, its middle first and then outwards: where `roomNear` looks. */
const NEAR: readonly Pt[] = (() => {
  const k = 10;
  const pts: Pt[] = [];
  for (let i = -k; i <= k; i++) for (let j = -k; j <= k; j++) if (Math.hypot(i, j) <= k) pts.push({ x: i / k, y: j / k });
  return pts.sort((a, b) => Math.hypot(a.x, a.y) - Math.hypot(b.x, b.y));
})();

/**
 * The place nearest `p`, no further than `reach` from it, where a new pile may go given the piles already `placed`
 * (`p` itself if it is clear), or null when there is none that near: the nearest of `NEAR` that is clear, brought
 * back towards `p` until it is up against whatever is in the way. Deterministic.
 */
export function roomNear(p: Pt, placed: readonly Pt[], n: number, reach: number): Pt | null {
  const out = (d: Pt, t: number): Pt => ({ x: round3(p.x + d.x * reach * t), y: round3(p.y + d.y * reach * t) });
  const d = NEAR.find((d) => roomAt(out(d, 1), placed, n));
  if (!d) return null;
  let [lo, hi] = [0, 1]; // there is room `hi` of the way out along `d`, and none at `lo`
  for (let i = 0; i < 10; i++) {
    const mid = (lo + hi) / 2;
    if (roomAt(out(d, mid), placed, n)) hi = mid;
    else lo = mid;
  }
  return out(d, hi);
}
