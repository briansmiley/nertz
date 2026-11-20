// The end of a round, played on the table: every card that reached the middle
// is washed on the felt (scattered at all angles, backs up), then sorted into
// one pile per player, each out in front of its player's hand as this window
// draws the seating. Up to ~300 cards move at once, so they are drawn on one
// canvas from pre-rendered back sprites instead of being 300 animated
// elements; the labels beside the piles are ordinary DOM.
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { wentOut } from '../shared/engine';
import { PLAIN_LOOK, shownBack, type Back, type Look } from '../shared/protocol';
import { feltHw, offFelt } from '../shared/table';
import type { GameState, RoundScore } from '../shared/types';
import { backArt, backColour, CARD_H, CARD_W } from './cards/Face';
import { LOW, MINI_BELOW, onCanvas, revealed, seatDir, slotStack, TAG_H, trayStack, type Layout, type Rect, type Stage } from './layout';

/** How long each step of the end-of-round sequence takes (ms). */
export const TIMING = { flip: 1000, spread: 1500, out: 1100, wash: 1400, sortEach: 1700, hold: 6500 };
/**
 * On a phone the table is cleared between the wash and the sorting: the hands and the felt fade out, then the places
 * the piles will be gathered at fade in, each with its name, and only then are the cards sorted. This long in all.
 */
export const CLEAR_MS = 1300;
/** While it clears, the wash is drawn in from where it lay on the felt to the middle of the ring of places: this long. */
const GATHER_MS = 900;
/**
 * The finale's own clock starts when the centre piles are spread out ('spread'). With finished piles in the tray,
 * those come out next and are spread out in their turn, `trayAt` ms in; with none there is only a short beat. Then the
 * sorting starts, `sortAt` ms in. (The table's stages run to these times; when the canvas is given a pile's cards is
 * the stage's to say, not this schedule's: see `frameAt`.)
 */
export const trayAt = TIMING.spread + TIMING.out;
export const washedAt = (trayPiles: number): number => (trayPiles ? trayAt + TIMING.wash : TIMING.spread + 400);
/** (`clear`: the table is cleared first, on a phone.) */
export const sortAt = (trayPiles: number, clear = false): number => washedAt(trayPiles) + (clear ? CLEAR_MS : 0);
/** The piles are gathered one player at a time: this long for `n` players. */
export const sortMs = (n: number): number => n * TIMING.sortEach;
/**
 * The end of a round as a schedule: each step after the first ('flip', when the round is scored), and how long after
 * that moment it comes. The one place the steps are timed. The canvas's own clock starts at 'spread', so what it goes
 * by (`washedAt`, `sortAt`) is counted from there. With nothing in the tray, nothing comes out of it: 'out' and 'wash'
 * are one moment. (`clear`: on a phone the table is cleared before the sorting starts.)
 */
export function finaleSteps(trayPiles: number, players: number, clear: boolean): [Stage, number][] {
  const spread = TIMING.flip;
  const out = spread + TIMING.spread;
  const won = spread + sortAt(trayPiles, clear) + sortMs(players);
  return [
    ['spread', spread],
    ['out', out],
    ['wash', out + (trayPiles ? TIMING.out : 0)],
    ['sort', spread + washedAt(trayPiles)],
    ['won', won],
    ['sheet', won + TIMING.hold],
  ];
}
const SPREAD_MS = 950; // a card's trip from its pile out into the wash: unhurried, so the mess is made, not thrown
export const LAND_MS = 620; // a card's trip from the wash onto its owner's pile

/**
 * The order the players' piles are gathered in, the round's lowest score first and its best last: `turn[i]` is the
 * place in that order of the player whose score is `deltas[i]` (ties in seating order).
 */
export function gatherOrder(deltas: readonly number[]): number[] {
  const turn: number[] = [];
  deltas
    .map((_, i) => i)
    .sort((a, b) => deltas[a]! - deltas[b]! || a - b)
    .forEach((i, k) => (turn[i] = k));
  return turn;
}

/**
 * When card `k` of the `of` cards of the pile gathered `turn`th sets out from the wash for it, ms on the finale's
 * clock (sorting from `sortAt`); it lands LAND_MS later. The one schedule of the sorting: the canvas draws to it, and
 * the sound of each player's cards arriving is timed by it (`sortings`).
 */
export const setsOut = (sortAt: number, turn: number, k: number, of: number): number => sortAt + turn * TIMING.sortEach + (k / of) * (TIMING.sortEach - LAND_MS - 250);

/** One player's cards sorted out to them: whose, and when each lands (ms on the finale's clock, earliest first; none: no card of theirs reached the middle). */
export interface Sorting {
  seat: number;
  lands: number[];
}

/**
 * The sorting of `game` (its scores `scores`, on a table that is cleared first if `clear`): one per player of the
 * round, in the order of `game.players`, as `planFinale` and `frameAt` lay it out.
 */
export function sortings(game: GameState, scores: readonly RoundScore[], clear: boolean): Sorting[] {
  const from = sortAt(game.tray.length, clear);
  const cards = [...game.slots.flatMap((s) => s?.cards ?? []), ...game.tray.flat()];
  const turn = gatherOrder(game.players.map((p) => scores.find((s) => s.seat === p.seat)?.delta ?? 0));
  return game.players.map((p, i) => {
    const of = cards.filter((c) => c.owner === p.seat).length;
    return { seat: p.seat, lands: Array.from({ length: of }, (_, k) => setsOut(from, turn[i]!, k, of) + LAND_MS) };
  });
}
/** The cards of a pile do not all leave at once: the last sets out this long after the first. */
const SPREAD_STAGGER_MS = 480;
/** How much of the table's width and height the mixed-up wash spreads over. */
const WASH_SPREAD = { x: 0.62, y: 0.6 };
/** The label beside a sorted pile (name, played, penalty, net score): it is laid out in a box of exactly this size. */
export const LABEL = { w: 176, h: 62 };
/** The same on a cleared table (a phone), in fewer words: two of them stand side by side on a screen held upright. */
export const LABEL_SHORT = { w: 136, h: 62 };
/** ...and held upright, with the label under its pile: the pile in a top corner (`TILE_PILE` high with its lean), the score beside it, the lines below. */
export const LABEL_TILE = { w: 98, h: 120 };
const TILE_PILE = 58;
/** The loop the piles stand on round a cleared table, from nearly a rectangle to an oval (the power of a superellipse), in the order tried. */
const RING = [6, 4, 3, 2.4, 2];
/** Clear cloth between two piles-with-labels on a cleared table, and between them and the edges of the window. */
const APART = 12;
const EDGE = 8;

