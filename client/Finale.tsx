// The end of a round, played on the table: every card that reached the middle
// is washed on the felt (spread and swirled, backs up), then the wash is drawn
// in to the middle of the felt and sorted into one pile per player, each out
// in front of its player's hand as this window draws the seating. Up to ~300
// cards move at once, so they are drawn on one canvas from pre-rendered back
// sprites instead of being 300 animated elements; the labels beside the piles
// are ordinary DOM.
import { useEffect, useMemo, useRef, useState } from 'react';
import { feltHw, offFelt } from '../shared/table';
import type { GameState, RoundScore } from '../shared/types';
import { backArt, backColour, CARD_H, CARD_W } from './cards/Face';
import { MINI_BELOW } from './layout';
import { seatDir, slotStack, TAG_H, trayStack, type Layout, type Rect } from './layout';

/** How long each step of the end-of-round sequence takes (ms). */
export const TIMING = { flip: 1000, spread: 900, out: 1100, wash: 1000, sortEach: 1500, hold: 6500 };
/**
 * The finale's own clock starts when the centre piles are spread out ('spread'). With finished piles in the tray,
 * those come out next and are spread out in their turn, `trayAt` ms in; with none there is only a short beat. Then the
 * sorting starts, `sortAt` ms in.
 */
export const trayAt = TIMING.spread + TIMING.out;
export const sortAt = (trayPiles: number): number => (trayPiles ? trayAt + TIMING.wash : TIMING.spread + 400);
/** The piles are gathered one player at a time: this long for `n` players. */
export const sortMs = (n: number): number => n * TIMING.sortEach;
const SPREAD_MS = 560; // a card's trip from its pile out into the wash
const LAND_MS = 420; // a card's trip from the wash onto its owner's pile
/** How much of the table's width and height the mixed-up wash spreads over. */
const WASH_SPREAD = { x: 0.62, y: 0.6 };
/** The label beside a sorted pile (name, played, penalty, net score): it is laid out in a box of exactly this size. */
export const LABEL = { w: 176, h: 62 };
/** A label lying partly off the window is this many times worse than one lying over a hand: off the window it cannot be read at all. */
const OFF_WINDOW = 8;
/** Clear felt between a sorted pile and the edge of the felt, and between it and the wash or its label. */
const RIM = 5;
/** How far the solid block behind a pile and its label reaches beyond the two. */
const BLOCK_PAD = 4;
const GAP = 6;
/** How far the cards of the drawn-in wash still stray from the middle line of the felt. */
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
const easeOut = (t: number) => 1 - (1 - t) ** 3;
const easeInOut = (t: number) => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2);
/** Repeatable noise in [0, 1): the same card gets the same path on every frame and after a resize. */
function noise(i: number, salt: number): number {
  let t = (Math.imul(i + 1, 0x9e3779b1) ^ Math.imul(salt + 1, 0x85ebca6b)) >>> 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

interface Mover {
  owner: number;
  /** Start: the pile it lay in. */
  x: number;
  y: number;
  /** Place in the wash: angle and radius (0..1) around the middle, and how far it turns. */
  angle: number;
  radius: number;
  spin: number;
  delay: number;
  /** When it joins the wash, ms on the finale's clock: at once, or for a card of a finished pile once that has come out of the tray (until then it is not drawn here). */
  from: number;
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
  /** A card in a sorted pile, as a share of that (smaller where the felt is low for its cards: a table for two). */
  scale: number;
  /** The middle of the felt, and how far from it the centres of the washed cards go. */
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  /** The same once the wash has been drawn in for sorting, and the box that heap then lies within. */
  core: { rx: number; ry: number };
  heap: Rect;
}

const overlap = (a: Rect, b: Rect): number =>
  Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));

/**
 * Geometry of the whole sequence. Pure, so a resize mid-way just continues with new numbers.
 *
 * The wash turns on the felt. Each player's pile is then gathered at the edge
 * of the felt, out towards that player's chair as this window seats them:
 * yours at the bottom, everyone else's round the table from there. The label goes beside
 * its pile, on whichever side is clear of every hand, the tray, the wash, the
 * other piles and the other labels.
 */
