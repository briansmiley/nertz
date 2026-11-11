// Table geometry. A pure function from (viewport, game) to where every
// visible card sits. Every card is absolutely positioned on one layer and
// keyed by its id, so a card moving between piles - yours or anyone's - is
// just the same element animating to new coordinates.
import { DEAL_MS, isHidden } from '../shared/engine';
import { cardSize, fromView, seatDir, tableAspect, toView, type Pt } from '../shared/table';
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
  /** Tilt in degrees: a pile in the middle is never quite square. */
  rot: number;
}

/** A centre pile's place on this screen: where its card lies, and its tilt in degrees. */
export interface SlotRect extends Rect {
  rot: number;
}

/**
 * The middle of the table as this window draws it: the unit disc of table
 * space (shared/table.ts), turned so that player `i` of `n` sits at the bottom
 * and drawn as an ellipse with its centre at (cx, cy).
 */
export interface Disc {
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  i: number;
  n: number;
}

/** Where a point of the table is on this screen. Linear, so `toTable` undoes it exactly, on the disc and off it. */
export function toScreen(d: Disc, p: Pt): Pt {
  const v = toView(p, d.i, d.n);
  return { x: d.cx + v.x * d.rx, y: d.cy + v.y * d.ry };
}

/** The point of the table that is drawn at (x, y) on this screen. */
export const toTable = (d: Disc, x: number, y: number): Pt => fromView({ x: (x - d.cx) / d.rx, y: (y - d.cy) / d.ry }, d.i, d.n);

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
  /** Laid out the other way round, nertz pile on the right: how the hand of someone sitting across the table looks from here. */
  flip: boolean;
  nertzCount: number;
}

export interface Layout {
  cards: Placed[];
  me: Seat | null;
  opponents: Seat[];
  /** The middle of the table: where table space is on this screen. */
  disc: Disc;
  /** One per centre slot, in slot order; null for a slot that has no place (an unused one on a 'free' table). */
  slots: (SlotRect | null)[];
  /** Drop area of each slot: the slot plus a margin smaller than half the gap, so neighbours never touch. */
  slotHit: (Rect | null)[];
  /** The side area for completed piles, beside your hand. It runs off the right edge of the window: half of it is beyond the edge. */
  tray: Rect;
  /** Where a finished pile may be let go to land in the tray: generous, and all the way past the edge. */
  trayHit: Rect;
  /** Where each tray pile stands once it has come out onto the table at the end of a round. */
  out: Rect[];
  /** The box around the disc. */
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
  fan: number; // room kept free to the right of the waste (it was once fanned; the pile itself is squared up)
  workFan: number; // preferred vertical offset in a work pile
  workRoom: number; // height available to a work pile below its first card
  workRise: number; // how far above the row a pile too long for that may start instead (free felt above the hand)
  minStrip: number; // the least a face-up card may show while there is room: its whole rank. 0 = squeeze all alike
  z: number;
  mine: boolean;
  /** Lay the piles out from right to left. */
  flip?: boolean;
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
  const put = (card: AnyCard, x: number, y: number, z: number, pile: PileKind) =>
    out.push({ card, x: mx(x), y, s, z: h.z + z, up: !isHidden(card) && pile !== 'stock', pile, mine: h.mine, at: 0, rot: 0 });

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
    workHit.push({ x: mx(x - margin, h.w + 2 * margin), y: h.y - rise - margin, w: h.w + 2 * margin, h: ch + h.workRoom + rise + 2 * margin });
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
  // The waste is one squared-up pile: only its top card shows, face-down while a group is being dealt onto it.
  // (The few cards under the top are drawn too, exactly beneath it, so there is something there when the top leaves.)
  const n = p.waste.length;
  for (let i = Math.max(0, n - WASTE_SHOWN); i < n; i++) put(p.waste[i]!, wasteX, h.y, 30 + (i - (n - WASTE_SHOWN)), 'waste');

  return {
    seat: p.seat,
    s,
    nertz: rect(h.x, h.y),
    work,
    workHit,
    stock: rect(stockX, h.y),
    waste: rect(wasteX, h.y),
    box: { x: h.x, y: h.y, w: span, h: ch + h.workRoom },
    flip: !!h.flip,
    nertzCount: p.nertz.length,
  };
}

/** Width of a hand in card widths, for the gaps used below. */
const OWN = { gap: 0.2, wide: 0.5, fan: 0.3 };
const OWN_UNITS = 7 + 4 * OWN.gap + 2 * OWN.wide + 2 * OWN.fan;
const OPP = { gap: 0.14, wide: 0.42 };
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
/** Clear felt kept between the disc and every hand. */
const CLEAR = 14;
/** An opponent's card is this share of the window's height wide, by how many opponents there are. */
const OPP_SIZE = [0, 0.062, 0.056, 0.046, 0.04, 0.035];