/** A label lying partly off the window is this many times worse than one lying over a hand: off the window it cannot be read at all. */
const OFF_WINDOW = 8;
/** Clear felt between a sorted pile and the edge of the felt, and between it and the wash or its label. */
const RIM = 5;
/** How far the solid block behind a pile and its label reaches beyond the two. */
const BLOCK_PAD = 4;
const GAP = 6;
/** How far beyond a card's half-height the strip along the middle of the felt reaches that the sorted piles and their labels keep clear of (`Plan.heap`). */
const CORE_RY = 5;
/** A sorted pile leans as it grows, so its thickness shows: up by at most this share of its height, and 0.4 of that to the left. */
const LEAN = 0.16;
const LEAN_X = 0.4;
/** No card of a pile lies quite square: each is turned by up to half of this (radians), one way or the other. */
export const TILT = 0.14;

/** Where the centre of card `k` of `of` comes to rest in a sorted pile. */
export function restAt(pile: Rect, k: number, of: number): { x: number; y: number } {
  const rise = Math.min(0.45, (pile.h * LEAN) / of) * k;
  return { x: pile.x + pile.w / 2 - rise * LEAN_X, y: pile.y + pile.h / 2 - rise };
}

/**
 * The solid block behind a sorted pile and its label, as rectangles whose union is the block: the pile's reach and the
 * label, each a little larger, and the strip of felt between them on the label's side.
 */
export function blockParts(p: SortedPile): Rect[] {
  const m = BLOCK_PAD;
  const r = grow(pileReach(p), m);
  const l = grow(p.label, m);
  const across = p.side === 'left' || p.side === 'right';
  // The strip between them: across the gap, as long as the two face each other (but never less than a rounded corner).
  const lo = across ? Math.max(r.y, l.y) : Math.max(r.x, l.x);
  const hi = across ? Math.min(r.y + r.h, l.y + l.h) : Math.min(r.x + r.w, l.x + l.w);
  const a = across ? Math.min(r.x + r.w, l.x + l.w) : Math.min(r.y + r.h, l.y + l.h);
  const b = across ? Math.max(r.x, l.x) : Math.max(r.y, l.y);
  const bridge: Rect = across ? { x: a - 1, y: lo, w: b - a + 2, h: Math.max(0, hi - lo) } : { x: lo, y: a - 1, w: Math.max(0, hi - lo), h: b - a + 2 };
  return bridge.w > 0 && bridge.h > 0 ? [r, l, bridge] : [r, l];
}

/** The NERTZ! stamp on a cleared table: its letters this high at a pile shown at full size, and about this many times as wide. */
export const STAMP = { size: 16, wide: 4.4 };

/**
 * Where the NERTZ! stamp comes down again on a cleared table (`Layout.cleared`), the one across the caller's hand having
 * gone with the hands: across the top edge of the caller's block, over the pile as far as the block allows; lower
 * down it where a block above (`others`) or the top of the window is in the way.
 */
export function stampAt(p: SortedPile, k: number, others: readonly SortedPile[]): Rect {
  const [w, h] = [STAMP.size * STAMP.wide * k, STAMP.size * k];
  const parts = blockParts(p);
  const left = Math.min(...parts.map((r) => r.x));
  const right = Math.max(...parts.map((r) => r.x + r.w));
  const top = Math.min(...parts.map((r) => r.y));
  const x = Math.max(left + w / 2, Math.min(right - w / 2, p.x + p.w / 2)) - w / 2;
  const above = others.filter((o) => o.seat !== p.seat).flatMap(blockParts).filter((r) => r.x < x + w && x < r.x + r.w && r.y < top);
  return { x, y: Math.max(EDGE / 2, top - h / 2, ...above.map((r) => r.y + r.h + 1)), w, h };
}
const grow = (r: Rect, m: number): Rect => ({ x: r.x - m, y: r.y - m, w: r.w + 2 * m, h: r.h + 2 * m });

/**
 * What a sorted pile covers once it is drawn, however many cards it gets: more than its own rectangle, up and to the
 * left by its lean, and all round by the corners of cards that are a little askew. Labels keep off this, not off
 * the bare rectangle. (They did once, and a label to the left of a tall pile had its last letters under the cards.)
 */
export function pileReach(pile: Rect): Rect {
  const turn = Math.sin(TILT / 2);
  const ex = (pile.h / 2) * turn;
  const ey = (pile.w / 2) * turn;
  const lean = pile.h * LEAN;
  return { x: pile.x - lean * LEAN_X - ex, y: pile.y - lean - ey, w: pile.w + lean * LEAN_X + 2 * ex, h: pile.h + lean + 2 * ey };
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
/** A gentle start and a gentle stop, and never fast in between (a sine's half turn): a card slid by a hand, not flung. */
const glideEase = (t: number) => (1 - Math.cos(Math.PI * t)) / 2;
/** Repeatable noise in [0, 1): the same card gets the same path on every frame and after a resize. */
function noise(i: number, salt: number): number {
  let t = (Math.imul(i + 1, 0x9e3779b1) ^ Math.imul(salt + 1, 0x85ebca6b)) >>> 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export interface Mover {
  id: string;
  owner: number;
  /** Start: the pile it lay in. */
  x: number;
  y: number;
  /** Place in the wash: angle and radius (0..1) around the middle, and how far it turns. */
  angle: number;
  radius: number;
  spin: number;
  delay: number;
  /** A card of a finished pile out of the tray: the table keeps those a stage longer than the centre piles (`onCanvas`), and they join the wash when it lets go of them. */
  tray: boolean;
  /** Destination: which sorted pile, and its place in it. */
  pile: number;
  k: number;
  of: number;
  tilt: number;
  /** How it lay in its pile before the wash (radians): a finished pile out of the tray is not quite square. */
  rot0: number;
}

/** Where a pile's label lies relative to the pile: the text is set against the pile's side. */
export type LabelSide = 'left' | 'right' | 'above' | 'below';

export interface SortedPile extends Rect {
  seat: number;
  total: number;
  /** The label's box, LABEL.w x LABEL.h, beside the pile on `side`. */
  label: Rect;
  side: LabelSide;
}

export interface Plan {
  /** The part of the window the cards can reach; the canvas covers only this. */
  area: Rect;
  movers: Mover[];
  /** When the sorting starts, ms on the finale's clock. */
  sortAt: number;
  /** One per player of the round, in the order of `game.players`. */
  piles: SortedPile[];
  /** A card in the wash. */
  w: number;
  h: number;
  /**
   * On a phone: where the wash is drawn in to as the table is cleared (the middle of the ring of places, and how far
   * from it the cards' centres then go), from `at` ms on the finale's clock. Its cards grow to the size of the piles
   * as they go: there is room for it now.
   */
  gather?: { at: number; cx: number; cy: number; rx: number; ry: number };
  /** A card in a sorted pile, as a share of that (smaller where the felt is low for its cards: a table for two). */
  scale: number;
  /** The label of a pile as it is laid out (LABEL, or LABEL_SHORT in fewer words), and how much smaller than that it is shown: `SortedPile.label` is the box it then fills. */
  label: { w: number; h: number; short: boolean; tile?: boolean; k: number };
  /** The middle of the wash, and how far from it the centres of the washed cards go. */
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  /** The strip along the middle of the felt that the sorted piles and their labels keep clear of. */
  heap: Rect;
}

const overlap = (a: Rect, b: Rect): number =>
  Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));

