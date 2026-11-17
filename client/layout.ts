// Table geometry. A pure function from (viewport, game) to where every
// visible card sits. Every card is absolutely positioned on one layer and
// keyed by its id, so a card moving between piles - yours or anyone's - is
// just the same element animating to new coordinates.
import { OPP } from '../shared/flight';
import { DEAL_MS, isHidden, WORK_PILES } from '../shared/engine';
import { cardSize, feltHw, pileGap, type Pt } from '../shared/table';
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
 *
 * In full: the centre piles turn face-down where they lie ('flip'); they are spread out over the felt ('spread': from
 * here on they are drawn on the finale's canvas); the finished piles come out of the tray onto the spread cards, as
 * loose, tilted stacks ('out'); those are spread out too ('wash'); everything is sorted into a pile per player ('sort'); the scores ('sheet').
 */
export type Stage = 'live' | 'flip' | 'spread' | 'out' | 'wash' | 'sort' | 'sheet';
const STAGES: readonly Stage[] = ['live', 'flip', 'spread', 'out', 'wash', 'sort', 'sheet'];
/** The wash lies spread out and the piles are about to be gathered ('sort'), or have been ('sheet'). On a phone that is when the table is cleared. */
export const sorting = (stage: Stage): boolean => STAGES.indexOf(stage) >= STAGES.indexOf('sort');

/**
 * Whether the middle's cards are the finale's canvas's to draw at `stage`, and no longer this layer's: the centre
 * piles from when they are spread out, the finished piles of the tray a step later, when they are. Both layers ask
 * here and nowhere else (not a clock of their own), so at every stage a card is drawn by exactly one of the two.
 */
export const onCanvas = (stage: Stage, pile: 'slot' | 'tray'): boolean => STAGES.indexOf(stage) >= STAGES.indexOf(pile === 'slot' ? 'spread' : 'wash');

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
  /** Which pile of its kind: which slot, which tray pile, which work pile of the hand. */
  at: number;
  /** Tilt in degrees: a pile in the middle is never quite square. */
  rot: number;
  /** Moves without rising above the cards lying still: it slips in under what is over it. */
  low?: boolean;
}

/** A centre pile's place on this screen: where its card lies, and its tilt in degrees. */
export interface SlotRect extends Rect {
  rot: number;
}

/**
 * The middle of the table as this window draws it: where the centre of the
 * felt (shared/table.ts) is, and how many pixels one unit of table space is.
 * The felt is the same way up in every window, so that is all there is to it.
 */
export interface Felt {
  cx: number;
  cy: number;
  u: number;
}

/** Where a point of the table is on this screen. Linear, so `toTable` undoes it exactly, on the felt and off it. */
export const toScreen = (f: Felt, p: Pt): Pt => ({ x: f.cx + p.x * f.u, y: f.cy + p.y * f.u });

/** The point of the table that is drawn at (x, y) on this screen. */
export const toTable = (f: Felt, x: number, y: number): Pt => ({ x: (x - f.cx) / f.u, y: (y - f.cy) / f.u });

/**
 * Where the `k`th player round the table from you (clockwise, so 1 is on your
 * left) sits as you see it, `n` playing: a unit vector from the middle of the
 * table, (0, 1) being straight down, your own chair.
 */
export function seatDir(k: number, n: number): Pt {
  const a = (2 * Math.PI * k) / Math.max(1, n);
  return { x: -Math.sin(a), y: Math.cos(a) };
}

/** A card's place: x, y, w, h as if upright (its middle is the middle of the rect), turned `rot` degrees about its middle. */
export interface CardRect extends Rect {
  rot?: number;
}

export interface Seat {
  seat: number;
  s: number;
  /** Where the top card of each pile sits (or would sit, for an empty pile). */
  nertz: CardRect;
  work: CardRect[];
  /** Where the first card of each work pile sits: the row. */
  workAt: CardRect[];
  /** Drop area of each work pile: its whole column. Neighbours never touch. */
  workHit: Rect[];
  stock: CardRect;
  /** Where the stock's bottom card lies (the stack stands a little below the row, its top level with it when full): the outline under it. */
  stockPad: CardRect;
  waste: CardRect;
  /** Bounding box of the whole hand. */
  box: Rect;
  /** Laid out the other way round, nertz pile on the right: how the hand of someone sitting across the table looks from here. */
  flip: boolean;
  /** A neighbour's hand runs down the side of the window, turned to face the felt: 90 on your left, -90 on your right. */
  turn: 0 | 90 | -90;
  nertzCount: number;
}