export function planFinale(L: Layout, game: GameState): Plan {
  const w = L.fs * CARD_W;
  const h = L.fs * CARD_H;
  const d = { cx: L.felt.cx, cy: L.felt.cy, rx: feltHw(game.players.length) * L.felt.u, ry: L.felt.u };
  const n = game.players.length;
  // The drawn-in wash is a low heap along the middle of the felt. What is left of the felt's height above and below
  // it is what a pile in front of the seats at the top and the bottom can have.
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
  const spots = game.players.map((p, i) => {
    const v = seatDir((i - view + n) % n, n);
    let k = 1.5;
    while (k > 0.3 && !onFelt(d.cx + v.x * d.rx * k, d.cy + v.y * d.ry * k)) k -= 0.005;
    return { seat: p.seat, v, x: d.cx + v.x * d.rx * k - pw / 2, y: d.cy + v.y * d.ry * k - ph / 2, w: pw, h: ph };
  });

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
  // pile's favourite place may be the only one left for another's (there are at most six piles and twelve places
  // each). If the window is too small for that, the arrangement that overlaps least.
  let labels = choices.map((options) => options[0]!);
  let least = Infinity;
  const pick: (typeof labels)[number][] = [];
  let tries = 0;
  const search = (i: number, cost: number): void => {
    if (cost >= least || ++tries > 200000) return;
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
  const piles: SortedPile[] = spots.map((s, i) => ({ seat: s.seat, x: s.x, y: s.y, w: pw, h: ph, total: 0, label: labels[i]!.box, side: labels[i]!.side }));
  const pileOf = new Map(piles.map((p, i) => [p.seat, i]));

  const lying = [...game.slots.map((pile, i) => ({ pile, at: L.slots[i], tray: -1, slot: i })), ...game.tray.map((pile, i) => ({ pile, at: L.out[i], tray: i, slot: -1 }))];
  const movers = lying.flatMap(({ pile, at, tray, slot }) =>
    pile.flatMap((card, j): Mover[] => {
      const to = pileOf.get(card.owner);
      if (!at || to === undefined) return [];
      // Every pile starts the wash as the loose stack it was turned over or came out of the tray as (see `stackOffset`).
      const o = tray < 0 ? slotStack(slot, j, at.w) : trayStack(tray, j, at.w);
      return [{ owner: card.owner, x: at.x + o.x, y: at.y + o.y, angle: 0, radius: 0, spin: 0, delay: 0, from: tray < 0 ? 0 : trayAt, pile: to, k: 0, of: 0, tilt: 0, rot0: ((o.rot + ('rot' in at ? (at as { rot: number }).rot : 0)) * Math.PI) / 180 }];
    }),
  );
  // Draw order is shuffled so the colours mix in the wash; a card's place in its sorted pile follows the draw order.
  const order = movers.map((_, i) => noise(i, 1));
  const shuffled = movers.map((mv, i) => ({ mv, o: order[i]! })).sort((a, b) => a.o - b.o).map((e) => e.mv);
  shuffled.forEach((mv, i) => {
    mv.angle = noise(i, 2) * Math.PI * 2;
    mv.radius = Math.sqrt(0.04 + 0.96 * noise(i, 3)); // even over the felt
    mv.spin = (noise(i, 4) - 0.5) * 2.4 * Math.PI;
    mv.delay = noise(i, 5);
    mv.tilt = (noise(i, 6) - 0.5) * TILT;
    mv.k = piles[mv.pile]!.total++;
  });
  for (const mv of shuffled) mv.of = piles[mv.pile]!.total;
  const span = Math.hypot(w, h) / 2 + 8; // a card turned to any angle, plus its shadow
  const area: Rect = { x: Math.floor(d.cx - d.rx - span), y: Math.floor(d.cy - d.ry - span), w: Math.ceil(2 * (d.rx + span)), h: Math.ceil(2 * (d.ry + span)) };
  // The wash keeps to the felt: an oval well inside its edge, clear of the rounded corners.
  return { area, sortAt: sortAt(game.tray.length), movers: shuffled, piles, w, h, scale, cx: d.cx, cy: d.cy, rx: Math.max(w, d.rx * 0.8 - w / 2), ry: Math.max(h * 0.2, d.ry * 0.88 - h / 2), core, heap };
}

/** One card back, drawn once per colour and then stamped for every card of that deck. Matches `.back` in styles.css. */
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

const plan0 = (game: GameState): number[] => game.players.map((p) => p.seat);

/** One card's back, drawn once: the plain cross-hatch, or the back its owner chose (`art`) once its picture has arrived. */
function backSprite(colour: string, w: number, h: number, dpr: number, art?: { img: HTMLImageElement; picture: boolean; zoom: number; edge: boolean }): HTMLCanvasElement {
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
    // As `.back.tint` and `.back.pic` in the stylesheet: the pattern over the player's colour, or the picture framed in it.
    // (A small card may show only the middle of a picture; some patterns lie inside a white edge: `backArt`.)
    const f = art.picture || art.edge ? 5 * u : 0;
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
  const b = 4.5 * u;
  c.beginPath();
  c.roundRect(b, b, w - 2 * b, h - 2 * b, 2.5 * u);
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
  c.strokeStyle = 'rgba(255, 255, 255, 0.75)';
  c.lineWidth = 1.2 * u;
  c.beginPath();
  c.roundRect(b, b, w - 2 * b, h - 2 * b, 2.5 * u);
  c.stroke();
  return sprite;
}

/**
 * Draws the table `t` ms into the wash and returns how many cards have landed on each sorted pile.
 * `order[i]` is when pile i is gathered (0 first): one player's cards at a time.
 */
function paint(c: CanvasRenderingContext2D, plan: Plan, sprites: Map<number, HTMLCanvasElement>, dpr: number, t: number, order: readonly number[] = []): number[] {
  const { w, h } = plan;
  const pad = Math.ceil(w * 0.08);
  const landed = plan.piles.map(() => 0);
  // The wash is simply one big mixed-up mess in the middle: the cards slide out of their piles to scattered places,
  // at all angles, and lie there. It does not turn, and it is not tidied up before the cards go out to their owners.
  const rx = plan.rx * WASH_SPREAD.x;
  const ry = plan.ry * WASH_SPREAD.y;
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.clearRect(0, 0, c.canvas.width, c.canvas.height);
  /** A card with its centre at (x, y), turned by `rot`, `size` times as large as a card in the wash. */
  const stamp = (mv: Mover, x: number, y: number, rot: number, size: number) => {
    const cos = Math.cos(rot) * dpr * size;
    const sin = Math.sin(rot) * dpr * size;
    c.setTransform(cos, sin, -sin, cos, (x - plan.area.x) * dpr, (y - plan.area.y) * dpr);
    c.drawImage(sprites.get(mv.owner)!, -w / 2 - pad, -h / 2 - pad, w + 2 * pad, h + 2 * pad);
  };
  type Stamp = [Mover, number, number, number, number];
  const wash: Stamp[] = [];
  const resting: Stamp[] = [];
  for (const mv of plan.movers) {
    const pile = plan.piles[mv.pile]!;
    if (t < mv.from) continue; // still a pile in the tray, or on its way out of it: drawn by the table
    const q = easeInOut(clamp01((t - plan.sortAt - (order[mv.pile] ?? mv.pile) * TIMING.sortEach - (mv.k / mv.of) * (TIMING.sortEach - LAND_MS - 250)) / LAND_MS));
    // A sorted pile leans up and to the left a little with every card, so its thickness shows.
    const { x: px, y: py } = restAt(pile, mv.k, mv.of);
    if (q >= 1) {
      landed[mv.pile]!++;
      resting.push([mv, px, py, mv.tilt, plan.scale]);
      continue;
    }
    // In the wash: out from its pile to a spot on the felt, which then turns (the inside faster) and breathes.
    const spread = easeOut(clamp01((t - mv.from - mv.delay * 280) / SPREAD_MS));
    const a = mv.angle;
    const r = mv.radius;
    let x = lerp(mv.x + w / 2, plan.cx + Math.cos(a) * r * rx, spread);
    let y = lerp(mv.y + h / 2, plan.cy + Math.sin(a) * r * ry, spread);
    let rot = lerp(mv.rot0, mv.spin * 0.5, spread);
    let size = 1;
    if (q > 0) {
      x = lerp(x, px, q);
      y = lerp(y, py, q);
      rot = lerp(rot, mv.tilt, q);
      size = lerp(1, plan.scale, q);
    }
    wash.push([mv, x, y, rot, size]);
  }
  // A card on its way out to its pile keeps its place in the heap: it slides out from under whatever lay on it, and
  // never jumps to the top. The gathered piles are clear of the wash, and are drawn first, so it still lands on top
  // of its own (cards land in the order they lie in the heap).
  for (const f of [...resting, ...wash]) stamp(...f);
  return landed;
}

const signed = (n: number) => (n > 0 ? `+${n}` : n < 0 ? `−${-n}` : '0');

interface Props {
  L: Layout;
  game: GameState;
  scores: readonly RoundScore[];
  name: (seat: number) => string;
  /** Show the finished picture at once (skipped, reduced motion, or arriving after the fact). */
  instant: boolean;
  /** The back each player chose for their cards. */
  backs?: (seat: number) => string | undefined;
}

export function Finale({ L, game, scores, name, instant, backs }: Props) {
  // (A back's picture that has not arrived yet: the cards are plain until it has, and then drawn again.)
  const [arrived, setArrived] = useState(0);
  const chosen = plan0(game).map((seat) => backs?.(seat) ?? '').join();
  const plan = useMemo(() => planFinale(L, game), [L, game]);
  const canvas = useRef<HTMLCanvasElement>(null);
  const began = useRef(0);
  const [landed, setLanded] = useState<number[]>(() => plan.piles.map((p) => (instant ? p.total : 0)));
  const n = plan.piles.length;
  /** How many piles have been gathered so far; -1 while the wash is still turning. */
  const [done, setDone] = useState(instant ? n : -1);
  // The round's lowest score is gathered first and its best last.
  const delta = (seat: number) => scores.find((s) => s.seat === seat)?.delta ?? 0;
  const turn = useMemo(() => {
    const by = plan.piles.map((_, i) => i).sort((a, b) => delta(plan.piles[a]!.seat) - delta(plan.piles[b]!.seat) || a - b);
    const at: number[] = [];
    by.forEach((i, k) => (at[i] = k));
    return at;
  }, [plan, scores]);
  const best = Math.max(...plan.piles.map((p) => delta(p.seat)));

  useEffect(() => {
    const el = canvas.current;
    const c = el?.getContext('2d');
    if (!el || !c) return;
    const full = Math.min(2, window.devicePixelRatio || 1);
    let scale = full;
    let sprites = new Map<number, HTMLCanvasElement>();
    const setup = (k: number) => {
      scale = k;
      el.width = Math.round(plan.area.w * k);
      el.height = Math.round(plan.area.h * k);
      sprites = new Map(
        plan.piles.map((p) => {
          const art = backArt(backs?.(p.seat), plan.w < MINI_BELOW);
          const img = art && pictureOf(art.src, () => setArrived((a) => a + 1));
          return [p.seat, backSprite(backColour(p.seat), plan.w, plan.h, k, art && img ? { img, picture: art.picture, zoom: art.zoom, edge: art.edge } : undefined)];
        }),
      );
    };
    setup(full);
    began.current ||= performance.now();
    const end = plan.sortAt + sortMs(n);
    let raf = 0;
    let shown = '';
    let last = 0;
    let late = 0;
    const frame = (now: number) => {
      const t = instant ? end : now - began.current;
      // Measured, not guessed: if this machine keeps missing frames at full resolution (a high-density screen
      // without a GPU), draw the moving cards at 1x. Nobody can tell while they move, and the piles they come
      // to rest in are redrawn sharp below.
      if (scale > 1 && last && now - last > 24 && ++late >= 5) setup(1);
      last = now;
      if (t >= end && scale < full) setup(full);
      const counts = paint(c, plan, sprites, scale, t, turn);
      if (counts.join() !== shown) {
        shown = counts.join();
        setLanded(counts);
      }
      setDone(t >= end ? n : t < plan.sortAt ? -1 : Math.floor((t - plan.sortAt) / TIMING.sortEach));
      if (t >= end) return;
      raf = requestAnimationFrame(frame);
    };
    frame(performance.now());
    return () => cancelAnimationFrame(raf);
  }, [plan, instant, turn, n, arrived, chosen]);

  return (
    <>
      {/* One solid block behind each player's gathered pile and its label, so the two read as one unit: the pile, the
          label and the gap between them (not their bounding box, which can reach a neighbour's). Under the canvas: the
          cards land on it. */}
      {plan.piles.map((p, i) => (
        <div key={`b${p.seat}`} className={`heap-block${done >= turn[i]! ? ' on' : ''}`}>
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
            className={`heap ${set}${done >= turn[i]! ? ' on' : ''}${done > turn[i]! ? ' sorted' : ''}${done >= n ? ' all' : ''}${won ? ' best' : ''}`}
            style={{ left: p.label.x, top: p.label.y, width: p.label.w, height: p.label.h }}
          >
            <span className="who">
              <i className="chip" style={{ background: backColour(p.seat) }} />
              <span>{won ? `★ ${name(p.seat)}` : name(p.seat)}</span>
              {won && <em>wins the round</em>}
            </span>
            <span className="line got">
              <b>{signed(landed[i] ?? 0)}</b> played
            </span>
            <span className={`line fine${left ? '' : ' none'}`}>
              <b>{signed(-2 * left)}</b> {left ? `${left} nertz left` : 'no nertz left'}
            </span>
            <b className="net">{signed(delta(p.seat))}</b>
          </div>
        );
      })}
    </>
  );
}