/**
 * Geometry of the whole sequence. Pure, so a resize mid-way just continues with new numbers.
 *
 * The cards of the middle are washed, then each player's pile is gathered with its label beside it: on the table in
 * front of its player (`onTheFelt`), or on a phone, where the table is cleared for it, round the edges of the window
 * (`aroundEdges`).
 */
export function planFinale(L: Layout, game: GameState): Plan {
  const table = L.phone ? aroundEdges(L, game) : onTheFelt(L, game);
  const { piles } = table;
  const pileOf = new Map(piles.map((p, i) => [p.seat, i]));

  const lying = [...game.slots.map((pile, i) => ({ pile: pile?.cards ?? [], at: L.slots[i], tray: -1, slot: i })), ...game.tray.map((pile, i) => ({ pile, at: L.out[i], tray: i, slot: -1 }))];
  const movers = lying.flatMap(({ pile, at, tray, slot }) =>
    pile.flatMap((card, j): Mover[] => {
      const to = pileOf.get(card.owner);
      if (!at || to === undefined) return [];
      // Every pile starts the wash as the loose stack it was turned over or came out of the tray as (see `stackOffset`).
      const o = tray < 0 ? slotStack(slot, j, at.w) : trayStack(tray, j, at.w);
      return [{ id: card.id, owner: card.owner, x: at.x + o.x, y: at.y + o.y, angle: 0, radius: 0, spin: 0, delay: 0, tray: tray >= 0, pile: to, k: 0, of: 0, tilt: 0, rot0: ((o.rot + ('rot' in at ? (at as { rot: number }).rot : 0)) * Math.PI) / 180 }];
    }),
  );
  // Draw order is shuffled so the colours mix in the wash; a card's place in its sorted pile follows the draw order.
  // Not the finished piles that come out of the tray, though: those are set down on the wash as it lies, so when they
  // spread every card of them stays over all that it came out on top of: over the whole wash, and over the cards that
  // were under it in its own pile. (Shuffled in with the rest, each went to a height of its own, some to the bottom.)
  const order = movers.map((_, i) => noise(i, 1));
  const shuffled = movers
    .map((mv, i) => ({ mv, i, o: order[i]! }))
    .sort((a, b) => Number(a.mv.tray) - Number(b.mv.tray) || (a.mv.tray ? a.i - b.i : a.o - b.o))
    .map((e) => e.mv);
  shuffled.forEach((mv, i) => {
    mv.angle = noise(i, 2) * Math.PI * 2;
    mv.radius = Math.sqrt(0.04 + 0.96 * noise(i, 3)); // even over the felt
    mv.spin = (noise(i, 4) - 0.5) * 2.4 * Math.PI;
    mv.delay = noise(i, 5);
    mv.tilt = (noise(i, 6) - 0.5) * TILT;
    mv.k = piles[mv.pile]!.total++;
    // On the felt the wash lies until each pile's turn, and the labels show up beside it one by one: no card lies
    // under a label, so only a card on its way somewhere is ever over the words. Its way out from the middle is
    // drawn in to where it would first touch one. (On a phone the wash is drawn in to the middle of the ring first.)
    if (!table.gather) {
      const r = mv.radius;
      let clear = 0;
      for (let k = 1; k <= 50 && !table.piles.some((p) => overlap(washBox(table, { ...mv, radius: k / 50 }), p.label) > 0); k++) clear = k / 50;
      mv.radius = r * clear;
    }
  });
  for (const mv of shuffled) mv.of = piles[mv.pile]!.total;
  return { ...table, sortAt: sortAt(game.tray.length, L.phone), movers: shuffled };
}

/** The wash keeps to the felt: an oval well inside its edge, clear of the rounded corners. */
function washOnFelt(L: Layout, n: number, w: number, h: number): Pick<Plan, 'cx' | 'cy' | 'rx' | 'ry'> {
  const [rx, ry] = [feltHw(n) * L.felt.u, L.felt.u];
  return { cx: L.felt.cx, cy: L.felt.cy, rx: Math.max(w, rx * 0.8 - w / 2), ry: Math.max(h * 0.2, ry * 0.88 - h / 2) };
}

/** Where a card lies in the wash once it has spread: its centre and its turn (radians). */
export function washSpot(plan: Pick<Plan, 'cx' | 'cy' | 'rx' | 'ry'>, mv: Pick<Mover, 'angle' | 'radius' | 'spin'>): { x: number; y: number; rot: number } {
  const r = mv.radius;
  return { x: plan.cx + Math.cos(mv.angle) * r * plan.rx * WASH_SPREAD.x, y: plan.cy + Math.sin(mv.angle) * r * plan.ry * WASH_SPREAD.y, rot: mv.spin * 0.5 };
}

/** ...and the box it covers there, turned as it is. */
export function washBox(plan: Pick<Plan, 'cx' | 'cy' | 'rx' | 'ry' | 'w' | 'h'>, mv: Pick<Mover, 'angle' | 'radius' | 'spin'>): Rect {
  const { x, y, rot } = washSpot(plan, mv);
  const [c, s] = [Math.abs(Math.cos(rot)), Math.abs(Math.sin(rot))];
  const [hw, hh] = [(plan.w * c + plan.h * s) / 2, (plan.h * c + plan.w * s) / 2];
  return { x: x - hw, y: y - hh, w: 2 * hw, h: 2 * hh };
}

/** Where the piles are gathered and how far the wash spreads: all of a plan but the cards. */
type Ground = Omit<Plan, 'movers' | 'sortAt'>;

/**
 * On the table. Each player's pile is gathered at the edge of the felt, out towards that player's chair as this
 * window seats them: yours at the bottom, everyone else's round the table from there. The label goes beside its pile,
 * on whichever side is clear of every hand, the tray, the wash, the other piles and the other labels.
 */