export interface Layout {
  cards: Placed[];
  me: Seat | null;
  opponents: Seat[];
  /** The middle of the table: where table space is on this screen. */
  felt: Felt;
  /** One per centre slot, in slot order; null for a slot with no pile in it. */
  slots: (SlotRect | null)[];
  /** Drop area of each slot: the slot plus a margin smaller than half the gap, so neighbours never touch. */
  slotHit: (Rect | null)[];
  /** The side area for completed piles, beside your hand. It runs off the right edge of the window: half of it is beyond the edge. */
  tray: Rect;
  /** Where a finished pile may be let go to land in the tray: generous, and all the way past the edge. */
  trayHit: Rect;
  /** Where each tray pile stands once it has come out onto the table at the end of a round. */
  out: Rect[];
  /** The box around the felt. */
  middle: Rect;
  /** The window this was laid out for. */
  window: { w: number; h: number };
  /** Scale of cards in the middle. */
  fs: number;
  /**
   * A narrow upright screen (a phone held upright), laid out its own way: a bar across the top for the buttons
   * (`bar` high), everyone else in rows under it, the felt, and your own hand in two rows at the bottom.
   */
  tall: boolean;
  bar: number;
  /** A phone on its side (see LOW): everyone else in a column at each side, the felt as high as the room above your hand. */
  low: boolean;
  /** A phone, upright or on its side. At the end of a round its table is cleared for the sorted piles. */
  phone: boolean;
  /**
   * The end of a round on a phone, once the middle's cards have been washed on the felt: the table is cleared. The
   * hands and the felt are not shown, and the sorted piles have the whole window (Finale.tsx).
   */
  cleared: boolean;
  /** What the screen keeps for itself at its sides (a notch). */
  keep: Insets;
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
export function dropTarget<T extends { hit: Rect }>(targets: readonly T[], pointer: { x: number; y: number }, centre: { x: number; y: number } | null, reach = 0): T | undefined {
  const over = targets.find((t) => inside(t.hit, pointer.x, pointer.y)) ?? (centre ? targets.find((t) => inside(t.hit, centre.x, centre.y)) : undefined);
  if (over || reach <= 0) return over;
  // Under a finger nothing is aimed to the pixel: a release that is over no area goes to the nearest one within
  // `reach` of where it points. (Only areas that would take the card are ever asked about, so nothing is misplaced.)
  const at = centre ?? pointer;
  let best: T | undefined;
  let least = reach;
  for (const t of targets) {
    const d = Math.hypot(Math.max(t.hit.x - at.x, 0, at.x - t.hit.x - t.hit.w), Math.max(t.hit.y - at.y, 0, at.y - t.hit.y - t.hit.h));
    if (d <= least) [best, least] = [t, d];
  }
  return best;
}

/**
 * Where card `j` of finished pile `k` lies when the pile comes out of the tray at the end of a round: the stack leans
 * up and to the left as it rises, and no card sits quite square on the one below. The same for every frame and for
 * the wash that starts from it. `w` is the card's width on screen; `rot` is in degrees.
 */
export function stackOffset(k: number, j: number, w: number, loose = 1): { x: number; y: number; rot: number } {
  const wobble = (salt: number) => {
    const v = Math.sin((k * 31 + j) * 12.9898 + salt * 78.233) * 43758.5453;
    return (v - Math.floor(v)) * 2 - 1;
  };
  // (`loose`: how much further off the one below each card lies, and with it how much more it is turned.)
  return { x: -j * w * 0.012 + wobble(1) * w * 0.035 * loose, y: -j * w * 0.018 + wobble(2) * w * 0.03 * loose, rot: wobble(3) * 4 * Math.sqrt(loose) };
}

/** A centre pile turned over at the end of a round, as a loose stack (seeded apart from the tray's piles). */
/**
 * (Sloppier than a pile from the tray: cards from every deck went onto it in a hurry, and with each a little further
 * off the last the backs underneath show at its edges, in their owners' colours.)
 */
const SLOT_LOOSE = 5;
export const slotStack = (i: number, j: number, w: number) => stackOffset(100 + i, j, w, SLOT_LOOSE);

/**
 * A finished pile set down on the table out of the tray: a loose stack, and the whole of it a little askew (each pile
 * its own way), as a pile put down in passing is.
 */
const TRAY_LOOSE = 2.4;
export function trayStack(k: number, j: number, w: number): { x: number; y: number; rot: number } {
  const o = stackOffset(k, j, w, TRAY_LOOSE);
  return { ...o, rot: o.rot + Math.sin(k * 7.13 + 1.7) * 11 };
}

/** Room the grace countdown is given on the table: its greatest width, its height, and its distance from the right edge. */
export const COUNTDOWN = { w: 168, h: 44, right: 14 };
/** Height of the name line above an opponent's hand. */
export const TAG_H = 26;

/**
 * Where the grace countdown goes: the top-right corner, or if an opponent
 * sits there, the first place down the right edge that is clear of every
 * opponent's hand and name (beside a shorter second row, or just under them).
 */
export function countdownTop(L: Layout, W: number): number {
  const x = W - COUNTDOWN.right - COUNTDOWN.w;
  const hands = L.opponents.map((o) => ({ ...o.box, y: o.box.y - TAG_H, h: o.box.h + TAG_H })); // with the name above it
  const clear = (y: number) => !hands.some((r) => r.x + r.w > x && r.y < y + COUNTDOWN.h && y < r.y + r.h);
  const from = L.tall ? L.bar + 4 : 12; // upright, the corner belongs to the buttons in the bar
  return [from, ...hands.flatMap((r) => [r.y, r.y + r.h + 6]).filter((y) => y > from)].sort((a, b) => a - b).find(clear) ?? from;
}

/** Faces narrower than this on screen use the large-print rendition. */
export const MINI_BELOW = 52;

/** The stock shows one edge for every this many cards left, so you can see it getting thin. */
const STOCK_PER_EDGE = 3;
/** A stock this many edges high (or higher: the deck being dealt) has its top card level with the other piles. */
const STOCK_FULL_EDGES = 10;
const WASTE_SHOWN = 4;
/** Where a group is held while it is counted off the stock, in card widths / heights from the stock's place. */
const HELD = { x: 0.12, y: 0.16 };
/** The held cards are this far above the stock they came off in the stacking: never level with its top card, whatever is on the move. */
const HELD_Z = 100;
/** The held group is a nearly square stack: each card a touch off the one under it (card widths, card heights, degrees). */
const HELD_OFF = [
  { x: 0, y: 0, rot: -2.5 },
  { x: 0.045, y: -0.03, rot: 1.5 },
  { x: 0.02, y: -0.065, rot: -0.5 },
] as const;
/** A face-down card in a work pile shows this much of the strip a face-up card shows. */
const DOWN_STEP = 0.45;

interface HandSpec {
  x: number;
  y: number;
  w: number; // card width
  gap: number; // between neighbouring piles
  wide: number; // between the groups (nertz | work | stock+waste)
  fan: number; // room kept free to the right of the waste (it was once fanned; the pile itself is squared up)
  workFan: number; // preferred vertical offset in a work pile
  workRoom: number; // height available to a work pile below its first card
  workRise: number; // how far above the row a pile too long for that may start instead (free felt above the hand)
  minStrip: number; // the least a face-up card may show while there is room: its whole rank. 0 = squeeze all alike
  z: number;
  mine: boolean;
  /** Lay the piles out from right to left. */
  flip?: boolean;
  /** A work pile being looked at (hovered, or tapped on a touch screen): fanned out in full, rising as far as it needs to over the felt. */
  peek?: number | null;
  /** A group just completed, this many cards, still drawn held for a beat before it turns over (see STOCK_TURN_MS). */
  hold?: number;
  /**
   * A hand in two rows (a narrow upright screen): the work piles start at (x, y), and the nertz pile and the stock
   * and waste lie on a second row under them, at `y`: the nertz pile at `nertzX`, the stock at `stockX`. `box` is
   * what the whole hand covers.
   */
  rows?: { y: number; nertzX: number; stockX: number; box: Rect };
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
  // Everything is worked out left to right; a hand seen from across the table is then mirrored within its own width.
  const span = 7 * h.w + 4 * h.gap + 2 * h.wide + 2 * h.fan;
  const mx = (x: number, w = h.w): number => (h.flip ? 2 * h.x + span - x - w : x);
  const rect = (x: number, y: number): Rect => ({ x: mx(x), y, w: h.w, h: ch });
  const put = (card: AnyCard, x: number, y: number, z: number, pile: PileKind, down = false, at = 0) =>
    out.push({ card, x: mx(x), y, s, z: h.z + z, up: !isHidden(card) && pile !== 'stock' && !down, pile, mine: h.mine, at, rot: 0 });

