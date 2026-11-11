// Table geometry. A pure function from (viewport, game) to where every
// visible card sits. Every card is absolutely positioned on one layer and
// keyed by its id, so a card moving between piles - yours or anyone's - is
// just the same element animating to new coordinates.
import { DEAL_MS, isHidden } from '../shared/engine';
import type { AnyCard, GameState, PlayerState } from '../shared/types';
import { CARD_H, CARD_W } from './cards/Face';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type PileKind = 'nertz' | 'work' | 'stock' | 'waste' | 'slot' | 'tray';

/**
 * Where the table is in its life. 'live' is a round in play. The others are
 * the end-of-round sequence: centre piles turn face-down ('flip'), tray piles
 * turn over and come out ('out'), then the middle's cards leave this layer
 * altogether and are washed and sorted on a canvas ('wash'), and finally the
 * score sheet lies on top ('sheet').
 */
export type Stage = 'live' | 'flip' | 'out' | 'wash' | 'sheet';

export interface Placed {
  card: AnyCard;
  x: number;
  y: number;
  /** Scale relative to the CARD_W x CARD_H drawing size. */
  s: number;
  z: number;
  /** Show the face (the card is known and not lying face-down). */
  up: boolean;
  pile: PileKind;
  /** In one of the viewing player's own piles. */
  mine: boolean;
  /** For 'slot' and 'tray' cards: which slot, or which tray pile. */
  at: number;
}

export interface Seat {
  seat: number;
  s: number;
  /** Where the top card of each pile sits (or would sit, for an empty pile). */
  nertz: Rect;
  work: Rect[];
  /** Drop area of each work pile: its whole column. Neighbours never touch. */
  workHit: Rect[];
  stock: Rect;
  waste: Rect;
  /** Bounding box of the whole hand. */
  box: Rect;
  nertzCount: number;
}

export interface Layout {
  cards: Placed[];
  me: Seat | null;
  opponents: Seat[];
  /** One per centre slot, in slot order. */
  slots: Rect[];
  /** Drop area of each slot: the slot plus a margin smaller than half the gap, so neighbours never touch. */
  slotHit: Rect[];
  /** The side area for completed piles. */
  tray: Rect;
  /** Where each tray pile stands once it has come out onto the table at the end of a round. */
  out: Rect[];
  /** The free felt between the opponents and your hand. */
  middle: Rect;
  /** Scale of cards in the middle. */
  fs: number;
}

const RATIO = CARD_H / CARD_W;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const grow = (r: Rect, m: number): Rect => ({ x: r.x - m, y: r.y - m, w: r.w + 2 * m, h: r.h + 2 * m });
export const inside = (r: Rect, x: number, y: number): boolean => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;

/**
 * The one drop area a release counts for: the area under the pointer, and
 * only if the pointer is over none, the area under the centre of the grabbed
 * card. A card picked up by its corner is aimed with the pointer; one flung
 * with the pointer trailing off the pile still lands by where it lies. Either
 * way it is one specific pile, and areas never overlap.
 */
export function dropTarget<T extends { hit: Rect }>(targets: readonly T[], pointer: { x: number; y: number }, centre: { x: number; y: number } | null): T | undefined {
  return targets.find((t) => inside(t.hit, pointer.x, pointer.y)) ?? (centre ? targets.find((t) => inside(t.hit, centre.x, centre.y)) : undefined);
}

/** Room the grace countdown is given on the table: its greatest width, its height, and its distance from the right edge. */
export const COUNTDOWN = { w: 168, h: 44, right: 14 };

/**
 * Where the grace countdown goes: the top-right corner, or if an opponent
 * sits there, the first place down the right edge that is clear of every
 * opponent's hand and name (beside a shorter second row, or just under them).
 */
export function countdownTop(L: Layout, W: number): number {
  const x = W - COUNTDOWN.right - COUNTDOWN.w;
  const hands = L.opponents.map((o) => ({ ...o.box, y: o.box.y - 28, h: o.box.h + 28 })); // with the name above it
  const clear = (y: number) => !hands.some((r) => r.x + r.w > x && r.y < y + COUNTDOWN.h && y < r.y + r.h);
  return [12, ...hands.flatMap((r) => [r.y, r.y + r.h + 6]).filter((y) => y > 12)].sort((a, b) => a - b).find(clear) ?? 12;
}

/** Faces narrower than this on screen use the large-print rendition. */
export const MINI_BELOW = 52;

/** The stock shows one edge for every this many cards left, so you can see it getting thin. */
const STOCK_PER_EDGE = 3;
/** A stock this many edges high (or higher: the deck being dealt) has its top card level with the other piles. */
const STOCK_FULL_EDGES = 10;
const WASTE_SHOWN = 4;
/** A face-down card in a work pile shows this much of the strip a face-up card shows. */
const DOWN_STEP = 0.45;

