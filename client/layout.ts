// Table geometry. A pure function from (viewport, game) to where every
// visible card sits. Every card is absolutely positioned on one layer and
// keyed by its id, so a card moving between piles - yours or anyone's - is
// just the same element animating to new coordinates.
import { isComplete, isHidden } from '../shared/engine';
import type { AnyCard, GameState, PlayerState } from '../shared/types';
import { CARD_H, CARD_W } from './cards/Face';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type PileKind = 'nertz' | 'work' | 'stock' | 'waste' | 'foundation';

export interface Placed {
  card: AnyCard;
  x: number;
  y: number;
  /** Scale relative to the CARD_W x CARD_H drawing size. */
  s: number;
  z: number;
  /** Show the face (the card is known and not lying in a stock). */
  up: boolean;
  pile: PileKind;
  /** In one of the viewing player's own piles. */
  mine: boolean;
  /** On a finished foundation. */
  done: boolean;
}

export interface Seat {
  seat: number;
  s: number;
  /** Where the top card of each pile sits (or would sit, for an empty pile). */
  nertz: Rect;
  work: Rect[];
  stock: Rect;
  waste: Rect;
  /** Bounding box of the whole hand. */
  box: Rect;
  nertzCount: number;
}

export interface FoundationSlot extends Rect {
  /** Foundation id, or null for a slot nothing has been started in yet. */
  id: string | null;
  done: boolean;
}

export interface Layout {
  cards: Placed[];
  me: Seat | null;
  opponents: Seat[];
  slots: FoundationSlot[];
  /** Scale of foundation cards. */
  fs: number;
  /** Pointer above this line while dragging means "to the foundations". */
  horizon: number;
}

const RATIO = CARD_H / CARD_W;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
/** Faces narrower than this on screen use the large-print rendition. */
export const MINI_BELOW = 52;

const STOCK_SHOWN = 4;
const WASTE_SHOWN = 4;

interface HandSpec {
  x: number;
  y: number;
  w: number; // card width
  gap: number; // between neighbouring piles
  wide: number; // between the groups (nertz | work | stock+waste)
  fan: number; // waste fan offset; 0 = stacked
  workFan: number; // preferred vertical offset in a work pile
  workRoom: number; // height available to a work pile below its first card
  z: number;
  mine: boolean;
}

function placeHand(p: PlayerState, h: HandSpec, out: Placed[]): Seat {
  const s = h.w / CARD_W;
  const ch = h.w * RATIO;
  const rect = (x: number, y: number): Rect => ({ x, y, w: h.w, h: ch });
  const put = (card: AnyCard, x: number, y: number, z: number, pile: PileKind) =>
    out.push({ card, x, y, s, z: h.z + z, up: !isHidden(card) && pile !== 'stock', pile, mine: h.mine, done: false });

  // Nertz pile: lower cards peek out underneath so the pile shows its thickness.
  const lean = 0.55 * s;
  p.nertz.forEach((c, i) => put(c, h.x, h.y + (p.nertz.length - 1 - i) * lean, i, 'nertz'));

  const workX = h.x + h.w + h.wide;
  const work = p.work.map((pile, i) => {
    const x = workX + i * (h.w + h.gap);
    const step = pile.length > 1 ? Math.min(h.workFan, h.workRoom / (pile.length - 1)) : 0;
    pile.forEach((c, j) => put(c, x, h.y + j * step, 40 + i * 20 + j, 'work'));
    return rect(x, h.y + Math.max(0, pile.length - 1) * step);
  });

  const stockX = workX + 4 * h.w + 3 * h.gap + h.wide;
  const stockFrom = Math.max(0, p.stock.length - STOCK_SHOWN);
  p.stock.slice(stockFrom).forEach((c, k, shown) => put(c, stockX, h.y + (shown.length - 1 - k) * lean, 20 + k, 'stock'));

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

export function computeLayout(W: number, H: number, game: GameState, you: number): Layout {
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
  const me = mine
    ? placeHand(
        mine,
        {
          x: (W - OWN_UNITS * ow) / 2,
          y: ownTop,
          w: ow,
          gap: ow * OWN.gap,
          wide: ow * OWN.wide,
          fan: ow * (ow < MINI_BELOW ? 0.55 : OWN.fan), // large-print faces need a wider fan to show the rank
          workFan: oh * 0.3,
          workRoom: H - 8 - ownTop - oh,
          z: 3000,
          mine: true,
        },
        cards,
      )
    : null;

  // Opponents: compact hands along the top - in two rows when one row would
  // make them tiny and the window is tall enough to keep the middle roomy.
  // Foundations: a grid in the middle with room for every pile that could
  // ever exist (4 per player).
  const n = others.length;
  const labelH = 28;
  const count = 4 * game.players.length;
  const gap = 10;
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
        (W * 0.94 - (cols - 1) * gap) / cols,
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
        z: 1000 + i * 200,
        mine: false,
      },
      cards,
    );
  });

  const fw = Math.max(16, best.fw);
  const fh = fw * RATIO;
  const fs = fw / CARD_W;
  const gridW = best.cols * fw + (best.cols - 1) * gap;
  const gridH = best.rows * fh + (best.rows - 1) * gap;
  const gx = (W - gridW) / 2;
  const gy = top + Math.max(0, (bottom - top - gridH) / 2);
  const slots: FoundationSlot[] = [];
  for (let i = 0; i < Math.max(count, game.foundations.length); i++) {
    const f = game.foundations[i];
    const x = gx + (i % best.cols) * (fw + gap);
    const y = gy + Math.floor(i / best.cols) * (fh + gap);
    const done = !!f && isComplete(f);
    slots.push({ x, y, w: fw, h: fh, id: f?.id ?? null, done });
    // Only the top two cards are drawn: the one underneath stays visible while the next flies in.
    f?.cards.slice(-2).forEach((card, k) =>
      cards.push({ card, x, y, s: fs, z: 5000 + i * 4 + k, up: true, pile: 'foundation', mine: false, done }),
    );
  }

  return { cards, me, opponents, slots, fs, horizon: ownTop - oh * 0.22 };
}