function onTheFelt(L: Layout, game: GameState): Ground {
  const w = L.fs * CARD_W;
  const h = L.fs * CARD_H;
  const d = { cx: L.felt.cx, cy: L.felt.cy, rx: feltHw(game.players.length) * L.felt.u, ry: L.felt.u };
  const n = game.players.length;
  // A low strip along the middle of the felt is kept clear. What is left of the felt's height above and below it is
  // what a pile in front of the seats at the top and the bottom can have.
  const coreHalf = h / 2 + CORE_RY;
  const scale = Math.max(0.45, Math.min(1, (d.ry - RIM - GAP - coreHalf) / h));
  const pw = w * scale;
  const ph = h * scale;
  const core = { rx: Math.max(pw, d.rx * (n > 3 ? 0.2 : 0.26)), ry: CORE_RY };
  const heap: Rect = { x: d.cx - core.rx - w / 2, y: d.cy - coreHalf, w: 2 * core.rx + w, h: 2 * coreHalf };

  // A pile goes out towards its player's chair (as this window seats them: `seatDir`), as far as it still lies on the felt.
  const onFelt = (cx: number, cy: number): boolean => offFelt({ x: (Math.abs(cx - d.cx) + pw / 2) / L.felt.u, y: (Math.abs(cy - d.cy) + ph / 2) / L.felt.u }, n) <= -RIM / L.felt.u;
  // Someone who is not in the round watches from the first player's chair.
  const view = Math.max(0, game.players.findIndex((p) => p.seat === L.me?.seat));
  const spotAt = (seat: number, v: { x: number; y: number }) => {
    let k = 1.5;
    while (k > 0.3 && !onFelt(d.cx + v.x * d.rx * k, d.cy + v.y * d.ry * k)) k -= 0.005;
    return { seat, v, x: d.cx + v.x * d.rx * k - pw / 2, y: d.cy + v.y * d.ry * k - ph / 2, w: pw, h: ph };
  };
  const round = game.players.map((p, i) => spotAt(p.seat, seatDir((i - view + n) % n, n)));
  // Where the others sit in a column at each side (a full table, or a phone on its side), the chairs are not round
  // the felt, and a pile sent "towards its chair" by the seat's place in the ring lands in front of someone else. There
  // each pile goes to the edge of the felt nearest its player's hand instead: towards where the hand really is.
  // (Kept only if no two piles then touch; else the ring, which never does.)
  /** The piles with each sent `w` of the way from its place in the ring towards its player's hand (0: the ring). */
  const towardsHands = (w: number) =>
    game.players.map((p, i) => {
      const box = L.opponents.find((o) => o.seat === p.seat)?.box;
      if (!box) return round[i]!; // you (or a hand with no place): as before
      const vx = (box.x + box.w / 2 - d.cx) / d.rx;
      const vy = (box.y + box.h / 2 - d.cy) / d.ry;
      const len = Math.hypot(vx, vy) || 1;
      const ring = round[i]!.v;
      const mx = ring.x * (1 - w) + (vx / len) * w;
      const my = ring.y * (1 - w) + (vy / len) * w;
      const m = Math.hypot(mx, my) || 1;
      return spotAt(p.seat, { x: mx / m, y: my / m });
    });
  const apart = (a: Rect, b: Rect): boolean => a.x + a.w + GAP <= b.x || b.x + b.w + GAP <= a.x || a.y + a.h + GAP <= b.y || b.y + b.h + GAP <= a.y;
  const clear = (set: typeof round): boolean => set.every((a, i) => set.every((b, j) => j <= i || apart(pileReach(a), pileReach(b))));

  /** The labels for the piles at `spots`, and how badly they sit (0: nothing overlaps and every label is where it likes). */
  const label = (spots: typeof round, most = 200000) => {
    // Labels. What a label must keep off: every hand with its name, your own hand down to the bottom edge, the tray,
    // the drawn-in wash, every pile, the labels placed before it, and the edges of the window.
    const hands: Rect[] = L.opponents.map((o) => ({ x: o.box.x, y: o.box.y - TAG_H, w: o.box.w, h: o.box.h + TAG_H }));
    if (L.me) hands.push({ ...L.me.box, h: L.window.h - L.me.box.y });
    const reach = spots.map(pileReach);
    const fixed: Rect[] = [...hands, L.tray, heap, ...reach];
    const frame: Rect = { x: 4, y: 4, w: L.window.w - 8, h: L.window.h - 8 };
    const choices = spots.map((pile, i) => {
      const mid = { x: pile.x + pw / 2, y: pile.y + ph / 2 };
      // Beside the pile as it is drawn (it leans up and to the left), not beside its bare rectangle.
      const drawn = reach[i]!;
      const across = { right: drawn.x + drawn.w + GAP, left: drawn.x - GAP - LABEL.w };
      const along = { below: drawn.y + drawn.h + GAP, above: drawn.y - GAP - LABEL.h };
      // In order of preference: the side away from the middle of the table (the right, for a seat straight above or
      // below), the side towards it, then beyond the pile and before it. Level with the pile, or flush with an edge.
      const outer: LabelSide = pile.v.x < -0.2 ? 'left' : 'right';
      const inner: LabelSide = outer === 'left' ? 'right' : 'left';
      const far: LabelSide = pile.v.y > 0 ? 'below' : 'above';
      const near: LabelSide = far === 'below' ? 'above' : 'below';
      const flushFar = far === 'below' ? pile.y + ph - LABEL.h : pile.y;
      const flushNear = far === 'below' ? pile.y : pile.y + ph - LABEL.h;
      // (...or, where neighbours' labels are in the way of all that, half a label up or down: still right beside the pile.)
      const ys = [mid.y - LABEL.h / 2, flushFar, flushNear, mid.y - LABEL.h, mid.y];
      const xs = [mid.x - LABEL.w / 2, outer === 'right' ? pile.x : pile.x + pw - LABEL.w, outer === 'right' ? pile.x + pw - LABEL.w : pile.x];
      const options: { side: LabelSide; box: Rect; cost: number }[] = [];
      for (const side of [outer, inner, far, near]) {
        for (const at of side === 'left' || side === 'right' ? ys : xs) {
          const box: Rect = side === 'left' || side === 'right' ? { x: across[side], y: at, ...LABEL } : { x: at, y: along[side], ...LABEL };
          // What it would lie over of the things that do not move, and how much of it would be off the window.
          const cost = Math.round(OFF_WINDOW * (LABEL.w * LABEL.h - overlap(box, frame)) + fixed.reduce((sum, r) => sum + (r === drawn ? 0 : overlap(box, r)), 0)); // (whole px²: no rounding dust)
          options.push({ side, box, cost });
        }
      }
      // Places that lie over nothing are all that is tried, while there are any.
      const clear = options.filter((o) => o.cost === 0);
      return clear.length > 0 ? clear : options;
    });
    // One label per pile with nothing overlapping, each on the best side that allows it: a search, since the first
    // pile's favourite place may be the only one left for another's (there are at most ten piles and sixteen places
    // each). If the window is too small for that, the arrangement that overlaps least.
    let labels = choices.map((options) => options[0]!);
    let least = Infinity;
    const pick: (typeof labels)[number][] = [];
    let tries = 0;
    const search = (i: number, cost: number): void => {
      if (cost >= least || ++tries > most) return;
      if (i === choices.length) {
        least = cost;
        labels = [...pick];
        return;
      }
      for (const option of choices[i]!) {
        pick[i] = option;
        search(i + 1, cost + option.cost + Math.round(pick.slice(0, i).reduce((sum, other) => sum + overlap(option.box, other.box), 0)));
        if (least === 0) return;
      }
    };
    search(0, 0);
    return { spots, labels, least };
  };
  // The ring first: it never fails. Then, in columns, as far towards the hands as leaves the piles apart and the
  // labels no worse off than the ring has them (in a small window the labels of five piles down one side collide).
  let best = label(round);
  if (L.low) {
    for (const w of [1, 0.75, 0.5, 0.25]) {
      const set = towardsHands(w);
      if (!clear(set)) continue;
      const tried = label(set, 40000); // (a second opinion, four times over: on a smaller allowance, so the end of a round does not stall)
      if (tried.least <= best.least) {
        best = tried;
        break;
      }
    }
  }
  const { spots, labels } = best;
  const piles: SortedPile[] = spots.map((s, i) => ({ seat: s.seat, x: s.x, y: s.y, w: pw, h: ph, total: 0, label: labels[i]!.box, side: labels[i]!.side }));
  const span = Math.hypot(w, h) / 2 + 8; // a card turned to any angle, plus its shadow
  const area: Rect = { x: Math.floor(d.cx - d.rx - span), y: Math.floor(d.cy - d.ry - span), w: Math.ceil(2 * (d.rx + span)), h: Math.ceil(2 * (d.ry + span)) };
  return { area, piles, w, h, scale, label: { ...LABEL, short: false, k: 1 }, ...washOnFelt(L, n, w, h), heap };
}