interface HandSpec {
  x: number;
  y: number;
  w: number; // card width
  gap: number; // between neighbouring piles
  wide: number; // between the groups (nertz | work | stock+waste)
  fan: number; // waste fan offset; 0 = stacked
  workFan: number; // preferred vertical offset in a work pile
  workRoom: number; // height available to a work pile below its first card
  workRise: number; // how far above the row a pile too long for that may start instead (free felt above the hand)
  minStrip: number; // the least a face-up card may show while there is room: its whole rank. 0 = squeeze all alike
  z: number;
  mine: boolean;
}

/**
 * How far below a fanned pile's first card each card sits. `show[j]` is how
 * much of card j shows relative to a face-up card. Every card shows `fan` if
 * that fits in `room`. If not, all are squeezed alike while a face-up card
 * still shows `min` (its whole rank). Past that only the oldest cards give
 * way, down to slivers, and the newest keep `min`: they are the ones in play.
 */
export function fanOut(show: readonly number[], fan: number, min: number, room: number): number[] {
  const covered = show.slice(0, -1); // the top card lies open
  const total = covered.reduce((a, b) => a + b, 0);
  const even = Math.min(fan, total > 0 ? room / total : fan);
  const sliver = min * 0.4;
  let steps = covered.map((w) => w * even);
  if (even < min && room > total * sliver) {
    let spare = room - total * sliver;
    steps = covered.map((w) => w * sliver);
    for (let j = steps.length - 1; j >= 0 && spare > 0; j--) {
      const more = Math.min(spare, covered[j]! * (min - sliver));
      steps[j]! += more;
      spare -= more;
    }
  }
  let y = 0;
  return [0, ...steps.map((s) => (y += s))];
}

function placeHand(p: PlayerState, h: HandSpec, out: Placed[]): Seat {
  const s = h.w / CARD_W;
  const ch = h.w * RATIO;
  const rect = (x: number, y: number): Rect => ({ x, y, w: h.w, h: ch });
  const put = (card: AnyCard, x: number, y: number, z: number, pile: PileKind) =>
    out.push({ card, x, y, s, z: h.z + z, up: !isHidden(card) && pile !== 'stock', pile, mine: h.mine, at: 0 });

  // Nertz pile: lower cards peek out underneath so the pile shows its thickness.
  const lean = 0.55 * s;
  p.nertz.forEach((c, i) => put(c, h.x, h.y + (p.nertz.length - 1 - i) * lean, i, 'nertz'));

  // Work piles fan downwards; the face-down cards at the bottom of the pile take a narrower strip each.
  const workX = h.x + h.w + h.wide;
  const margin = h.gap * 0.4;
  const workHit: Rect[] = [];
  const work = p.work.map((pile, i) => {
    const x = workX + i * (h.w + h.gap);
    const down = p.down[i] ?? 0;
    const show = pile.map((_, j) => (j < down ? DOWN_STEP : 1));
    // A pile too long for the room below the row starts higher up instead, as far as the felt above it is free.
    const wanted = show.slice(0, -1).reduce((a, b) => a + b, 0) * h.workFan;
    const rise = clamp(wanted - h.workRoom, 0, h.workRise);
    const at = fanOut(show, h.workFan, h.minStrip, h.workRoom + rise);
    pile.forEach((c, j) => put(c, x, h.y - rise + at[j]!, 40 + i * 20 + j, 'work'));
    workHit.push({ x: x - margin, y: h.y - rise - margin, w: h.w + 2 * margin, h: ch + h.workRoom + rise + 2 * margin });
    return rect(x, h.y - rise + (at.at(-1) ?? 0));
  });

  const stockX = workX + 4 * h.w + 3 * h.gap + h.wide;
  // Every third card shows an edge, and so does the top one. A card's height in the stack depends only on how many
  // cards lie under it, so taking cards off the top never moves the ones that stay: the stack just gets lower.
  const top = p.stock.length - 1;
  p.stock.forEach((c, j) => {
    if (j % STOCK_PER_EDGE === 0 || j === top) put(c, stockX, h.y + Math.max(0, STOCK_FULL_EDGES - j / STOCK_PER_EDGE) * lean * 2, 20 + j, 'stock');
  });

  const wasteX = stockX + h.w + h.gap;
  const n = p.waste.length;
  const fanned = Math.min(3, n);
  for (let i = Math.max(0, n - WASTE_SHOWN); i < n; i++) {
    const pos = Math.max(0, fanned - 1 - (n - 1 - i));
    put(p.waste[i]!, wasteX + pos * h.fan, h.y, 30 + (i - (n - WASTE_SHOWN)), 'waste');
  }

  const right = wasteX + h.w + 2 * h.fan;
  return {
    seat: p.seat,
    s,
    nertz: rect(h.x, h.y),
    work,
    workHit,
    stock: rect(stockX, h.y),
    waste: rect(wasteX + Math.max(0, fanned - 1) * h.fan, h.y),
    box: { x: h.x, y: h.y, w: right - h.x, h: ch + h.workRoom },
    nertzCount: p.nertz.length,
  };
}