  // Nertz pile: lower cards peek out underneath so the pile shows its thickness.
  const lean = 0.55 * s;
  const nx = h.rows ? h.rows.nertzX : h.x;
  const ny = h.rows ? h.rows.y : h.y; // the row the nertz pile, the stock and the waste lie on
  p.nertz.forEach((c, i) => put(c, nx, ny + (p.nertz.length - 1 - i) * lean, i, 'nertz'));

  // Work piles fan downwards; the face-down cards at the bottom of the pile take a narrower strip each.
  const workX = h.rows ? h.x : h.x + h.w + h.wide;
  const margin = h.gap * 0.4;
  const workHit: Rect[] = [];
  const workAt = p.work.map((_, i) => rect(workX + i * (h.w + h.gap), h.y));
  const work = p.work.map(({ cards: pile, down }, i) => {
    const x = workX + i * (h.w + h.gap);
    const show = pile.map((_, j) => (j < down ? DOWN_STEP : 1));
    // A pile too long for the room below the row starts higher up instead, as far as the felt above it is free.
    const wanted = show.slice(0, -1).reduce((a, b) => a + b, 0) * h.workFan;
    const rise = clamp(wanted - h.workRoom, 0, h.workRise);
    const at = fanOut(show, h.workFan, h.minStrip, h.workRoom + rise);
    if (i === h.peek) {
      // Looked at: every card shows its whole strip, the pile reaching up over whatever is above it (and above the
      // middle's cards) as far as the top of the window. Its drop area and its top card stay where they were.
      const up = clamp(wanted - h.workRoom, 0, h.y - 8);
      const full = fanOut(show, h.workFan, h.minStrip, h.workRoom + up);
      pile.forEach((c, j) => put(c, x, h.y - up + full[j]!, PEEK_Z + j, 'work', false, i));
    } else pile.forEach((c, j) => put(c, x, h.y - rise + at[j]!, 40 + i * 20 + j, 'work', false, i));
    workHit.push({ x: mx(x - margin, h.w + 2 * margin), y: h.y - rise - margin, w: h.w + 2 * margin, h: ch + h.workRoom + rise + 2 * margin });
    return rect(x, h.y - rise + (at.at(-1) ?? 0));
  });

  const stockX = h.rows ? h.rows.stockX : workX + 4 * h.w + 3 * h.gap + h.wide;
  // Every third card shows an edge, and so does the top one. A card's height in the stack depends only on how many
  // cards lie under it, so taking cards off the top never moves the ones that stay: the stack just gets lower.
  //
  // A group being dealt (the server takes its cards one at a time) is counted off the stock into the hand, as with
  // real cards: each card, as it is dealt, lifts off by itself onto a small face-down stack held just above the
  // stock, not quite square, so three separate cards are seen to be pulled. The complete group is held there a beat
  // longer (`hold`, kept by Table.tsx), then lands on the waste, every card turning over as it goes, the last on top.
  const lifted = Math.min(p.waste.length, Math.max(p.dealt, h.hold ?? 0));
  const top = p.stock.length - 1;
  const stockLow = STOCK_FULL_EDGES * lean * 2; // where the bottom card of the stock lies, below the row
  p.stock.forEach((c, j) => {
    if (j % STOCK_PER_EDGE === 0 || j === top) put(c, stockX, ny + Math.max(0, STOCK_FULL_EDGES - j / STOCK_PER_EDGE) * lean * 2, 20 + j, 'stock');
  });