/**
 * On a phone. The cards are washed on the felt as on any table; then the table is cleared (`Layout.cleared`), the wash
 * is drawn in to the middle of the window, and nothing is in the way: the piles stand in a ring round the window, evenly spaced
 * along one loop, in the order of the seats: yours at the bottom in the middle, then clockwise, so with an even number
 * playing whoever sits straight across is at the top in the middle. The drawn-in wash has the room inside the ring.
 *
 * What stands at each place is a pile with its label, shaped for the window. Held upright the screen is narrow, and
 * the label is under its pile (`tile`), so that those at the two edges leave room between them. The loop is then a
 * rectangle with its corners rounded off, more or less (`RING`): the squarer, the more room inside, and the squarest
 * on which nothing touches is taken. On its side the screen is low and has buttons in its left corners: the label is
 * beside its pile, and the ring is yours at the bottom, whoever is straight across at the top, and everyone else in
 * pairs down the two edges between the buttons, level with each other and evenly apart.
 *
 * If the window is too small for that, all of it is drawn smaller (`k`).
 */
function aroundEdges(L: Layout, game: GameState): Ground {
  const n = game.players.length;
  const { w: W, h: H } = L.window;
  const view = Math.max(0, game.players.findIndex((p) => p.seat === L.me?.seat));
  const box: Rect = { x: Math.max(EDGE, L.keep.l + BLOCK_PAD), y: L.tall ? L.bar + 4 : EDGE, w: 0, h: 0 };
  box.w = W - Math.max(EDGE, L.keep.r + BLOCK_PAD) - box.x;
  box.h = H - EDGE - box.y;
  const [cx, cy] = [box.x + box.w / 2, box.y + box.h / 2];
  // On its side: the chat button in the top left corner, the sound and settings buttons (and Skip) in the bottom left.
  const buttons: Rect[] = L.tall ? [] : [{ x: 0, y: 0, w: L.keep.l + 150, h: LOW.top }, { x: 0, y: H - LOW.knobs, w: L.keep.l + 210, h: LOW.knobs }];
  const apart = (a: Rect, b: Rect, by: number): boolean => a.x + a.w + by <= b.x || b.x + b.w + by <= a.x || a.y + a.h + by <= b.y || b.y + b.h + by <= a.y;

  const lay = (k: number, power: number) => {
    const label = L.tall ? { w: LABEL_TILE.w * k, h: LABEL_TILE.h * k } : { w: LABEL_SHORT.w * k, h: LABEL_SHORT.h * k };
    // A pile is as high as there is room for beside (or over) its label once it leans. The cards of the drawn-in wash
    // are that size too: there is room for it now, whatever size the felt had them at.
    const h = (L.tall ? TILE_PILE * k : label.h) / 1.24;
    const w = (h * CARD_W) / CARD_H;
    const reach = pileReach({ x: 0, y: 0, w, h });
    const uw = L.tall ? label.w : reach.w + GAP + label.w;
    const uh = L.tall ? label.h : Math.max(reach.h, label.h);
    /** A pile and its label in the box uw x uh with its top left corner at (x, y): the pile at its left end, or at its right. */
    const unit = (seat: number, x: number, y: number, side: LabelSide): SortedPile => ({
      seat,
      x: (side === 'right' ? x + (L.tall ? 2 * k : 0) : x + uw - reach.w - (L.tall ? 2 * k : 0)) - reach.x,
      y: (L.tall ? y + 2 * k : y + (uh - reach.h) / 2) - reach.y,
      w,
      h,
      total: 0,
      // (Upright the label's box is the whole of it, the pile standing in its top corner.)
      label: L.tall ? { x, y, ...label } : { x: side === 'right' ? x + reach.w + GAP : x, y: y + (uh - label.h) / 2, ...label },
      side,
    });
    // Where the middles of the units go, so that each lies wholly inside `box`: yours first, then clockwise.
    const [A, B] = [(box.w - uw) / 2, (box.h - uh) / 2];
    let places: { x: number; y: number }[];
    if (L.tall) {
      const bend = (v: number) => Math.sign(v) * Math.abs(v) ** (2 / power);
      const at = (t: number) => ({ x: cx - A * bend(Math.sin(t)), y: cy + B * bend(Math.cos(t)) }); // from straight down, clockwise
      const STEPS = 1440;
      const along = [0];
      for (let i = 1, was = at(0); i <= STEPS; i++) {
        const now = at((2 * Math.PI * i) / STEPS);
        along.push(along[i - 1]! + Math.hypot(now.x - was.x, now.y - was.y));
        was = now;
      }
      places = Array.from({ length: n }, (_, i) => {
        const want = (along[STEPS]! * i) / n;
        const j = i === n / 2 ? STEPS / 2 : along.findIndex((d) => d >= want); // (straight across, to the pixel)
        return at((2 * Math.PI * j) / STEPS);
      });
    } else {
      const across = (n - 1) % 2;
      const pairs = (n - 1 - across) / 2;
      const [from, to] = [Math.max(box.y, LOW.top) + uh / 2, H - LOW.knobs - uh / 2];
      const each = pairs > 1 ? Math.min((uh + APART) * 1.5, (to - from) / (pairs - 1)) : 0;
      const lowest = (from + to + each * (pairs - 1)) / 2;
      const left = Array.from({ length: pairs }, (_, i) => ({ x: cx - A, y: lowest - i * each }));
      places = [{ x: cx, y: cy + B }, ...left, ...(across ? [{ x: cx, y: cy - B }] : []), ...left.map((c) => ({ x: cx + A, y: c.y })).reverse()];
    }
    const piles = places.map((c, i) => unit(game.players[(view + i) % n]!.seat, c.x - uw / 2, c.y - uh / 2, c.x > cx + 1 ? 'left' : 'right'));
    const boxes = places.map((c): Rect => ({ x: c.x - uw / 2, y: c.y - uh / 2, w: uw, h: uh }));
    // The wash: an oval in the middle of the room between them (as high as the room straight above your pile), as
    // large as stays clear of them all.
    const span = Math.hypot(w, h) / 2;
    const inLine = boxes.filter((r) => r.x < cx && cx < r.x + r.w);
    const upper = Math.max(box.y, ...inLine.filter((r) => r.y < cy).map((r) => r.y + r.h));
    const lower = Math.min(box.y + box.h, ...inLine.filter((r) => r.y > cy).map((r) => r.y));
    const my = (upper + lower) / 2;
    let [rx, ry] = [A - uw / 2 - EDGE, (lower - upper) / 2 - EDGE];
    const m = BLOCK_PAD + 2; // (clear of the block drawn behind each, not just of the unit)
    const under = (r: Rect) => Math.hypot(Math.max(r.x - m - cx, 0, cx - r.x - r.w - m) / rx, Math.max(r.y - m - my, 0, my - r.y - r.h - m) / ry) < 1;
    while (rx > span && ry > span && boxes.some(under)) ry > rx ? (ry *= 0.96) : (rx *= 0.96); // (the longer way first: an oval, not a strip)
    const fits =
      A > 0 && B > 0 && rx - span >= w * 0.4 && ry - span >= h * 0.3 && !boxes.some(under) &&
      boxes.every((a, i) => buttons.every((b) => apart(a, b, 0)) && boxes.every((b, j) => j <= i || apart(a, b, APART)));
    return { piles: game.players.map((p) => piles.find((u) => u.seat === p.seat)!), fits, w, h, rx: rx - span, ry: ry - span, my };
  };
  let [k, laid] = [1, lay(1, RING[0]!)];
  search: for (; k > 0.4; k -= 0.04) for (const power of L.tall ? RING : RING.slice(0, 1)) if ((laid = lay(k, power)).fits) break search;
  const { piles, w, h, my } = laid;
  // (No thinner than a wash is, and no wider than a heap of cards spreads.)
  const rx = Math.max(w * 0.4, Math.min(laid.rx, w * 4.5));
  const ry = Math.max(h * 0.3, Math.min(laid.ry, h * 3));
  const [fw, fh] = [L.fs * CARD_W, L.fs * CARD_H];
  return {
    area: { x: 0, y: 0, w: W, h: H },
    piles,
    w: fw,
    h: fh,
    scale: w / fw,
    label: { ...(L.tall ? LABEL_TILE : LABEL_SHORT), short: true, tile: L.tall, k },
    ...washOnFelt(L, n, fw, fh),
    gather: { at: washedAt(game.tray.length), cx, cy: my, rx, ry },
    heap: { x: cx - rx - w / 2, y: my - ry - h / 2, w: 2 * rx + w, h: 2 * ry + h },
  };
}