/** Width of a hand in card widths, for the gaps used below. */
const OWN = { gap: 0.2, wide: 0.5, fan: 0.3 };
const OWN_UNITS = 7 + 4 * OWN.gap + 2 * OWN.wide + 2 * OWN.fan;
const OPP = { gap: 0.14, wide: 0.42 };
const OPP_UNITS = 7 + 4 * OPP.gap + 2 * OPP.wide;
/** The tray: one card wide plus padding, standing this far to the right of the slot grid. */
const TRAY_PAD = 0.12;
const TRAY_UNITS = 1 + 2 * TRAY_PAD;
const TRAY_GAP = 22;
const SLOT_GAP = 10;

export function computeLayout(W: number, H: number, game: GameState, you: number, stage: Stage = 'live'): Layout {
  const cards: Placed[] = [];
  const mine = game.players.find((p) => p.seat === you);
  // Opponents in seat order starting after you, so the table reads as a circle.
  const at = game.players.findIndex((p) => p.seat === you);
  const others = [...game.players.slice(at + 1), ...game.players.slice(0, Math.max(0, at))];
  const edge = 16;

  // Your hand: bottom, as large as the window allows.
  const ow = mine ? clamp(Math.min((W - 2 * edge) / (OWN_UNITS + 0.4), H * 0.132), 34, 104) : 0;
  const oh = ow * RATIO;
  const ownTop = mine ? H - 12 - oh * 2.2 : H - 12;
  // Opponents: compact hands along the top - in two rows when one row would
  // make them tiny and the window is tall enough to keep the middle roomy.
  // The middle: a grid with one cell per slot (4 per player), and the tray
  // standing to its right.
  const n = others.length;
  const labelH = 28;
  const count = game.slots.length;
  const gap = SLOT_GAP;
  const bottom = ownTop - 22;
  const plan = (oppRows: number) => {
    const perRow = Math.ceil(n / oppRows) || 1;
    const lane = (W - 2 * edge) / perRow;
    const mw = n ? clamp(Math.min((lane - 24) / OPP_UNITS, mine ? ow * 0.62 : 80, H * (oppRows > 1 ? 0.055 : 0.09)), 18, 80) : 0;
    const rowH = labelH + mw * RATIO * 1.85;
    const top = 10 + (n ? oppRows * rowH : 0) + 18;
    let grid = { fw: 0, cols: count, rows: 1 };
    for (let rows = 1; rows <= 4; rows++) {
      const cols = Math.ceil(count / rows);
      const fw = Math.min(
        mine ? ow * 0.92 : 90,
        (W * 0.94 - (cols - 1) * gap - TRAY_GAP) / (cols + TRAY_UNITS),
        (bottom - top - (rows - 1) * gap) / rows / RATIO,
      );
      if (fw > grid.fw + 0.5) grid = { fw, cols, rows };
    }
    return { perRow, lane, mw, rowH, top, grid, worst: Math.min(grid.fw, mw * 1.6) };
  };
  const one = plan(1);
  const two = n >= 4 ? plan(2) : one;
  const { perRow, lane, mw, rowH, top, grid: best } = two.worst > one.worst ? two : one;
  const mh = mw * RATIO;
  const opponents = others.map((p, i) => {
    const inRow = Math.min(perRow, n - Math.floor(i / perRow) * perRow);
    const rowLeft = edge + (W - 2 * edge - inRow * lane) / 2;
    return placeHand(
      p,
      {
        x: rowLeft + lane * (i % perRow) + (lane - OPP_UNITS * mw) / 2,
        y: 10 + Math.floor(i / perRow) * rowH + labelH,
        w: mw,
        gap: mw * OPP.gap,
        wide: mw * OPP.wide,
        fan: 0,
        workFan: mh * 0.4,
        workRoom: mh * 0.85,
        workRise: 0,
        minStrip: 0,
        z: 1000 + i * 200,
        mine: false,
      },
      cards,
    );
  });

  const fw = Math.max(16, best.fw);
  const fh = fw * RATIO;
  const fs = fw / CARD_W;
  const middle: Rect = { x: edge, y: top, w: W - 2 * edge, h: Math.max(fh, bottom - top) };
  const gridW = best.cols * fw + (best.cols - 1) * gap;
  const gridH = best.rows * fh + (best.rows - 1) * gap;
  const pad = fw * TRAY_PAD;
  const gx = (W - (gridW + TRAY_GAP + fw * TRAY_UNITS)) / 2;
  const gy = top + Math.max(0, (bottom - top - gridH) / 2);
  const slots = game.slots.map((_, i): Rect => ({ x: gx + (i % best.cols) * (fw + gap), y: gy + Math.floor(i / best.cols) * (fh + gap), w: fw, h: fh }));

  // The tray is as tall as the grid (taller if the grid is a single row and there is room), so piles can cascade down it.
  const trayH = Math.min(middle.h, Math.max(gridH + 2 * pad, fh * 1.9));
  const tray: Rect = { x: gx + gridW + TRAY_GAP, y: clamp(gy + gridH / 2 - trayH / 2, top, top + middle.h - trayH), w: fw * TRAY_UNITS, h: trayH };
  const trays = game.tray.length;
  const trayStep = trays > 1 ? Math.min(fh * 0.26, (trayH - 2 * pad - fh) / (trays - 1)) : 0;
  // End of round: the tray piles walk out to a row across the middle of the table.
  const outStep = trays > 1 ? Math.min(fw * 1.15, (middle.w * 0.8 - fw) / (trays - 1)) : 0;
  const out = game.tray.map((_, k): Rect => ({ x: W / 2 - (outStep * (trays - 1) + fw) / 2 + k * outStep, y: middle.y + (middle.h - fh) / 2, w: fw, h: fh }));

  // Your hand is placed last: a long work pile may rise into the felt between the row and whatever stands above
  // its columns (slots, or the tray in a narrow window). The slots never move for it.
  const handX = (W - OWN_UNITS * ow) / 2;
  const columns: Rect = { x: handX + ow * (1 + OWN.wide) - ow * OWN.gap, y: 0, w: ow * (4 + 5 * OWN.gap), h: H };
  const above = Math.max(top, ...[...slots, tray].filter((r) => r.x < columns.x + columns.w && columns.x < r.x + r.w).map((r) => r.y + r.h));
  const me = mine
    ? placeHand(
        mine,
        {
          x: handX,
          y: ownTop,
          w: ow,
          gap: ow * OWN.gap,
          wide: ow * OWN.wide,
          fan: ow * (ow < MINI_BELOW ? 0.55 : OWN.fan), // large-print faces need a wider fan to show the rank
          workFan: oh * 0.3,
          workRoom: H - 8 - ownTop - oh,
          // (Not once the wash begins: that felt is where the sorted piles' counts go.)
          workRise: stage === 'wash' || stage === 'sheet' ? 0 : Math.max(0, ownTop - 14 - above),
          minStrip: oh * 0.21,
          z: 3000,
          mine: true,
        },
        cards,
      )
    : null;

  // The middle's cards. Only the top two of a pile are drawn: the one underneath stays visible while the next flies in.
  // Once the wash starts they are drawn on the finale's canvas instead.
  if (stage !== 'wash' && stage !== 'sheet') {
    const put = (pile: readonly AnyCard[], r: Rect, z: number, kind: PileKind, i: number, up: boolean) =>
      pile.slice(-2).forEach((card, k) => cards.push({ card, x: r.x, y: r.y, s: fs, z: z + k, up, pile: kind, mine: false, at: i }));
    game.slots.forEach((pile, i) => put(pile, slots[i]!, 5000 + i * 4, 'slot', i, stage === 'live'));
    game.tray.forEach((pile, k) => {
      const home: Rect = { x: tray.x + pad, y: tray.y + pad + k * trayStep, w: fw, h: fh };
      put(pile, stage === 'out' ? out[k]! : home, 5200 + k * 4, 'tray', k, stage !== 'out');
    });
  }

  return { cards, me, opponents, slots, slotHit: slots.map((r) => grow(r, gap * 0.35)), tray, out, middle, fs };
}

// ---------------------------------------------------------------- the deal

/**
 * The deal at the start of a round. After `lead` ms the work piles are dealt
 * off each deck at an unhurried `step`; then, after a `pause`, the nertz pile
 * is counted off as one quick ribbon (a card every `stream` ms). Each card
 * takes `duration` s to land, and the last is down a beat before the server's
 * DEAL_MS is up and the face-up cards turn over.
 */
export const DEAL = { lead: 100, step: 130, pause: 180, stream: 50, duration: 0.38, ease: [0.2, 0.8, 0.2, 1] } as const;

/**
 * How long until the `i`th card to leave a deck does so (the `work` work-pile
 * cards first, then the nertz pile), in a window that was told `dealMs` of the
 * deal remain. Null if it has left already (a window that arrived late): that
 * card is simply in its place.
 */
export function dealWait(i: number, dealMs: number, work = 10): number | null {
  const at = i < work ? i * DEAL.step : work * DEAL.step + DEAL.pause + (i - work) * DEAL.stream;
  const wait = DEAL.lead + at - (DEAL_MS - dealMs);
  return wait >= 0 ? wait : null;
}