/**
 * Where everything is. The players sit around the table at their seat angles,
 * turned so that you are at the bottom (shared/table.ts): your own hand large
 * along the bottom edge, everyone else as a compact hand where their seat is,
 * along the top edge for the seats across from you and at the left and right
 * edges for your neighbours. The middle is the disc, drawn as an ellipse as
 * large as fits between all the hands.
 */
export function computeLayout(W: number, H: number, game: GameState, you: number, stage: Stage = 'live'): Layout {
  const cards: Placed[] = [];
  const n = game.players.length;
  const mine = game.players.find((p) => p.seat === you);
  // Someone who is not in the round watches from the first player's chair.
  const view = Math.max(0, game.players.indexOf(mine!));
  // Opponents in seat order starting after you: clockwise round the table, from your left.
  const others = mine ? [...game.players.slice(view + 1), ...game.players.slice(0, view)] : game.players;
  const edge = 16;

  // Your hand: bottom, as large as the window allows.
  const ow = mine ? clamp(Math.min((W - 2 * edge) / (OWN_UNITS + 0.4), H * 0.132), 34, 104) : 0;
  const oh = ow * RATIO;
  const ownTop = mine ? H - 12 - oh * 2.2 : H - 12;
  const handX = (W - OWN_UNITS * ow) / 2;

  // Everyone else, by the direction their seat lies in as seen from yours: (0, 1) is straight down, towards you.
  const seats = others.map((p) => {
    const dir = toView(seatDir(game.players.indexOf(p), n), view, n);
    return { p, dir, where: dir.y > 0.9 ? ('bottom' as const) : dir.y < -0.4 ? ('top' as const) : ('side' as const) };
  });
  const tops = seats.filter((s) => s.where === 'top');
  const sides = seats.some((s) => s.where === 'side');
  const mw = clamp(
    Math.min(
      H * OPP_SIZE[Math.min(5, others.length)]!,
      mine ? ow * 0.62 : 64,
      (W - 2 * CORNER - (tops.length - 1) * 18) / (Math.max(1, tops.length) * OPP_UNITS), // the top row fits between the corners
      sides ? (W * 0.21 - edge) / OPP_UNITS : 64, // two side hands leave most of the width to the disc
    ),
    16,
    64,
  );
  const mh = mw * RATIO;
  const handW = OPP_UNITS * mw;
  const handH = mh * 1.85;
  const topY = 10 + TAG_H;
  // The band of the window the disc may use: under the top row, above your hand.
  const bandTop = tops.length ? topY + handH + CLEAR : 30;
  const bandBottom = (mine ? ownTop : seats.some((s) => s.where === 'bottom') ? H - 12 - handH - TAG_H : H - 12) - CLEAR - 4;
  const cy = (bandTop + bandBottom) / 2;
  // The top row is spread out when there is room (three across the top sit shoulder to shoulder), and stays out of the corners.
  const xs = tops.map((s) => s.dir.x).sort((a, b) => a - b);
  const closest = Math.min(Infinity, ...xs.slice(1).map((x, i) => x - xs[i]!));
  const widest = Math.max(0.001, ...xs.map(Math.abs));
  const spread = Math.max(Number.isFinite(closest) ? (handW + 18) / closest : 0, Math.min(W * 0.3, (W / 2 - CORNER - handW / 2) / widest));
  const opponents = seats.map(({ p, dir, where }, i) => {
    const x = where === 'side' ? (dir.x < 0 ? edge : W - edge - handW) : W / 2 + (where === 'top' ? dir.x * spread : 0) - handW / 2;
    // A neighbour sits beside the disc: level with its middle if they are straight to one side, lower down the nearer they are to you.
    const beside = clamp(cy + dir.y * (bandBottom - bandTop) * 0.8 - handH / 2, bandTop + TAG_H, bandBottom - handH);
    return placeHand(
      p,
      {
        x,
        y: where === 'top' ? topY : where === 'side' ? beside : H - 12 - handH,
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
      },
      cards,
    );
  });

  // The disc: an ellipse `aspect` times as wide as high, centred in the band, as large as fits in the band and
  // clear of every hand, but no larger than makes its cards the size of your own.
  const aspect = tableAspect(n);
  const size = cardSize(n, game.table);
  /** How far (cx, cy) is from a rectangle, with heights counted `aspect` times: the ellipse just touching it has this rx. */
  const reach = (r: Rect): number => Math.hypot(Math.max(r.x - W / 2, 0, W / 2 - (r.x + r.w)), Math.max(r.y - cy, 0, cy - (r.y + r.h)) * aspect);
  const rx = Math.max(
    40,
    Math.min(
      W / 2 - edge,
      ((bandBottom - bandTop) / 2) * aspect,
      (mine ? ow * 0.92 : 90) / size.w,
      ...opponents.map((o) => reach({ x: o.box.x, y: o.box.y - TAG_H, w: o.box.w, h: o.box.h + TAG_H }) - CLEAR),
    ),
  );
  const disc: Disc = { cx: W / 2, cy, rx, ry: rx / aspect, i: view, n };
  const fw = size.w * rx;
  const fh = fw * RATIO;
  const fs = fw / CARD_W;
  const middle: Rect = { x: disc.cx - rx, y: cy - disc.ry, w: 2 * rx, h: 2 * disc.ry };
  const slots = game.places.map((at): SlotRect | null => {
    if (!at) return null;
    const c = toScreen(disc, at);
    return { x: c.x - fw / 2, y: c.y - fh / 2, w: fw, h: fh, rot: at.r };
  });

  // The tray lies beside your hand, off the right edge: piles cascade down it, each showing its King's rank and suit
  // while there is room for that. (A window too narrow for it: the tray gives way, not your hand.)
  // Its piles are drawn a little larger than in the middle when the middle's cards are small: they lie next to your own.
  const tw = Math.max(fw, ow * 0.6);
  const th = tw * RATIO;
  const pad = tw * TRAY_PAD;
  const trayIn = clamp(W - (handX + OWN_UNITS * ow) - 18, tw * 0.3, tw * TRAY_IN);
  const trayTop = mine ? ownTop : H - 12 - fh * 2.6;
  const tray: Rect = { x: W - trayIn, y: trayTop, w: 2 * trayIn, h: H - 10 - trayTop };
  const trayH = tray.h;
  // Dropping a finished pile is not a precision job: anywhere from a little short of the tray to past the edge of the screen.
  const trayHit: Rect = { x: tray.x - fw * 0.9, y: tray.y - fh * 0.4, w: fw * 0.9 + tray.w + W, h: tray.h + fh * 0.4 + H };
  const trays = game.tray.length;
  const trayStep = trays > 1 ? Math.min(th * 0.36, (trayH - 2 * pad - th) / (trays - 1)) : 0;
  // End of round: the tray piles walk out to a row across the middle of the table.
  const outStep = trays > 1 ? Math.min(fw * 1.15, (middle.w * 0.8 - fw) / (trays - 1)) : 0;
  const out = game.tray.map((_, k): Rect => ({ x: W / 2 - (outStep * (trays - 1) + fw) / 2 + k * outStep, y: middle.y + (middle.h - fh) / 2, w: fw, h: fh }));

  // Your hand is placed last: a long work pile may rise into what felt there is between the row and the disc.
  const me = mine
    ? placeHand(
        mine,
        {
          x: handX,
          y: ownTop,
          w: ow,
          gap: ow * OWN.gap,
          wide: ow * OWN.wide,
          fan: ow * (ow < MINI_BELOW ? 0.55 : OWN.fan),
          workFan: oh * 0.3,
          workRoom: H - 8 - ownTop - oh,
          // (Not once the wash begins: that felt is where the sorted piles' counts go.)
          workRise: stage === 'wash' || stage === 'sheet' ? 0 : Math.max(0, ownTop - 6 - (cy + disc.ry)),
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
    const put = (pile: readonly AnyCard[], r: Rect, z: number, kind: PileKind, i: number, up: boolean, rot: number) =>
      pile.slice(-2).forEach((card, k) => cards.push({ card, x: r.x, y: r.y, s: r.w / CARD_W, z: z + k, up, pile: kind, mine: false, at: i, rot }));
    game.slots.forEach((pile, i) => slots[i] && put(pile, slots[i], 5000 + i * 4, 'slot', i, stage === 'live', slots[i].rot));
    game.tray.forEach((pile, k) => {
      const home: Rect = { x: tray.x + pad + TRAY_JOG[k % TRAY_JOG.length]! * tw, y: tray.y + pad + k * trayStep, w: tw, h: th };
      put(pile, stage === 'out' ? out[k]! : home, 5200 + k * 4, 'tray', k, stage !== 'out', 0);
    });
  }

  // Piles are at least 0.14 of a card apart in every direction (shared/table.ts), so a margin of 0.05 keeps drop areas from touching.
  return { cards, me, opponents, disc, slots, slotHit: slots.map((r) => r && grow(r, fw * 0.05)), tray, trayHit, out, middle, fs };
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