// The pictures of the backs in use, fetched once each.
const pictures = new Map<string, HTMLImageElement>();
function pictureOf(src: string, loaded: () => void): HTMLImageElement | null {
  let img = pictures.get(src);
  if (!img) {
    img = new Image();
    img.src = src;
    pictures.set(src, img);
  }
  if (img.complete && img.naturalWidth > 0) return img;
  img.addEventListener('load', loaded, { once: true });
  return null;
}

/** One card's back, drawn once per player and then stamped for every card of theirs: the plain cross-hatch, or the back its owner chose (`art`) once its picture has arrived. Matches `.back` in styles.css. */
function backSprite(colour: string, w: number, h: number, dpr: number, art?: { img: HTMLImageElement; zoom: number; edge: boolean }, bare = false): HTMLCanvasElement {
  const pad = Math.ceil(w * 0.08);
  const sprite = document.createElement('canvas');
  sprite.width = Math.ceil((w + 2 * pad) * dpr);
  sprite.height = Math.ceil((h + 2 * pad) * dpr);
  const c = sprite.getContext('2d')!;
  const u = w / CARD_W; // one CSS px of the 90x126 drawing
  c.scale(dpr, dpr);
  c.translate(pad, pad);
  c.shadowColor = 'rgba(0, 0, 0, 0.34)';
  c.shadowBlur = 2.5 * u * dpr;
  c.shadowOffsetY = 1.5 * u * dpr;
  c.fillStyle = '#fffdf7';
  c.beginPath();
  c.roundRect(0, 0, w, h, 7 * u);
  c.fill();
  c.shadowColor = 'transparent';
  c.lineWidth = 0.6;
  c.strokeStyle = 'rgba(20, 30, 40, 0.5)';
  c.stroke();

  if (art) {
    // As `.back.tint` in the stylesheet: the pattern over the player's colour. (A small card may show only the middle
    // of a picture; some patterns lie inside a white edge: `backArt`.)
    const f = art.edge ? 5 * u : 0;
    c.save();
    c.beginPath();
    c.roundRect(0, 0, w, h, 7 * u);
    c.clip();
    c.fillStyle = art.edge ? '#fffdf7' : colour;
    c.fillRect(0, 0, w, h);
    c.fillStyle = colour;
    c.fillRect(f, f, w - 2 * f, h - 2 * f);
    const [iw, ih] = [art.img.naturalWidth || w, art.img.naturalHeight || h];
    const k = art.zoom;
    c.drawImage(art.img, (iw * (1 - 1 / k)) / 2, (ih * (1 - 1 / k)) / 2, iw / k, ih / k, f, f, w - 2 * f, h - 2 * f);
    c.restore();
    return sprite;
  }
  const b = bare ? 0 : 4.5 * u; // (the plain back without its white edge: the cross-hatch out to the edge of the card)
  c.beginPath();
  c.roundRect(b, b, w - 2 * b, h - 2 * b, bare ? 7 * u : 2.5 * u);
  c.fillStyle = colour;
  c.fill();
  c.save();
  c.clip();
  c.strokeStyle = 'rgba(255, 255, 255, 0.3)';
  c.lineWidth = 1.3 * u;
  c.beginPath();
  for (let d = -h; d < w + h; d += 7 * Math.SQRT2 * u) {
    c.moveTo(d, 0);
    c.lineTo(d + h, h);
    c.moveTo(d + h, 0);
    c.lineTo(d, h);
  }
  c.stroke();
  const ray = Math.hypot(w / 2 - b, h / 2 - b);
  c.fillStyle = 'rgba(255, 255, 255, 0.85)';
  c.beginPath();
  c.arc(w / 2, h / 2, ray * 0.21, 0, Math.PI * 2);
  c.fill();
  c.fillStyle = colour;
  c.beginPath();
  c.arc(w / 2, h / 2, ray * 0.17, 0, Math.PI * 2);
  c.fill();
  c.restore();
  if (bare) return sprite;
  c.strokeStyle = 'rgba(255, 255, 255, 0.75)';
  c.lineWidth = 1.2 * u;
  c.beginPath();
  c.roundRect(b, b, w - 2 * b, h - 2 * b, 2.5 * u);
  c.stroke();
  return sprite;
}