  const wasteX = stockX + h.w + h.gap;
  const n = p.waste.length - lifted;
  // In the order dealt, each UNDER the one before, as cards counted off into a hand are: the first stays on top, and
  // turning the stack over is what leaves the last one showing. (`low`: it comes up beneath the ones already held.)
  p.waste.slice(n).forEach((c, k) => {
    const o = HELD_OFF[k % HELD_OFF.length]!;
    put(c, stockX + h.w * (HELD.x + o.x), ny - ch * (HELD.y - o.y), Math.max(20 + p.stock.length, 34) + HELD_Z + (lifted - 1 - k), 'stock', true); // well above the stock and the waste
    // (The first has nothing to slip under: it comes up over everything, like any card on the move.)
    Object.assign(out.at(-1)!, { rot: (h.flip ? -1 : 1) * o.rot, low: k > 0 });
  });
  // The waste is one squared-up pile: only its top card shows. (The few cards under the top are drawn too, exactly
  // beneath it, so there is something there when the top leaves.)
  for (let i = Math.max(0, n - WASTE_SHOWN); i < n; i++) put(p.waste[i]!, wasteX, ny, 30 + (i - (n - WASTE_SHOWN)), 'waste');

  return {
    seat: p.seat,
    s,
    nertz: rect(nx, ny),
    work,
    workAt,
    workHit,
    stock: rect(stockX, ny),
    stockPad: rect(stockX, ny + stockLow),
    waste: rect(wasteX, ny),
    box: h.rows ? h.rows.box : { x: h.x, y: h.y, w: span, h: ch + h.workRoom },
    flip: !!h.flip,
    turn: 0,
    nertzCount: p.nertz.length,
  };
}

/**
 * Turns a hand laid out at (0, 0) a quarter turn about its middle so it runs down the side of the window, and puts the
 * top-left corner of what it then covers at (ox, oy). 90: clockwise, its owner's left at the top and their side of
 * the hand at the left edge (a neighbour on your left); -90: the other way (on your right).
 */
function turnHand(seat: Seat, cards: Placed[], turn: 90 | -90, ox: number, oy: number): Seat {
  const { w: span, h: deep } = seat.box;
  // Clockwise: (x, y) -> (-y, x), so the box goes to x in [-deep, 0], y in [0, span]. Anticlockwise: (x, y) -> (y, -x).
  const at = (x: number, y: number): Pt => (turn === 90 ? { x: ox + deep - y, y: oy + x } : { x: ox + y, y: oy + span - x });
  const card = (r: CardRect): CardRect => {
    const c = at(r.x + r.w / 2, r.y + r.h / 2);
    return { x: c.x - r.w / 2, y: c.y - r.h / 2, w: r.w, h: r.h, rot: turn };
  };
  const area = (r: Rect): Rect => {
    const c = at(r.x + r.w / 2, r.y + r.h / 2);
    return { x: c.x - r.h / 2, y: c.y - r.w / 2, w: r.h, h: r.w };
  };
  for (const c of cards) {
    const w = c.s * CARD_W;
    const r = card({ x: c.x, y: c.y, w, h: w * RATIO });
    [c.x, c.y, c.rot] = [r.x, r.y, c.rot + turn];
  }
  return {
    ...seat,
    nertz: card(seat.nertz),
    work: seat.work.map(card),
    workAt: seat.workAt.map(card),
    workHit: seat.workHit.map(area),
    stock: card(seat.stock),
    stockPad: card(seat.stockPad),
    waste: card(seat.waste),
    box: { x: ox, y: oy, w: deep, h: span },
    turn,
  };
}

/** Your own card is this share of the window's height wide (if the width allows), and never wider than OWN_MAX. */
const OWN_K = 0.108;
const OWN_MAX = 150;
/** The widest an opponent's card is drawn, on however large a screen. */
const OPP_MAX = 96;
/** The widest a card in the middle is drawn, in widths of your own. */
const CENTRE_MAX = 1.2;
/**
 * Your own hand lies over the middle's cards (z 5000 and up, the tray's among them): what of it reaches onto the felt
 * (the group held over the stock, above all) covers a pile lying at your edge of it.
 */
const OWN_Z = 6000;
/** A work pile being looked at is drawn above the rest of your hand and below anything flying or held. */
const PEEK_Z = 1000;
/** Width of a hand in card widths, for the gaps used below. */
const OWN = { gap: 0.2, wide: 0.5, fan: 0.3 };
const OWN_UNITS = 7 + 4 * OWN.gap + 2 * OWN.wide + 2 * OWN.fan;
const OPP_UNITS = 7 + 4 * OPP.gap + 2 * OPP.wide;
/**
 * The tray runs off the right edge of the table beside your hand, half of it
 * beyond the edge. A pile in it shows TRAY_SHOW of its width (the King's index
 * and then some), inside TRAY_PAD of padding.
 */
const TRAY_PAD = 0.12;
const TRAY_SHOW = 0.62;
const TRAY_IN = TRAY_SHOW + TRAY_PAD;
/** Piles are not squared up: each sits a little further in or out than the one before. */
const TRAY_JOG = [0, 0.08, 0.03];
/** The top corners of the window are kept clear of hands: the chat button's on the left, the grace countdown's on the right. */
const CORNER = COUNTDOWN.w + COUNTDOWN.right + 8;
/** Clear cloth kept between the felt and every hand. */
const CLEAR = 14;
/**
 * A phone held upright. Narrower than TALL.below and clearly taller than wide, the table is laid out its own way:
 * - a bar `bar` high across the top is kept for the buttons (chat, sound, settings);
 * - everyone else sits in rows under it, up to `cols` hands to a row, as large as the room allows;
 * - the felt runs the width of the screen;
 * - your own hand is in two rows: the four work piles (`gap` apart, with `room` of a card's height to fan into) and
 *   beside them the tray (`tray` of a card's width is kept for it), and under them the nertz pile at the left and
 *   the stock and waste at the right, where a thumb is. The hand may take `share` of the screen's height.
 */
export const TALL = { below: 640, ratio: 1.2, bar: 50, edge: 10, cols: 3, gap: 0.14, tray: 0.56, room: 0.8, between: 0.12, share: 0.42, oppShare: 0.62 } as const;
export const isTall = (W: number, H: number): boolean => W < TALL.below && H >= W * TALL.ratio;

/**
 * A phone on its side: wide, and too low for a row of hands above the felt. Everyone else sits in two columns, one at
 * each side of the felt (small upright hands, clockwise from the bottom of the left column), so the felt has the whole
 * height above your own hand. Each column is kept at least `col` wide (a hand whose cards are about 14 px), the left
 * one starts `top` down (under the chat button) and ends `knobs` above the bottom (over the sound and settings buttons).
 */
export const LOW = { below: 500, col: 118, top: 50, knobs: 52 } as const;
export const isLow = (W: number, H: number): boolean => !isTall(W, H) && H < LOW.below;

/** What the screen keeps for itself at its edges (a notch at the side of a phone on its side, the bar at the bottom): nothing is put there. */
export interface Insets {
  l: number;
  r: number;
  b: number;
}
const NO_INSETS: Insets = { l: 0, r: 0, b: 0 };

/** An opponent's card is this share of the window's height wide, by how many opponents there are. */
const OPP_SIZE = [0, 0.062, 0.056, 0.046, 0.04, 0.035];

/**
 * Where everything is. The felt in the middle is the same for everybody
 * (shared/table.ts); the seating round it is yours: your own hand large along
 * the bottom edge, everyone else in seat order clockwise from your left as a
 * compact hand, along the top edge for the seats across from you and at the
 * left and right edges for your neighbours. The felt is as large as fits
 * between all the hands.
 */
export function computeLayout(W: number, fullH: number, game: GameState, you: number, stage: Stage = 'live', peek: number | null = null, held?: ReadonlyMap<number, number>, keep: Insets = NO_INSETS, sitting: readonly number[] = []): Layout {
  const H = fullH - keep.b; // the strip at the bottom that the screen keeps is simply not used
  const cards: Placed[] = [];
  const n = game.players.length; // (the felt and its cards are sized for those in the round)
  // Whoever sits at the table without being in the round (`sitting`: they came in the middle of it, or were away at
  // the deal) has a place round it all the same, in seat order with the rest: a hand with no cards in it.
  const empty = sitting.filter((seat) => !game.players.some((p) => p.seat === seat));
  const ring: PlayerState[] = empty.length
    ? [...game.players, ...empty.map((seat): PlayerState => ({ seat, nertz: [], work: Array.from({ length: WORK_PILES }, () => ({ cards: [], down: 0 })), stock: [], waste: [], dealt: 0, stuck: false, holding: null }))].sort((a, b) => a.seat - b.seat)
    : game.players;
  const mine = ring.find((p) => p.seat === you);
  // Someone who has no seat at the table at all watches from the first player's chair.
  const view = Math.max(0, ring.indexOf(mine!));
  // Opponents in seat order starting after you: clockwise round the table, from your left.
  const others = mine ? [...ring.slice(view + 1), ...ring.slice(0, view)] : ring;
  const tall = isTall(W, H);
  // (More than six at the table: the others stand in a column at each side as they do on a phone on its side. Round
  // the felt there is room for five hands, not for nine.)
  const low = isLow(W, H) || (!tall && ring.length > 6);
  const edge = tall ? TALL.edge : 16;

  // Your hand: bottom, as large as the window allows. (Upright: in two rows, see TALL.)
  const ow = !mine
    ? 0
    : tall
      ? clamp(Math.min((W - 2 * edge) / (4 + 3 * TALL.gap + TALL.tray), (H * TALL.share) / (RATIO * (2 + TALL.room + TALL.between))), 30, OWN_MAX)
      : clamp(Math.min((W - 2 * edge) / (OWN_UNITS + 0.4), H * OWN_K), 34, OWN_MAX);
  const oh = ow * RATIO;
  /** Upright: the second row, where the nertz pile, the stock and the waste lie. */
  const rowY = H - 10 - oh;
  // Room below the row for work piles to fan into is kept short: a long pile squeezes, or rises into the cloth above.
  const ownTop = !mine ? H - 12 : tall ? rowY - oh * (TALL.between + TALL.room + 1) : H - 12 - oh * 1.85;
  const handX = tall ? edge : (W - OWN_UNITS * ow) / 2;

  // Everyone else, by the direction their seat lies in as seen from yours: (0, 1) is straight down, towards you.
  const seats = others.map((p) => {
    const dir = seatDir((ring.indexOf(p) - view + ring.length) % ring.length, ring.length);
    return { p, dir, where: tall ? ('top' as const) : low ? ('col' as const) : dir.y > 0.9 ? ('bottom' as const) : dir.y < -0.4 ? ('top' as const) : ('side' as const) };
  });
  const size = cardSize(n);
  const hw = feltHw(n);
  // Upright, the felt runs the width of the screen, and how high that makes it is known before anything else is placed.
  const feltRoom = W - 2 * (tall ? 6 : edge);
  // Upright: the hands of the others in rows under the bar. As few to a row as leaves the cards largest in the room
  // there is above the felt (one opponent to a row is twice the size of two, while the rows fit).
  const grid = { cols: 1, w: 0 };
  if (tall) {
    const above = ownTop - CLEAR - 4 - Math.min(feltRoom / hw, (ow * CENTRE_MAX * 2) / size.w || Infinity) - CLEAR - TALL.bar;
    for (let cols = Math.min(TALL.cols, Math.max(1, seats.length)); cols >= 1; cols--) {
      const rows = Math.ceil(seats.length / cols);
      const w = Math.min((W - 2 * edge - (cols - 1) * 14) / (cols * OPP_UNITS), (above / rows - TAG_H - 10) / (RATIO * 1.85), mine ? ow * TALL.oppShare : OPP_MAX);
      if (w > grid.w + 0.5) Object.assign(grid, { cols, w });
    }
  }
  // On its side: the felt is sized first (it has the height above your hand, and the width the two columns leave),
  // then the hands of the others, as large as their columns and the number in each allow.
  const sideL = Math.max(8, keep.l);
  const sideR = Math.max(8, keep.r);
  const col = { u: 0, w: 0, left: Math.ceil(seats.length / 2), topL: LOW.top, botL: H - LOW.knobs, topR: 6, botR: (mine ? ownTop : H - 12) - 6 };
  if (low) {
    // (A phone on its side has little width to give the columns; a wide window with more than six at the table gives each a sixth of it.)
    const most = W - sideL - sideR - 2 * (Math.max(LOW.col, isLow(W, H) ? 0 : W * 0.17) + CLEAR);
    col.u = Math.max(40, Math.min(most / (2 * hw), ((mine ? ownTop : H - 12) - CLEAR - 4 - 6) / 2, (mine ? ow * CENTRE_MAX : 90) / size.w));
    const wide = (W - 2 * hw * col.u) / 2 - CLEAR - Math.max(sideL, sideR);
    const each = (room: number, k: number) => (k ? (room / k - TAG_H - 6) / (RATIO * 1.85) : Infinity);
    col.w = Math.min(wide / OPP_UNITS, each(col.botL - col.topL, col.left), each(col.botR - col.topR, seats.length - col.left), mine ? ow * 0.62 : OPP_MAX);
  }
  const tops = seats.filter((s) => s.where === 'top');
  const sides = seats.some((s) => s.where === 'side');
  const mw = tall
    ? clamp(grid.w, 11, OPP_MAX)
    : low
      ? clamp(col.w, 11, OPP_MAX)
      : clamp(
    Math.min(
      H * OPP_SIZE[Math.min(5, others.length)]!,
      mine ? ow * 0.62 : OPP_MAX,
      (W - 2 * CORNER - (tops.length - 1) * 18) / (Math.max(1, tops.length) * OPP_UNITS), // the top row fits between the corners
      sides ? (W * 0.16 - edge) / (1.85 * RATIO) : OPP_MAX, // two side hands, turned, leave most of the width to the felt
      sides ? (H * 0.62) / OPP_UNITS : OPP_MAX, // and run down no more than most of its height
    ),
    16,
    OPP_MAX,
  );
  const mh = mw * RATIO;
  const handW = OPP_UNITS * mw;
  const handH = mh * 1.85;
  const topY = (tall ? TALL.bar : 10) + TAG_H;
  const rowStep = handH + TAG_H + 10; // upright: from one row of hands to the next
  const rows = tall ? Math.ceil(seats.length / grid.cols) : 1;
  // The band of the window the felt may use: under the top row, above your hand.
  const bandTop = tall ? topY + (rows - 1) * rowStep + handH + CLEAR : low ? 6 : tops.length ? topY + handH + CLEAR : 30;
  const bandBottom = (mine ? ownTop : seats.some((s) => s.where === 'bottom') ? H - 12 - handH - TAG_H : H - 12) - CLEAR - 4;
  const cy = (bandTop + bandBottom) / 2;
  // The top row is spread out when there is room (three across the top sit shoulder to shoulder), and stays out of the corners.
  const xs = tops.map((s) => s.dir.x).sort((a, b) => a - b);
  const closest = Math.min(Infinity, ...xs.slice(1).map((x, i) => x - xs[i]!));
  const widest = Math.max(0.001, ...xs.map(Math.abs));
  const spread = Math.max(Number.isFinite(closest) ? (handW + 18) / closest : 0, Math.min(W * 0.3, (W / 2 - CORNER - handW / 2) / widest));
  const span = OPP_UNITS * mw; // a side hand, turned, runs this far down the window
  const opponents = seats.map(({ p, dir, where }, i) => {
    const spec: HandSpec = {
      x: 0,
      y: 0,
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
      // Across the table a hand is seen from the other side: its owner's left is your right.
      flip: where === 'top',
      hold: held?.get(p.seat),
    };
    if (where === 'side') {
      // A neighbour sits beside the felt, their hand turned to face it: level with its middle if they are straight to
      // one side, lower down the nearer they are to you. Clear of the chat button above and your hand below.
      const y = clamp(cy + dir.y * (bandBottom - bandTop) * 0.8 - span / 2, Math.max(bandTop, 48) + TAG_H, (mine ? ownTop : H - 12) - 8 - span);
      const local: Placed[] = [];
      const seat = placeHand(p, spec, local);
      const turned = turnHand(seat, local, dir.x < 0 ? 90 : -90, dir.x < 0 ? edge : W - edge - handH, y);
      cards.push(...local);
      return turned;
    }
    if (where === 'col') {
      // Clockwise from your left: up the left column, then down the right one. Each has an equal share of its column.
      const left = i < col.left;
      const count = left ? col.left : seats.length - col.left;
      const k = left ? col.left - 1 - i : i - col.left; // from the top
      const [top, bottom] = left ? [col.topL, col.botL] : [col.topR, col.botR];
      const share = (bottom - top) / count;
      const y = top + k * share + TAG_H + Math.max(0, (share - TAG_H - handH) / 2);
      // (On the right the hand is mirrored: either way the nertz pile is at the outer edge.)
      return placeHand(p, { ...spec, flip: !left, x: left ? sideL : W - sideR - handW, y }, cards);
    }
    if (tall) {
      // In seat order, left to right and row by row: whoever is on your left comes first. A short last row is centred.
      const row = Math.floor(i / grid.cols);
      const inRow = Math.min(grid.cols, seats.length - row * grid.cols);
      const x0 = W / 2 - (inRow * handW + (inRow - 1) * 14) / 2;
      return placeHand(p, { ...spec, x: x0 + (i - row * grid.cols) * (handW + 14), y: topY + row * rowStep }, cards);
    }
    return placeHand(p, { ...spec, x: W / 2 + (where === 'top' ? dir.x * spread : 0) - handW / 2, y: where === 'top' ? topY : H - 12 - handH }, cards);
  });

  // The felt: centred in the band, as large as fits in it and between the hands at the sides, but no larger than
  // makes its cards the size of your own.
  const room = tall ? feltRoom : W - 2 * (sides ? edge + handH + CLEAR : edge);
  const u = low ? col.u : Math.max(40, Math.min(room / (2 * hw), (bandBottom - bandTop) / 2, (mine ? ow * CENTRE_MAX : 90) / size.w));
  const felt: Felt = { cx: W / 2, cy, u };
  const fw = size.w * u;
  const fh = fw * RATIO;
  const fs = fw / CARD_W;
  const middle: Rect = { x: felt.cx - hw * u, y: cy - u, w: 2 * hw * u, h: 2 * u };
  const slots = game.slots.map((pile): SlotRect | null => {
    if (!pile) return null;
    const c = toScreen(felt, pile.at);
    return { x: c.x - fw / 2, y: c.y - fh / 2, w: fw, h: fh, rot: pile.at.r };
  });

  // The tray lies beside your hand, off the right edge: piles cascade down it, face-down, a strip of each showing
  // while there is room for that. (A window too narrow for it: the tray gives way, not your hand.)
  // Its piles are drawn a little larger than in the middle when the middle's cards are small: they lie next to your own.
  const tw = Math.max(fw, ow * 0.6);
  const th = tw * RATIO;
  const pad = tw * TRAY_PAD;
  const gapT = ow * TALL.gap;
  const trayIn = tall ? clamp(W - (handX + 4 * ow + 3 * gapT) - 8, tw * 0.3, tw * TRAY_IN) : clamp(W - (handX + OWN_UNITS * ow) - 18, tw * 0.3, tw * TRAY_IN);
  const trayTop = mine ? ownTop : H - 12 - fh * 2.6;
  // (Upright: beside the work piles, and no lower: the stock and the waste are under it.)
  const tray: Rect = { x: W - trayIn, y: trayTop, w: 2 * trayIn, h: (tall && mine ? rowY - 8 : H - 10) - trayTop };
  const trayH = tray.h;
  // Dropping a finished pile is not a precision job: anywhere from a little short of the tray to past the edge of the screen.
  const trayHit: Rect = { x: tray.x - fw * 0.9, y: tray.y - fh * 0.4, w: fw * 0.9 + tray.w + W, h: tray.h + fh * 0.4 + H };
  const trays = game.tray.length;
  const trayStep = trays > 1 ? Math.min(th * 0.36, (trayH - 2 * pad - th) / (trays - 1)) : 0;
  // End of round: the tray piles walk out to a row across the middle of the table.
  const outStep = trays > 1 ? Math.min(fw * 1.15, (middle.w * 0.8 - fw) / (trays - 1)) : 0;
  const out = game.tray.map((_, k): Rect => ({ x: W / 2 - (outStep * (trays - 1) + fw) / 2 + k * outStep, y: middle.y + (middle.h - fh) / 2, w: fw, h: fh }));

  // Your hand is placed last: a long work pile may rise into what cloth there is between the row and the felt.
  const me = mine
    ? placeHand(
        mine,
        {
          x: handX,
          y: ownTop,
          w: ow,
          gap: tall ? gapT : ow * OWN.gap,
          wide: ow * OWN.wide,
          fan: ow * (ow < MINI_BELOW ? 0.55 : OWN.fan),
          workFan: oh * 0.3,
          workRoom: tall ? oh * TALL.room : H - 8 - ownTop - oh,
          rows: tall ? { y: rowY, nertzX: edge, stockX: W - edge - 2 * ow - gapT, box: { x: edge, y: ownTop, w: W - 2 * edge, h: H - 10 - ownTop } } : undefined,
          // (Not once the wash begins: the labels of the sorted piles are placed clear of the hand's box.)
          workRise: onCanvas(stage, 'tray') ? 0 : Math.max(0, ownTop - 6 - (cy + u)),
          minStrip: oh * 0.21,
          z: OWN_Z,
          mine: true,
          peek,
          hold: held?.get(you),
        },
        cards,
      )
    : null;

  // The middle's cards. In play only the top two of a pile are drawn: the one underneath stays visible while the next
  // flies in. When the round ends and the piles turn over, every card is drawn, each a little off the last
  // (`stackOffset`), so each pile is a stack you can see the size of. Once the wash starts they are drawn on the
  // finale's canvas instead.
  // The centre piles are drawn here until they are spread out; the tray's until they are, a step later.
  if (!onCanvas(stage, 'slot')) {
    game.slots.forEach((pile, i) => {
      const r = slots[i];
      if (!pile || !r) return;
      if (stage === 'live') {
        pile.cards.slice(-2).forEach((card, k) => cards.push({ card, x: r.x, y: r.y, s: r.w / CARD_W, z: 5000 + i * 4 + k, up: true, pile: 'slot', mine: false, at: i, rot: r.rot }));
        return;
      }
      pile.cards.forEach((card, j) => {
        const o = slotStack(i, j, r.w);
        cards.push({ card, x: r.x + o.x, y: r.y + o.y, s: r.w / CARD_W, z: 5000 + i * 14 + j, up: false, pile: 'slot', mine: false, at: i, rot: r.rot + o.rot });
      });
    });
  }
  if (!onCanvas(stage, 'tray')) {
    game.tray.forEach((pile, k) => {
      const home: Rect = { x: tray.x + pad + TRAY_JOG[k % TRAY_JOG.length]! * tw, y: tray.y + pad + k * trayStep, w: tw, h: th };
      // A finished pile is turned face-down as it is put aside: it is out of the game, and solid like any other card.
      // Every card of a finished pile is drawn (squared up in the tray), so that when the pile comes out on the table
      // at the end of the round it is a stack you can see the size of: each card a little off the last.
      const r = stage === 'out' ? out[k]! : home;
      pile.forEach((card, j) => {
        const o = stage === 'out' ? trayStack(k, j, r.w) : { x: 0, y: 0, rot: 0 };
        // (Out on the table they lie on the spread cards, which are on the finale's canvas: above it.)
        cards.push({ card, x: r.x + o.x, y: r.y + o.y, s: r.w / CARD_W, z: (stage === 'out' ? 20100 : 5200) + k * 20 + j, up: false, pile: 'tray', mine: false, at: k, rot: o.rot });
      });
    });
  }

  // Piles are at least 0.14 of a card apart in every direction (shared/table.ts), so a margin of 0.05 keeps drop areas from touching.
  const phone = tall || isLow(W, H);
  const cleared = phone && sorting(stage);
  return { cards, me, opponents, felt, slots, slotHit: slots.map((r) => r && grow(r, fw * 0.05)), tray, trayHit, out, middle, window: { w: W, h: H }, fs, tall, bar: tall ? TALL.bar : 0, low, phone, cleared, keep };
}

// ---------------------------------------------------------------- an Ace in hand

/**
 * What is drawn while an Ace that may start a pile anywhere is in hand. The
 * picture is the rule (shared/table.ts): the Ace's outline (`landingAt`) may
 * come up to the line round every pile (`keepOut`) and to the edge of the felt,
 * and no further. client/layout.test.ts holds the two against the engine.
 */

/** The outline of the pile an Ace would start with its centre at `centre` (a point of this screen): exactly the card that would lie there. */
export const landingAt = (L: Pick<Layout, 'fs'>, centre: Pt): Rect => {
  const [w, h] = [L.fs * CARD_W, L.fs * CARD_H];
  return { x: centre.x - w / 2, y: centre.y - h / 2, w, h };
};

/** The room a pile lying at `slot` keeps round it on a table for `n` players: its card, grown by the gap. */
export const keepOut = (L: Pick<Layout, 'felt'>, slot: Rect, n: number): Rect => grow({ x: slot.x, y: slot.y, w: slot.w, h: slot.h }, pileGap(n) * L.felt.u);

// ---------------------------------------------------------------- other players' cards in the air

/** Someone else's card that has left their hand for the felt is drawn lifted this many of its own widths out of the hand, until it is known where it is going. */
const LIFT = 1.2;

/**
 * Where the middle of a card that another player is carrying is drawn in this
 * window. The felt is the same on every screen and the hands are not: its
 * owner carries the card up from the bottom of their screen, and here it has
 * to come from wherever this window seats them. So it is not simply drawn
 * where it is. It starts out about its owner's hand: as far along the row and
 * as far towards the middle from its pile as they have it (`at.h`), in cards
 * of their hand as drawn here (`hw` wide, the card's home at `home`); once it
 * has left the hand for the felt, lifted a little way out of the hand towards
 * the middle. From there:
 * - a card with a pile to go to (`pile`: the middle of that pile on this
 *   screen) is as far along the straight line to that pile as its owner has
 *   carried it of their own way there (`at.w`, 0 to 1);
 * - and any card comes over to where it really is (`at.p`, its point of the
 *   felt) as it lingers over the felt (`linger`, 0 to 1): an Ace on its way to
 *   bare felt has no pile to go by.
 * Either way it travels a straight line from that hand to its place, whichever
 * side of the table the hand is on.
 */
export function aloftAt(
  felt: Felt,
  home: Pt,
  hw: number,
  hand: Pick<Seat, 'box' | 'flip' | 'turn'> | undefined,
  at: { h: readonly [number, number]; p: readonly [number, number]; w: number },
  pile: Pt | undefined,
  linger: number,
): Pt {
  const there = toScreen(felt, { x: at.p[0], y: at.p[1] });
  // "Towards the middle" is up the screen for whoever is dragging; for their hand as drawn here it is wherever the felt lies.
  const to = hand ? { x: felt.cx - (hand.box.x + hand.box.w / 2), y: felt.cy - (hand.box.y + hand.box.h / 2) } : { x: 0, y: -1 };
  const len = Math.hypot(to.x, to.y) || 1;
  // Along the row (a hand across the table is drawn the other way round) counts for a card going from pile to pile,
  // not for one that is on its way out of the hand: which way is sideways on its owner's screen says nothing about
  // where on the felt it is going.
  const along = at.h[0] * clamp(1 - at.h[1] / 0.8, 0, 1);
  // Which way the row runs here: across, the other way round for a hand across the table, down or up for a turned one.
  const row = hand?.turn === 90 ? { x: 0, y: 1 } : hand?.turn === -90 ? { x: 0, y: -1 } : { x: hand?.flip ? -1 : 1, y: 0 };
  // Towards the middle: as far as its owner has it, up to a card's width or so out of the hand, and never most of the
  // way to where it really is. (No further: how far up its owner's screen it is says little about where it is going.)
  const out = Math.min(at.h[1], LIFT, (0.6 * Math.hypot(there.x - home.x, there.y - home.y)) / hw);
  let x = home.x + (along * row.x + (out * to.x) / len) * hw;
  let y = home.y + (along * row.y + (out * to.y) / len) * hw;
  if (pile) [x, y] = [x + (pile.x - x) * at.w, y + (pile.y - y) * at.w];
  return { x: x + (there.x - x) * linger, y: y + (there.y - y) * linger };
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

/** When each card of a full deal lands and flicks (work-pile cards first, then the nertz pile), in seconds from now. */
export function dealTimes(work = 10, nertz = 13): number[] {
  return Array.from({ length: work + nertz }, (_, i) => ((dealWait(i, DEAL_MS, work) ?? 0) + DEAL.duration * 700) / 1000);
}