/** A card as the canvas draws it: the card, its centre, its turn (radians), and its size in cards of the wash. */
export type Stamp = [Mover, number, number, number, number];

/**
 * The canvas's cards at `stage`, `t` ms into the wash, in the order they are drawn, and how many have landed on each
 * sorted pile. Which cards are the canvas's is the stage's to say (`onCanvas`), never the clock's: the table lets go
 * of a pile on a stage, and what it has let go of is drawn here from that very frame, where it lay. The clock only
 * says how far a card has got. `trayFrom` is when the finished piles were let go, on the same clock; `order[i]` is
 * when pile i is gathered (0 first): one player's cards at a time.
 */
export function frameAt(plan: Plan, stage: Stage, t: number, trayFrom: number, order: readonly number[] = []): { cards: Stamp[]; landed: number[] } {
  const { w, h } = plan;
  const landed = plan.piles.map(() => 0);
  // The wash is simply one big mixed-up mess in the middle: the cards slide out of their piles to scattered places,
  // at all angles, and lie there. It does not turn, and it is not tidied up before the cards go out to their owners.
  const wash: Stamp[] = [];
  const resting: Stamp[] = [];
  for (const mv of plan.movers) {
    const pile = plan.piles[mv.pile]!;
    if (!onCanvas(stage, mv.tray ? 'tray' : 'slot')) continue; // still a pile in the tray, or on its way out of it: drawn by the table
    const q = glideEase(clamp01((t - setsOut(plan.sortAt, order[mv.pile] ?? mv.pile, mv.k, mv.of)) / LAND_MS));
    // A sorted pile leans up and to the left a little with every card, so its thickness shows.
    const { x: px, y: py } = restAt(pile, mv.k, mv.of);
    if (q >= 1) {
      landed[mv.pile]!++;
      resting.push([mv, px, py, mv.tilt, plan.scale]);
      continue;
    }
    // In the wash: out from its pile to a spot on the felt, where it lies.
    const spread = glideEase(clamp01((t - (mv.tray ? trayFrom : 0) - mv.delay * SPREAD_STAGGER_MS) / SPREAD_MS));
    const a = mv.angle;
    const r = mv.radius;
    const spot = washSpot(plan, mv);
    let x = lerp(mv.x + w / 2, spot.x, spread);
    let y = lerp(mv.y + h / 2, spot.y, spread);
    let rot = lerp(mv.rot0, spot.rot, spread);
    let size = 1;
    if (plan.gather) {
      const g = glideEase(clamp01((t - plan.gather.at - mv.delay * (GATHER_MS * 0.3)) / (GATHER_MS * 0.7)));
      x = lerp(x, plan.gather.cx + Math.cos(a) * r * plan.gather.rx, g);
      y = lerp(y, plan.gather.cy + Math.sin(a) * r * plan.gather.ry, g);
      size = lerp(1, plan.scale, g);
    }
    if (q > 0) {
      x = lerp(x, px, q);
      y = lerp(y, py, q);
      rot = lerp(rot, mv.tilt, q);
      size = lerp(size, plan.scale, q);
    }
    wash.push([mv, x, y, rot, size]);
  }
  // A card on its way out to its pile keeps its place in the heap: it slides out from under whatever lay on it, and
  // never jumps to the top. The gathered piles are clear of the wash, and are drawn first, so it still lands on top
  // of its own (cards land in the order they lie in the heap).
  return { cards: [...resting, ...wash], landed };
}

/** Draws them, in that order. */
function paint(c: CanvasRenderingContext2D, plan: Plan, sprites: Map<number, HTMLCanvasElement>, dpr: number, cards: readonly Stamp[]): void {
  const { w, h } = plan;
  const pad = Math.ceil(w * 0.08);
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.clearRect(0, 0, c.canvas.width, c.canvas.height);
  // Each with its centre at (x, y), turned by `rot`, `size` times as large as a card in the wash.
  for (const [mv, x, y, rot, size] of cards) {
    const cos = Math.cos(rot) * dpr * size;
    const sin = Math.sin(rot) * dpr * size;
    c.setTransform(cos, sin, -sin, cos, (x - plan.area.x) * dpr, (y - plan.area.y) * dpr);
    c.drawImage(sprites.get(mv.owner)!, -w / 2 - pad, -h / 2 - pad, w + 2 * pad, h + 2 * pad);
  }
}

const signed = (n: number) => (n > 0 ? `+${n}` : n < 0 ? `−${-n}` : '0');

interface Props {
  L: Layout;
  game: GameState;
  scores: readonly RoundScore[];
  name: (seat: number) => string;
  /** How far the end of the round has got: which piles the table has let go of, and at 'sheet' the finished picture at once (skipped, reduced motion, or arriving after the fact). */
  stage: Stage;
  /** How each player's cards look. */
  looks: (seat: number) => Look | undefined;
}

/** The back `seat`'s cards are drawn with here, and whether without its white edge: a back by lot not drawn yet is the plain one. */
const backFor = (looks: Props['looks'], seat: number): [back: Back | null, bare: boolean] => {
  const look = looks(seat) ?? PLAIN_LOOK;
  const back = shownBack(look.backs);
  return [back, back !== null && look.bare];
};

export function Finale({ L, game, scores, name, stage, looks }: Props) {
  const instant = stage === 'sheet';
  // (A back's picture that has not arrived yet: the cards are plain until it has, and then drawn again.)
  const [arrived, setArrived] = useState(0);
  const chosen = game.players.map((p) => backFor(looks, p.seat).join(' ')).join();
  const plan = useMemo(() => planFinale(L, game), [L, game]);
  const canvas = useRef<HTMLCanvasElement>(null);
  const began = useRef(0);
  /** When the table let go of the finished piles (ms on this clock): they spread out from then. */
  const trayFrom = useRef(Infinity);
  const [landed, setLanded] = useState<number[]>(() => plan.piles.map((p) => (instant ? p.total : 0)));
  const n = plan.piles.length;
  /** How many piles have been gathered so far; -1 while the cards are still in the wash. The last of them is, and the round's winner with it, when the stage says so. */
  const [gathered, setGathered] = useState(-1);
  const done = revealed(stage) ? n : gathered;
  // The round's lowest score is gathered first and its best last.
  const delta = (seat: number) => scores.find((s) => s.seat === seat)?.delta ?? 0;
  const turn = useMemo(() => gatherOrder(plan.piles.map((p) => delta(p.seat))), [plan, scores]);
  const best = Math.max(...plan.piles.map((p) => delta(p.seat)));
  /** On a cleared table the NERTZ! stamps have gone with the hands: they come down again on the pile of everyone who went out. */
  const out = L.cleared ? wentOut(game) : [];
  const stamps = plan.piles.filter((p) => out.includes(p.seat)).map((p) => ({ seat: p.seat, at: stampAt(p, plan.label.k, plan.piles) }));

  // Before the browser paints: the commit that takes a pile's cards off the table is the one that draws them here.
  useLayoutEffect(() => {
    const el = canvas.current;
    const c = el?.getContext('2d');
    if (!el || !c) return;
    // As sharp as the cards it takes over from: a phone's screen is 3x.
    const full = Math.min(3, window.devicePixelRatio || 1);
    let scale = full;
    let sprites = new Map<number, HTMLCanvasElement>();
    const setup = (k: number) => {
      scale = k;
      el.width = Math.round(plan.area.w * k);
      el.height = Math.round(plan.area.h * k);
      sprites = new Map(
        plan.piles.map((p) => {
          const [back, bare] = backFor(looks, p.seat);
          const art = backArt(back, bare, plan.w < MINI_BELOW);
          const img = art && pictureOf(art.src, () => setArrived((a) => a + 1));
          return [p.seat, backSprite(backColour(p.seat), plan.w, plan.h, k * Math.max(1, plan.scale), art && img ? { img, zoom: art.zoom, edge: art.edge } : undefined, bare)];
        }),
      );
    };
    setup(full);
    began.current ||= performance.now();
    if (onCanvas(stage, 'tray')) trayFrom.current = Math.min(trayFrom.current, performance.now() - began.current);
    const end = plan.sortAt + sortMs(n);
    let raf = 0;
    let shown = '';
    let last = 0;
    let late = 0;
    /** The screen's own frame: the shortest gap between two frames so far. A phone saving power gives 30 a second, and keeps to it. */
    let beat = Infinity;
    const frame = (now: number) => {
      const t = instant ? end : now - began.current;
      // Measured, not guessed: if this machine keeps missing frames at full resolution (a high-density screen
      // without a GPU), draw the moving cards at 1x. Nobody can tell while they move, and the piles they come
      // to rest in are redrawn sharp below. Missing means losing a whole frame of the screen's own, five times in a
      // row: a slow screen is not a slow machine, and one slow commit is not either.
      if (last) {
        const gap = now - last;
        beat = Math.min(beat, gap);
        late = gap > Math.max(24, beat * 2) ? late + 1 : 0;
        if (scale > 1 && late >= 5) setup(1);
      }
      last = now;
      if (t >= end && scale < full) setup(full);
      const { cards, landed: counts } = frameAt(plan, stage, t, trayFrom.current, turn);
      paint(c, plan, sprites, scale, cards);
      if (counts.join() !== shown) {
        shown = counts.join();
        setLanded(counts);
      }
      setGathered(t < plan.sortAt ? -1 : Math.min(n - 1, Math.floor((t - plan.sortAt) / TIMING.sortEach)));
      if (t >= end) return;
      raf = requestAnimationFrame(frame);
    };
    frame(performance.now());
    return () => cancelAnimationFrame(raf);
  }, [plan, stage, turn, n, arrived, chosen]);

  return (
    <>
      {/* One solid block behind each player's gathered pile and its label, so the two read as one unit: the pile, the
          label and the gap between them (not their bounding box, which can reach a neighbour's). The blocks and the labels
          are under the canvas: the cards land on a block, and a card on its way to its pile passes over the words. */}
      {plan.piles.map((p, i) => (
        <div key={`b${p.seat}`} className={`heap-block${L.cleared ? ' set' : ''}${done >= turn[i]! ? ' on' : ''}`}>
          {blockParts(p).map((r, k) => (
            <i key={k} style={{ left: r.x, top: r.y, width: r.w, height: r.h }} />
          ))}
        </div>
      ))}
      <canvas ref={canvas} className="wash" style={{ left: plan.area.x, top: plan.area.y, width: plan.area.w, height: plan.area.h }} />
      {plan.piles.map((p, i) => {
        const left = scores.find((s) => s.seat === p.seat)?.nertzLeft ?? 0;
        const won = done >= n && delta(p.seat) === best;
        // Which end of its box the pile is at: the text is set against that end.
        const off = p.label.x + p.label.w / 2 - (p.x + p.w / 2);
        const set = p.side === 'right' || off > 2 ? 'start' : p.side === 'left' || off < -2 ? 'end' : 'mid';
        return (
          <div
            key={p.seat}
            className={`heap ${set}${L.cleared ? ' set' : ''}${plan.label.short ? ' short' : ''}${plan.label.tile ? ' tile' : ''}${done >= turn[i]! ? ' on' : ''}${done > turn[i]! ? ' sorted' : ''}${done >= n ? ' all' : ''}${won ? ' best' : ''}`}
            style={{ left: p.label.x, top: p.label.y, width: plan.label.w, height: plan.label.h, scale: plan.label.k === 1 ? undefined : plan.label.k }}
          >
            <span className="who">
              <i className="chip" style={{ background: backColour(p.seat) }} />
              <span>{won ? `★ ${name(p.seat)}` : name(p.seat)}</span>
              {won && !plan.label.short && <em>wins the round</em>}
            </span>
            <span className="line got">
              <b>{signed(landed[i] ?? 0)}</b> played
            </span>
            <span className={`line fine${left ? '' : ' none'}`}>
              <b>{signed(-2 * left)}</b> {plan.label.short ? (left ? `${left} left` : 'none left') : left ? `${left} nertz left` : 'no nertz left'}
            </span>
            <b className="net">{signed(delta(p.seat))}</b>
          </div>
        );
      })}
      {stamps.map(({ seat, at }) => (
        <div key={seat} className="restamp" style={{ left: at.x, top: at.y, width: at.w, height: at.h, fontSize: at.h }}>
          <span>Nertz!</span>
        </div>
      ))}
    </>
  );
}
