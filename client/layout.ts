// Table geometry. A pure function from (viewport, game) to where every
// visible card sits. Every card is absolutely positioned on one layer and
// keyed by its id, so a card moving between piles - yours or anyone's - is
// just the same element animating to new coordinates.
import { OPP } from '../shared/flight';
import { canDrop, DEAL_MS, hasOpened, isHidden, WORK_PILES } from '../shared/engine';
import { cardSize, feltHw, offFelt, pileGap, TABLE, type Pt } from '../shared/table';
import type { AnyCard, GameState, PlayerState } from '../shared/types';
import { CARD_H, CARD_W } from './cards/Face';
import { clamp } from '../shared/numbers';

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
 * loose, tilted stacks ('out'); those are spread out too ('wash'); everything is sorted into a pile per player ('sort'),
 * until every pile is gathered and the winner is marked ('won'); the scores ('sheet').
 */
export type Stage = 'live' | 'flip' | 'spread' | 'out' | 'wash' | 'sort' | 'won' | 'sheet';
const STAGES: readonly Stage[] = ['live', 'flip', 'spread', 'out', 'wash', 'sort', 'won', 'sheet'];
/** The wash lies spread out and the piles are about to be gathered ('sort'), or have been ('won', 'sheet'). On a phone that is when the table is cleared. */
export const sorting = (stage: Stage): boolean => STAGES.indexOf(stage) >= STAGES.indexOf('sort');
/** Every player's score for the round is out, and who won it. */
export const revealed = (stage: Stage): boolean => STAGES.indexOf(stage) >= STAGES.indexOf('won');

/**
 * Whether the middle's cards are the finale's canvas's to draw at `stage`, and no longer this layer's: the centre
 * piles from when they are spread out, the finished piles of the tray a step later, when they are. Both layers ask
 * here and nowhere else (not a clock of their own), so at every stage a card is drawn by exactly one of the two.
 */
export const onCanvas = (stage: Stage, pile: 'slot' | 'tray'): boolean => STAGES.indexOf(stage) >= STAGES.indexOf(pile === 'slot' ? 'spread' : 'wash');

/**
 * Which side of a card shows. Where it lies says face-up or face-down; a card that lies face-up but whose face this
 * view does not know yet (just turned up by a move of yours the server has not answered) is `unseen`: it is drawn
 * part way over, back still showing, until the face comes.
 */
export type Showing = 'up' | 'down' | 'unseen';

export interface Placed {
  card: AnyCard;
  x: number;
  y: number;
  /** Scale relative to the CARD_W x CARD_H drawing size. */
  s: number;
  z: number;
  /** Which side shows: see `Showing`. */
  face: Showing;
  pile: PileKind;
  /** In one of the viewing player's own piles. */
  mine: boolean;
  /** Which pile of its kind: which slot, which tray pile, which work pile of the hand. */
  at: number;
  /** Tilt in degrees: a pile in the middle is never quite square. */
  rot: number;
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
  /**
   * The badge that says so: a disc `d` across, centred here. It sits just out from the bottom right corner of the
   * pile's top card as the card lies in its hand (never so far that it would reach the first work pile), turned with
   * the hand if that is turned, and is larger on a larger card.
   */
  count: Pt & { d: number };
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
   * Which way the window is laid out (`shapeOf`). `tall`: a narrow upright screen (a phone held upright), laid out its
   * own way: a bar across the top for the buttons (`bar` high), everyone else in rows under it, the felt, and your own
   * hand in two rows at the bottom. `low`: a phone on its side (see LOW): everyone else in a column at each side, the
   * felt as high as the room above your hand. Either is a phone (not `wide`): at the end of a round its table is
   * cleared for the sorted piles (`cleared`).
   */
  shape: Shape;
  bar: number;
  /** Those at the sides stand in columns of upright hands, not each where their chair is round the table: a phone on its side, or a U (see `seating`). */
  cols: boolean;
  /**
   * The end of a round on a phone, once the middle's cards have been washed on the felt: the table is cleared. The
   * hands and the felt are not shown, and the sorted piles have the whole window (Finale.tsx).
   */
  cleared: boolean;
  /** What the screen keeps for itself at its sides (a notch). */
  keep: Insets;
  /** The buttons in the corners (`corners`). */
  at: Corners;
  /** The round's clock, where nothing else is. Null: none to show, or no room for it. */
  clock: ClockAt | null;
  /** By your own hand (`furnish`): your line, "I'm stuck" and the vote. Null: not there. (The count on your nertz pile is the hand's: `Seat.count`.) */
  name: NameAt | null;
  stuck: Rect | null;
  vote: Rect | null;
  /** "I'm stuck" and the vote are small pills, not full buttons. */
  pills: boolean;
}

const RATIO = CARD_H / CARD_W;
const grow = (r: Rect, m: number): Rect => ({ x: r.x - m, y: r.y - m, w: r.w + 2 * m, h: r.h + 2 * m });
export const inside = (r: Rect, x: number, y: number): boolean => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;

/** The middle of `r`. */
export const middle = (r: Rect): Pt => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
/** How much of `a` and `b` lies over the other, in px². */
export const overlap = (a: Rect, b: Rect): number =>
  Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));

/**
 * The one drop area a release counts for: the area under the pointer, and only if the pointer is over none, the area
 * under the centre of the grabbed card (`card`, where it is drawn). A card picked up by its corner is aimed with the
 * pointer; one flung with the pointer trailing off the pile still lands by where it lies. Failing both, it goes to the
 * area that lies mostly under the card: more than half of it, or of the card if that is the smaller. (So a card of
 * your hand let go with a far smaller pile of the middle under it lands there, on the one it covers more if there are
 * two; one that only touches an area has not been put down on it, and between two piles as large as itself it goes
 * back.) Last, under a finger only (`reach`), the nearest area within reach. One chain for every hand, and always one
 * specific pile.
 */
export function dropTarget<T extends { hit: Rect }>(targets: readonly T[], pointer: Pt, card: Rect | null, reach = 0): T | undefined {
  const centre = card && middle(card);
  const over = targets.find((t) => inside(t.hit, pointer.x, pointer.y)) ?? (centre ? targets.find((t) => inside(t.hit, centre.x, centre.y)) : undefined);
  if (over) return over;
  // Neither is over an area: the one that lies mostly under the card (more than half of the area, or of the card if
  // that is the smaller: a card that only touches an area is not over it).
  let best: T | undefined;
  let most = 0;
  for (const t of card ? targets : []) {
    const covered = overlap(card!, t.hit);
    if (covered > most && 2 * covered > Math.min(card!.w * card!.h, t.hit.w * t.hit.h)) [best, most] = [t, covered];
  }
  if (best) return best;
  // Under a finger nothing is aimed to the pixel: failing all of that, the nearest area within `reach` of where it
  // points (a mouse has no reach). (Only areas that would take the card are ever asked about, so nothing is misplaced.)
  const at = centre ?? pointer;
  let least = reach;
  for (const t of reach > 0 ? targets : []) {
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
  const from = L.shape === 'tall' ? L.bar + 4 : 12; // upright, the corner belongs to the buttons in the bar
  return [from, ...hands.flatMap((r) => [r.y, r.y + r.h + 6]).filter((y) => y > from)].sort((a, b) => a - b).find(clear) ?? from;
}

/** Faces narrower than this on screen use the large-print rendition. */
export const MINI_BELOW = 52;
/** How far past `MINI_BELOW` a card that is growing or shrinking has to go before its drawing changes, so one near it does not flicker. */
export const MINI_SLACK = 3;

/**
 * Whether a card drawn `w` pixels wide on screen shows the large-print rendition. This follows the size it is
 * drawn at, whatever it is doing and whoever holds it. One on its way (`was`: what it showed) changes only once it
 * is `MINI_SLACK` past the line. One at rest (no `was`) is just what its width says.
 */
export function drawnMini(w: number, was?: boolean): boolean {
  return w < (was === undefined ? MINI_BELOW : was ? MINI_BELOW + MINI_SLACK : MINI_BELOW - MINI_SLACK);
}

/** A pile that shows its thickness (the nertz pile, the stock): each card lies this far below the one on it, for a card drawn full size. */
const LEAN = 0.55;
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
/**
 * How much of a work pile's card shows, as a share of what a face-up card shows: fanned out (`fan`), and squeezed as
 * far as it goes while there is room (`least`). A face-up card keeps its whole rank; a face-down one has none to show,
 * only an edge, just enough to count the pile by.
 */
interface Strip {
  fan: number;
  least: number;
}
const UP: Strip = { fan: 1, least: 1 };
const DOWN: Strip = { fan: 0.45, least: 0.25 }; // (an edge a little deeper than a back's white border: each shows a band of its colour)
/**
 * Past their least, the oldest cards give way down to this share of a face-up card's whole rank. A face-down card's
 * edge is already less: it keeps that.
 */
const SLIVER = 0.4;

interface HandSpec {
  x: number;
  y: number;
  w: number; // card width
  gap: number; // between neighbouring piles
  wide: number; // between the groups (nertz | work | stock+waste)
  fan: number; // room kept free to the right of the waste (it was once fanned; the pile itself is squared up)
  workFan: number; // preferred vertical offset in a work pile
  workRoom: number; // height available to a work pile below its first card
  /** That height pile by pile, where it is not the same for all four: each of your own fans down as far as the first thing under it (`furnish`). */
  rooms?: readonly number[];
  /** The count on the nertz pile stands at its top right corner, not its bottom right (`furnish`: the bottom one is taken). */
  countUp?: boolean;
  /** How far above the row each pile, too long for its room, may start instead: as far up as the cloth over it is clear of the felt and of everyone else's hands. */
  workRise: readonly number[];
  minStrip: number; // the least a face-up card may show while there is room: its whole rank. 0 = squeeze all alike
  z: number;
  mine: boolean;
  /** Lay the piles out from right to left. */
  flip?: boolean;
  /** A work pile being looked at (hovered, or tapped on a touch screen): fanned out in full, rising as far as it needs to over the felt. */
  peek?: number | null;
  /** Whether the tops lie face-up yet: a work pile's once the deal is done, the nertz pile's once play opens. */
  open: Open;
  /**
   * A hand in two rows (a narrow upright screen): the work piles start at (x, y), and the nertz pile and the stock
   * and waste lie on a second row under them, at `y`: the nertz pile at `nertzX`, the stock at `stockX`. `box` is
   * what the whole hand covers.
   */
  rows?: { y: number; nertzX: number; stockX: number; box: Rect };
}

/**
 * How far below a fanned pile's first card each card sits, for the share of a face-up card's strip each shows
 * (`show`). Every card shows its whole fan (`fan`) if that fits in `room`. If not, all are squeezed alike towards
 * their least (a face-up card's is `min`: its whole rank). Past that only the oldest cards give way, down to slivers,
 * and the newest keep their least: they are the ones in play.
 */
export function fanOut(show: readonly Strip[], fan: number, min: number, room: number): number[] {
  const covered = show.slice(0, -1); // the top card lies open
  const sum = (a: readonly number[]) => a.reduce((x, y) => x + y, 0);
  const full = covered.map((c) => c.fan * fan);
  const least = covered.map((c) => c.least * min);
  const sliver = covered.map((c) => Math.min(c.least, SLIVER) * min);
  let steps = full;
  if (room < sum(full) && room >= sum(least)) {
    const t = (room - sum(least)) / (sum(full) - sum(least));
    steps = least.map((l, j) => l + t * (full[j]! - l));
  } else if (room < sum(least) && room > sum(sliver)) {
    let spare = room - sum(sliver);
    steps = [...sliver];
    for (let j = steps.length - 1; j >= 0 && spare > 0; j--) {
      const more = Math.min(spare, least[j]! - sliver[j]!);
      steps[j]! += more;
      spare -= more;
    }
  } else if (room < sum(least)) steps = sliver.map((s) => (s * room) / sum(sliver)); // absurdly long: squeezed evenly
  let y = 0;
  return [0, ...steps.map((s) => (y += s))];
}

/** The count of a nertz pile is centred this share of its own width out from the corner of the card, both ways: most of it is off the card. */
const COUNT_OUT = 0.2;
/** How wide the count on a nertz pile of cards `w` wide is: larger on a larger card, never as wide as a small one. */
const countD = (w: number): number => Math.round(clamp(Math.min(13 + 0.27 * w, 0.9 * w), 15, 36));

/**
 * The count on a hand's nertz pile, whose top card lies at (`nx`, `ny`) as the hand is drawn: just out from the card's
 * bottom right corner, or its top right one (`up`: where the bottom one would be on the menu's button). Seen from across
 * the table that is the pile's outer corner, with nothing beside it; otherwise the first work pile is, and the count
 * keeps short of it. (In two rows the pile stands at the foot of the window, with no room under it: the count goes
 * further out sideways instead.)
 */
function countOn(h: Pick<HandSpec, 'w' | 'wide' | 'rows' | 'flip' | 'countUp'>, nx: number, ny: number): Pt & { d: number } {
  const d = countD(h.w);
  const out = h.rows ? 2 * COUNT_OUT * d : h.flip ? COUNT_OUT * d : Math.min(COUNT_OUT * d, h.wide - d / 2 - 2);
  return { x: nx + h.w + out, y: h.countUp ? ny - COUNT_OUT * d : ny + h.w * RATIO + COUNT_OUT * d, d };
}

/** The count as it is drawn (Table.tsx): kept inside the window and clear of what the screen keeps at its edges (`keep`), with a little room round it. */
export function countBox(c: Pt & { d: number }, W: number, H: number, keep: Insets = NO_INSETS): Rect {
  const r = c.d / 2 + 2;
  const x = clamp(c.x, keep.l + r, W - keep.r - r);
  const y = clamp(c.y, r, H - keep.b - r);
  return { x: x - r, y: y - r, w: 2 * r, h: 2 * r };
}

/** Where the piles of a hand start, left to right (before it is mirrored), and the row its nertz pile, stock and waste lie on. */
function pilesOf(h: Pick<HandSpec, 'x' | 'y' | 'w' | 'gap' | 'wide' | 'rows'>) {
  const workX = h.rows ? h.x : h.x + h.w + h.wide;
  const stockX = h.rows ? h.rows.stockX : workX + 4 * h.w + 3 * h.gap + h.wide;
  return { nertzX: h.rows ? h.rows.nertzX : h.x, rowY: h.rows ? h.rows.y : h.y, workX, stockX, wasteX: stockX + h.w + h.gap };
}

/** How far below the row the bottom card of a full stock lies, for cards `w` wide (its top card is level with the row). */
const stockDrop = (w: number): number => STOCK_FULL_EDGES * 2 * LEAN * (w / CARD_W);

interface Open {
  work: boolean;
  nertz: boolean;
}

function placeHand(p: PlayerState, h: HandSpec, out: Placed[]): Seat {
  const s = h.w / CARD_W;
  const ch = h.w * RATIO;
  // Everything is worked out left to right; a hand seen from across the table is then mirrored within its own width.
  const span = 7 * h.w + 4 * h.gap + 2 * h.wide + 2 * h.fan;
  const mx = (x: number, w = h.w): number => (h.flip ? 2 * h.x + span - x - w : x);
  const rect = (x: number, y: number): Rect => ({ x: mx(x), y, w: h.w, h: ch });
  const put = (card: AnyCard, x: number, y: number, z: number, pile: PileKind, up: boolean, at = 0) =>
    out.push({ card, x: mx(x), y, s, z: h.z + z, face: !up ? 'down' : isHidden(card) ? 'unseen' : 'up', pile, mine: h.mine, at, rot: 0 });

  // Nertz pile: lower cards peek out underneath so the pile shows its thickness.
  const lean = LEAN * s;
  const { nertzX: nx, rowY: ny, workX, stockX, wasteX } = pilesOf(h); // (`ny`: the row the nertz pile, the stock and the waste lie on)
  // Someone else's pile is drawn small, and its count says how high it is: only its top two cards are drawn (the top,
  // and the one that comes up when it goes). The rest are not on the table at all, so there are fewer cards to draw.
  p.nertz.forEach((c, i) => {
    const under = p.nertz.length - 1 - i;
    if (h.mine || under < 2) put(c, nx, ny + under * lean, i, 'nertz', h.open.nertz && under === 0);
  });

  // Work piles fan downwards; the face-down cards at the bottom of the pile take a narrower strip each.
  const margin = h.gap * 0.4;
  const workHit: Rect[] = [];
  const workAt = p.work.map((_, i) => rect(workX + i * (h.w + h.gap), h.y));
  const work = p.work.map(({ cards: pile, down }, i) => {
    const x = workX + i * (h.w + h.gap);
    const room = h.rooms?.[i] ?? h.workRoom;
    const show = pile.map((_, j) => (j < down ? DOWN : UP));
    // A pile too long for the room below the row squeezes first, its face-up cards down to their whole ranks and its
    // face-down ones to an edge each; only what still does not fit then starts higher up, as far as the felt above it is free.
    const covered = show.slice(0, -1);
    const wanted = covered.reduce((a, c) => a + c.fan, 0) * h.workFan;
    const rise = clamp(covered.reduce((a, c) => a + c.least, 0) * h.minStrip - room, 0, h.workRise[i] ?? 0);
    const at = fanOut(show, h.workFan, h.minStrip, room + rise);
    if (i === h.peek) {
      // Looked at: every card shows its whole strip, the pile reaching up over whatever is above it (and above the
      // middle's cards) as far as the top of the window. Its drop area and its top card stay where they were.
      const up = clamp(wanted - room, 0, h.y - 8);
      const full = fanOut(show, h.workFan, h.minStrip, room + up);
      pile.forEach((c, j) => put(c, x, h.y - up + full[j]!, PEEK_Z + j, 'work', h.open.work && j >= down, i));
    } else pile.forEach((c, j) => put(c, x, h.y - rise + at[j]!, 40 + i * 20 + j, 'work', h.open.work && j >= down, i));
    workHit.push({ x: mx(x - margin, h.w + 2 * margin), y: h.y - rise - margin, w: h.w + 2 * margin, h: ch + room + rise + 2 * margin });
    return rect(x, h.y - rise + (at.at(-1) ?? 0));
  });

  // Every third card shows an edge (every twelfth in someone else's, which is drawn small: fewer cards to draw), and so
  // does the top one. A card's height in the stack depends only on how many cards lie under it, so taking cards off
  // the top never moves the ones that stay: the stack just gets lower. The top is always drawn, so each card of a
  // draw is on the table, on top, before it lifts off.
  //
  // A group in flight (this window deals its cards one at a time: net.ts `dealtBy`) is counted off the stock into the
  // hand, as with real cards: each card, as it is dealt, lifts off by itself onto a small face-down stack held just
  // above the stock, not quite square, so three separate cards are seen to be pulled. The complete group is held
  // there a beat (the last step), then lands on the waste, every card turning over as it goes, the last on top.
  const lifted = p.draw && !p.draw.down ? (p.draw.off ?? p.draw.n) : 0;
  const top = p.stock.length - 1;
  const stockLow = stockDrop(h.w); // where the bottom card of the stock lies, below the row
  p.stock.forEach((c, j) => {
    if (j % (h.mine ? STOCK_PER_EDGE : 4 * STOCK_PER_EDGE) === 0 || j === top) put(c, stockX, ny + Math.max(0, STOCK_FULL_EDGES - j / STOCK_PER_EDGE) * lean * 2, 20 + j, 'stock', false);
  });

  const n = p.waste.length - lifted;
  // In the order dealt, each UNDER the one before, as cards counted off into a hand are: the first stays on top, and
  // turning the stack over is what leaves the last one showing. (Still cards of the stock, they come up at the level
  // they are held at: each under the ones already held. See level.ts.)
  p.waste.slice(n).forEach((c, k) => {
    const o = HELD_OFF[k % HELD_OFF.length]!;
    put(c, stockX + h.w * (HELD.x + o.x), ny - ch * (HELD.y - o.y), Math.max(20 + p.stock.length, 34) + HELD_Z + (lifted - 1 - k), 'stock', false); // well above the stock and the waste
    out.at(-1)!.rot = (h.flip ? -1 : 1) * o.rot;
  });
  // The waste is one squared-up pile: only its top card shows. (The few cards under the top are drawn too, exactly
  // beneath it, so there is something there when the top leaves.)
  for (let i = Math.max(0, n - WASTE_SHOWN); i < n; i++) put(p.waste[i]!, wasteX, ny, 30 + (i - (n - WASTE_SHOWN)), 'waste', true);

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
    // The count, at the bottom right of the card as it lies here. Seen from across the table that is the pile's outer
    // corner, with nothing beside it; otherwise the first work pile is, and the count keeps short of it. (In two rows
    // the pile stands at the foot of the window, with no room under it: the count goes further out sideways instead.)
    count: countOn(h, mx(nx), ny),
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
    count: { ...seat.count, ...at(seat.count.x, seat.count.y) },
  };
}

/** Your own card is this share of the window's height wide (if the width allows), and never wider than OWN_MAX. */
const OWN_K = 0.108;
const OWN_MAX = 150;
/** The widest an opponent's card is drawn, on however large a screen. */
const OPP_MAX = 96;
/** The narrowest an opponent's card is drawn in a row or column of hands (a phone, or more than six at the table). */
const OPP_LEAST = 11;
/** The widest a card in the middle is drawn, in widths of your own. */
const CENTRE_MAX = 1.2;
/**
 * Your own hand lies over the middle's cards (z 5000 to 6000, the tray's among them): what of it reaches onto the felt
 * (the group held over the stock, above all) covers a pile lying at your edge of it. It lies over everyone else's cards
 * in the air too, which come between the two (level.ts).
 */
const OWN_Z = 6400;
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

/**
 * How many of the others sit at your left, across from you and at your right. In that order they go round the felt,
 * clockwise from your left: up the left side, across the top from left to right, down the right side.
 * - A phone held upright has them all above the felt (in rows).
 * - A phone on its side is too low for anyone above the felt: half of them in a column at each side.
 * - Any other window: up to five sit each where their chair stands round the table (`seatDir`), which is one at each
 *   side from three on and the rest across the top. More sit in a U, a column at each side and a row across the top
 *   between them: a third of them at each side, as near as it comes (of six 2, 2 and 2; of seven 2, 3 and 2; of eight
 *   3, 2 and 3; of nine 3, 3 and 3), so that no column holds more than three and no row more than three. (A U has
 *   two or more at a side. One at a side is laid out as at a table of six, turned, with the row spread by its chairs.)
 */
export function seating(others: number, W: number, H: number): { left: number; top: number; right: number } {
  const shape = shapeOf(W, H);
  if (shape === 'tall') return { left: 0, top: others, right: 0 };
  if (shape === 'low') return { left: Math.ceil(others / 2), top: 0, right: Math.floor(others / 2) };
  const side = others > 5 ? Math.round(others / 3) : others > 2 ? 1 : 0;
  return { left: side, top: others - 2 * side, right: side };
}
/**
 * The columns of a U start `top` down, under the chat's buttons and the grace countdown (the row across the top is
 * between them, not over them), and end above your hand. A hand in one is no wider than `share` of the window: the
 * felt has the middle of it.
 */
const U = { top: 12 + COUNTDOWN.h + 4, share: 0.17 } as const;
/**
 * Whoever watches without a seat has no hand of their own along the bottom edge: the line that says they are watching
 * stands there instead (App.tsx, `.banner.low` in base.css: one line 40 high, in the middle, 12 above the bottom). `h` is
 * kept for it over those 12 (the line, and 10 clear above it), and the table is laid out over that: the hand they watch
 * from behind, the felt, the right-hand column of a crowded table. (The left-hand column comes down beside the line as
 * it does beside a hand, as far as the menu's button: LOW.)
 */
export const WATCH = { h: 50 } as const;

/** What the screen keeps for itself at its edges (a notch at the side of a phone on its side, the bar at the bottom): nothing is put there. */
export interface Insets {
  l: number;
  r: number;
  b: number;
}
const NO_INSETS: Insets = { l: 0, r: 0, b: 0 };

/** How wide your own cards are in a window (`tall`: laid out for a phone held upright), as far as the window alone decides it. */
const ownWidth = (W: number, H: number, tall: boolean): number =>
  tall
    ? clamp(Math.min((W - 2 * TALL.edge) / (4 + 3 * TALL.gap + TALL.tray), (H * TALL.share) / (RATIO * (2 + TALL.room + TALL.between))), 30, OWN_MAX)
    : clamp(Math.min((W - 2 * 16) / (OWN_UNITS + 0.4), H * OWN_K), 34, OWN_MAX);

// ---------------------------------------------------------------- what stands round the cards
//
// The buttons in the corners, the round's clock, your own name, "I'm stuck" and the vote beside it are placed here
// too, by one rule: each has a place of its own, clear of the others and inside the window, and your cards are then
// laid out round them (a work pile fans down as far as the first thing under it, and no further). When a window has
// not the room for all of it, what gives way is said here as well: the clock first, then your name. (The clock stands
// only where your line and the pills are as whole as they are without it: `computeLayout`.)

/** One of the chat's buttons (Chat.tsx), by what is on it: the word, an icon, an icon and a count (of one digit, or two), the microphone, the small badge that says the sound is off. */
export type ChatButton = 'text' | 'icon' | 'count' | 'count2' | 'mute' | 'badge';

/** What there is to place besides the cards: it changes with the table (someone joins voice, a round starts, the vote comes up), not with the window. */
export interface Fittings {
  /** The chat's buttons, left to right. */
  chat: readonly ChatButton[];
  /** The round has a clock to show. */
  clock: boolean;
  /** The vote to end the round stands beside "I'm stuck". */
  vote: boolean;
  /** How wide your own line (your colour, name and total) is written, about: `nameWidth`. */
  name: number;
}
export const NO_FITTINGS: Fittings = { chat: [], clock: false, vote: false, name: 0 };

/** About how wide "name total" is written in your own line. Never less than it is: the line is cut off at this width. */
export const nameWidth = (name: string, total: string): number => Math.ceil(22 + name.length * 8.4 + total.length * 11);

export type Shape = 'tall' | 'low' | 'wide';
/** Which way a window is laid out: a phone held upright (TALL), one on its side (LOW), or the usual. */
export const shapeOf = (W: number, H: number): Shape => (isTall(W, H) ? 'tall' : isLow(W, H) ? 'low' : 'wide');

/** How wide each of the chat's buttons is: as a rule, and in the bar of an upright phone, where they are larger for a thumb while there is room. They stand `gap` apart, `h` high (`barH` in the bar). */
const CHAT_W: Record<ChatButton, readonly [number, number]> = { text: [36, 44], icon: [36, 44], count: [50, 58], count2: [58, 66], mute: [36, 36], badge: [28, 28] };
const CHAT = { gap: 6, h: 32, barH: 36 } as const;
/** The one button of the corner, the menu (Settings.tsx `Corner`): `size` across. */
export const KNOB = { size: 36 } as const;
/** The room the clock is given: in line after the menu's button or above it (large figures), or in line after the chat's buttons (small ones). */
const CLOCK = { above: { w: 58, h: 22 }, beside: { w: 44, h: 16 } } as const;
/** "I'm stuck" and the vote: as small pills (`h` high, `gap` apart, each as wide as its longest wording; under `min` the wording is cut short; never lower than `low`) or, where there is room under your stock, full buttons. */
export const PILL = { stuck: 124, vote: 112, h: 32, gap: 6, min: 84, low: 24, full: { h: 39, gap: 8, min: 150, drop: 16 } } as const;
/** Your own line, `h` high: as wide as what it says (no narrower than `min`), or in full under your nertz pile (`full`: `w` wide, no narrower than its `min`). */
const NAME = { h: 20, min: 48, max: 150, full: { w: 170, min: 120, drop: 14 } } as const;

export interface Corners {
  shape: Shape;
  /** The chat's buttons, top left: all of them, and how wide each is, in order. */
  chat: Rect;
  chatParts: number[];
  /** The menu's button: bottom left, or at the right of the bar across the top of an upright phone. */
  knobs: Rect;
  /** The way to feedback, on its own: bottom right, as large as the menu's button. Null on a phone, where it is in the menu. */
  feedback: Rect | null;
  /** The places the round's clock may stand, the best first: the table takes the first with nothing else there that leaves your line and the pills whole (`Layout.clock`). `small`: in small figures. */
  clocks: ClockAt[];
}

export interface ClockAt extends Rect {
  small: boolean;
}

/**
 * Where the buttons in the corners stand, on every screen (a table is not needed for it).
 *
 * Upright, both are in the bar across the top, the chat's buttons from the left and the menu's from the right. When
 * the bar is too narrow for the chat's as they are there (larger, for a thumb), they are no larger than elsewhere, and
 * narrower still they are squeezed; the clock stands between them, by the menu's. Otherwise the chat is top left and the menu's button
 * bottom left, and feedback's bottom right; the clock would stand in line after the menu's, or else above it (where
 * your hand or your line is in the way after it), or else after the chat's buttons.
 */
export function corners(W: number, fullH: number, keep: Insets = NO_INSETS, fit: Fittings = NO_FITTINGS): Corners {
  const H = fullH - keep.b;
  const shape = shapeOf(W, H);
  const parts = (large: 0 | 1) => fit.chat.map((b) => CHAT_W[b][large]);
  const across = (ws: readonly number[]) => ws.reduce((a, b) => a + b, 0) + Math.max(0, ws.length - 1) * CHAT.gap;
  if (shape === 'tall') {
    const [l, r] = [Math.max(8, keep.l), Math.max(8, keep.r)];
    const room = W - l - r - 8 - KNOB.size; // (8: between the chat's buttons and the menu's)
    // In the bar the badge that says the sound is off is a disc as tall as the bar (chat.css), large or not.
    const parts = (large: 0 | 1) => fit.chat.map((b) => (b === 'badge' ? CHAT.barH : CHAT_W[b][large]));
    const large: 0 | 1 = across(parts(1)) <= room ? 1 : 0;
    // (Narrower still: the chat's buttons are squeezed into what is left. No phone is.)
    const squeeze = Math.min(1, Math.max(0, room) / Math.max(1, across(parts(large))));
    const chatParts = parts(large).map((w) => w * squeeze);
    const chat: Rect = { x: l, y: 7, w: across(parts(large)) * squeeze, h: CHAT.barH };
    const knobs: Rect = { x: W - r - KNOB.size, y: 7, w: KNOB.size, h: KNOB.size };
    // The clock in the bar, just left of the menu's button, where it is clear of the chat's buttons.
    const bar: ClockAt = { x: knobs.x - 10 - CLOCK.above.w, y: knobs.y + (KNOB.size - CLOCK.above.h) / 2, ...CLOCK.above, small: false };
    return { shape, chat, chatParts, knobs, feedback: null, clocks: fit.clock && chat.x + chat.w + 8 <= bar.x ? [bar] : [] };
  }
  const chat: Rect = { x: Math.max(10, keep.l), y: 10, w: across(parts(0)), h: CHAT.h };
  const knobs: Rect = { x: Math.max(12, keep.l), y: H - 10 - KNOB.size, w: KNOB.size, h: KNOB.size };
  const feedback: Rect | null = shape === 'wide' ? { x: W - Math.max(12, keep.r) - KNOB.size, y: knobs.y, w: KNOB.size, h: KNOB.size } : null;
  const after = { x: knobs.x + knobs.w + 10, y: knobs.y + (KNOB.size - CLOCK.above.h) / 2, ...CLOCK.above, small: false };
  const above = { x: knobs.x, y: knobs.y - 8 - CLOCK.above.h, ...CLOCK.above, small: false };
  const beside = { x: chat.x + chat.w + 8, y: chat.y + (chat.h - CLOCK.beside.h) / 2, ...CLOCK.beside, small: true };
  return { shape, chat, chatParts: parts(0), knobs, feedback, clocks: fit.clock ? [after, above, beside] : [] };
}

/**
 * The lines under the chat's buttons as chat.css sets them: `drop` below the buttons (and once more below the line to
 * type in, `input` high), each line `line` high and `gap` from the next, as wide as `wide` of the window at most `most`;
 * and `clear` kept above the felt.
 */
export const UNDER = { drop: 8, input: 35.5, line: 23.5, gap: 3, wide: 0.78, most: 340, clear: 4 } as const;

/**
 * How many lines (of one row each) stand under the chat's buttons before they would run onto the felt (`board`):
 * fewer while you type, the line to type in being above them. At least one; with no felt shown, or none under them,
 * no fewer than `most`. The newest are the ones shown.
 */
export function chatLines(at: Corners, W: number, board: Rect | null, typing: boolean, most: number): number {
  const x = at.chat.x + 2;
  if (!board || board.x >= x + Math.min(UNDER.most, W * UNDER.wide) || board.x + board.w <= x) return most;
  const top = at.chat.y + at.chat.h + 2 * UNDER.drop + (typing ? UNDER.input : 0);
  const fit = Math.floor((board.y - UNDER.clear - top + UNDER.gap) / (UNDER.line + UNDER.gap));
  return Math.max(1, Math.min(most, fit));
}

/** Your own line at the table: where, in full (under your nertz pile) or as wide as what it says, and which end of its place it is written from. */
export interface NameAt extends Rect {
  full: boolean;
  align: 'start' | 'centre' | 'end';
}

/** What stands by your own hand: your line, "I'm stuck" and the vote. Null: not there (no room, or nothing to show). */
interface Furniture {
  name: NameAt | null;
  stuck: Rect;
  /** The vote's place, whether or not it is up (`Fittings.vote`). */
  vote: Rect;
  /** The two are small pills, not full buttons. */
  pills: boolean;
  /** How far below the row each work pile may fan. Undefined: as far as any hand's. */
  rooms: number[] | undefined;
  /** The count on your nertz pile stands at its top right corner (`HandSpec.countUp`). */
  countUp: boolean;
}

const meets = (a: Rect, b: Rect, m = 0): boolean => a.x < b.x + b.w + m && b.x < a.x + a.w + m && a.y < b.y + b.h + m && b.y < a.y + a.h + m;

/** The end of what stands from the left in the row of the menu's button: the button, and the clock where it is in line after it. */
export const rowEnd = (at: Corners, clock: ClockAt | null): number => (clock && clock.y < at.knobs.y + at.knobs.h && clock.y + clock.h > at.knobs.y ? clock.x + clock.w : at.knobs.x + at.knobs.w);

/**
 * Places what stands by your own hand, given where its piles are (`h`), the buttons in the corners (`at`) and where
 * the tray begins (`trayX`). Then says how far each work pile may fan: down to the first of these things under it.
 *
 * Upright, all of it is in the gap between the count on your nertz pile and your stock: your line, and under it the two pills,
 * side by side if the gap is wide enough for that, else one above the other; when they would be too low to press,
 * your line goes.
 *
 * Otherwise, in the strip under your row of cards:
 * - "I'm stuck" stands under your stock and the vote beside it or under it: as full buttons one under the other, or
 *   side by side, or as pills one under the other, whichever comes first that fits above the bottom of the window and
 *   short of the tray; failing all three (and in any window that is low), as pills in a
 *   row level with the menu's button. Too wide for the room right of your stock, that row moves left, as far as the
 *   button (or the clock in line after it); narrower than that, its pills shrink.
 * - Your line stands under your nertz pile in full while there is the height for it and the width beside the button
 *   (and the clock above it). Otherwise it is as wide as what it says: tucked under the pile and its count
 *   while that is clear of everything and short of your work piles; failing that, level with the button: ending under
 *   the end of the nertz pile, or short of the count on the pile or a pill where one of them is in its row; where that
 *   would put it on the button, right after the button (or the clock in line after it), and only then cut short, by
 *   whatever is in its way (too little room for a name: none).
 * - Where the clock is in line after the button, all of this starts after the clock instead. `computeLayout` puts it
 *   there only where your line and the pills are then as whole as without it (otherwise it tries the clock's next place).
 * - The count on your nertz pile is placed first, and all of this keeps clear of it; where its place under the pile's
 *   corner is the menu's button, it stands at the top corner instead.
 */
function furnish(W: number, H: number, keep: Insets, at: Corners, clock: ClockAt | null, fit: Fittings, h: HandSpec, trayX: number): Furniture {
  const { nertzX, rowY, workX, stockX } = pilesOf(h);
  const ow = h.w;
  const oh = ow * RATIO;
  const nertzR = nertzX + ow;
  const base = rowY + oh; // the bottom of the row
  const two = fit.vote ? 2 : 1;
  // The count on your nertz pile is there before anything else, and the rest keeps clear of it. Where its place under
  // the pile's corner is the menu's button, it stands at the top corner instead.
  const sides = { ...keep, b: 0 }; // (`H` already stops short of the bottom the screen keeps)
  const countUp = !h.rows && meets(countBox(countOn(h, nertzX, rowY), W, H, sides), at.knobs);
  const badge = countBox(countOn({ ...h, countUp }, nertzX, rowY), W, H, sides);
  if (h.rows) {
    const from = Math.max(nertzR + 10, badge.x + badge.w + 2);
    const gap = { x: from, w: stockX - 10 - from };
    const mid = gap.x + gap.w / 2;
    const floor = H - 6;
    const line: NameAt = { x: gap.x, y: rowY + 2, w: gap.w, h: NAME.h, full: false, align: 'centre' };
    const under = line.y + line.h + 2;
    if (gap.w >= 2 * PILL.min + PILL.gap) {
      const w = Math.min(PILL.stuck, (gap.w - PILL.gap) / 2);
      const ph = clamp(floor - under, PILL.low, 28);
      return { name: line, stuck: { x: mid - PILL.gap / 2 - w, y: under, w, h: ph }, vote: { x: mid + PILL.gap / 2, y: under, w, h: ph }, pills: true, rooms: undefined, countUp };
    }
    const w = Math.min(PILL.stuck, gap.w);
    // One above the other, 4 apart. Under your line while that leaves them high enough to press; else your line goes.
    const high = (top: number) => Math.min(28, (floor - top - (two - 1) * 4) / two);
    const named = high(under) >= PILL.low;
    const ph = Math.max(16, high(named ? under : rowY));
    const top = named ? under : rowY + Math.max(0, (floor - rowY - two * ph - (two - 1) * 4) / 2);
    return { name: named ? line : null, stuck: { x: mid - w / 2, y: top, w, h: ph }, vote: { x: mid - w / 2, y: top + ph + 4, w, h: ph }, pills: true, rooms: undefined, countUp };
  }

  const roomy = at.shape === 'wide';
  const rowR = rowEnd(at, clock);
  const right = Math.min(trayX, at.feedback?.x ?? W, W - keep.r) - 8; // nothing of this goes further right
  const boxR = h.x + 7 * ow + 4 * h.gap + 2 * h.wide + 2 * h.fan;
  const padBase = base + stockDrop(ow); // the bottom of the stock's lowest card
  /** "I'm stuck" and the vote: the first arrangement that fits. */
  const pair = ((): Pick<Furniture, 'stuck' | 'vote' | 'pills'> => {
    if (roomy) {
      const F = PILL.full;
      const y = base + F.drop;
      const w = Math.max(F.min, boxR - stockX);
      if (y + two * F.h + (two - 1) * F.gap <= H - 6 && stockX + w <= right) return { stuck: { x: stockX, y, w, h: F.h }, vote: { x: stockX, y: y + F.h + F.gap, w, h: F.h }, pills: false };
      const each = Math.min(w, (right - stockX - F.gap) / 2);
      if (y + F.h <= H - 6 && each >= F.min) return { stuck: { x: stockX, y, w: each, h: F.h }, vote: { x: stockX + each + F.gap, y, w: each, h: F.h }, pills: false };
      // (Pills one under the other may be a little lower than usual, rather than not fit.)
      const ph = Math.min(PILL.h, (H - 8 - (padBase + 4) - (two - 1) * PILL.gap) / two);
      const top = H - 8 - two * ph - (two - 1) * PILL.gap;
      if (ph >= 28 && stockX + PILL.stuck <= right) return { stuck: { x: stockX, y: top, w: PILL.stuck, h: ph }, vote: { x: stockX, y: top + ph + PILL.gap, w: PILL.stuck, h: ph }, pills: true };
    }
    // Pills in a row, level with the menu's button. "I'm stuck" and, on its right, the vote, both right of your work
    // piles: under your stock, or as far left of that as keeps the vote short of the tray; the two a little narrower
    // than their longest wording rather than under a pile.
    const y = at.knobs.y + (at.knobs.h - PILL.h) / 2;
    const clear = workX + 4 * ow + 3 * h.gap + 6; // right of your fourth work pile
    const narrow = Math.min(1, (right - clear - PILL.gap) / (PILL.stuck + PILL.vote));
    if (PILL.vote * narrow >= PILL.min) {
      const [sw, vw] = [PILL.stuck * narrow, PILL.vote * narrow];
      const x = Math.min(stockX, right - sw - PILL.gap - vw);
      return { stuck: { x, y, w: sw, h: PILL.h }, vote: { x: x + sw + PILL.gap, y, w: vw, h: PILL.h }, pills: true };
    }
    // No room for both there: "I'm stuck" under your stock (or as near as keeps it on the screen) and the vote on its
    // left, under your work piles, which then fan no further down than it.
    const left = rowR + 8;
    const x = Math.max(left, Math.min(stockX, right - PILL.stuck));
    const stuck: Rect = { x, y, w: Math.max(0, Math.min(PILL.stuck, right - x)), h: PILL.h };
    const vw = Math.min(PILL.vote, x - PILL.gap - left);
    if (vw >= PILL.min) return { stuck, vote: { x: x - PILL.gap - vw, y, w: vw, h: PILL.h }, pills: true };
    // Nor for that: the two share what there is between the menu's button and the tray.
    const each = Math.max(0, (right - left - PILL.gap) / 2);
    return { stuck: two === 2 ? { x: right - each, y, w: each, h: PILL.h } : stuck, vote: { x: left, y, w: each, h: PILL.h }, pills: true };
  })();
  const shown = two === 2 ? [pair.stuck, pair.vote] : [pair.stuck];

  const name = ((): NameAt | null => {
    const F = NAME.full;
    // (In full it may stand beside the menu's button, or the clock above that, which may be the wider of the two.)
    const wall = Math.max(rowR, clock && clock.y < at.knobs.y ? clock.x + clock.w : 0);
    const wide = Math.min(F.w, nertzR - (wall + 4));
    if (roomy && wide >= F.min) {
      // As low under the pile as it has always stood, while it fits; in a lower window nearer to it.
      // (Below the count on the pile, which reaches down past the card's corner.)
      const below = (0.5 + COUNT_OUT) * countD(ow) + 4;
      const y = base + Math.max(below, base + F.drop + NAME.h <= H - 4 ? F.drop : 8);
      if (y + NAME.h <= H - 4) return { x: nertzR - wide, y, w: wide, h: NAME.h, full: true, align: 'end' };
    }
    const y = at.knobs.y + (at.knobs.h - NAME.h) / 2;
    const w = clamp(fit.name, NAME.min, NAME.max);
    const left = rowR + 10;
    // Tucked under the pile and its count, from the pile's left edge: moved left only as far as keeps it short of your
    // first work pile (which fans down there).
    const tuck: NameAt = { x: Math.max(left, Math.min(nertzX, workX - 6 - w)), y: Math.max(base, badge.y + badge.h) + 4, w, h: NAME.h, full: false, align: 'start' };
    if (tuck.y + tuck.h <= H - 4 && tuck.x + w <= workX - 6 && ![at.knobs, ...(clock ? [clock] : []), ...shown, badge].some((p) => meets(tuck, p, 4))) return tuck;
    // The line moves out of the way rather than grow shorter than what it says: it stops 8 short of the first thing in
    // its row right of the button (the count on the nertz pile, which hangs below the pile's corner, or a pill).
    const row: Rect = { x: left, y, w: right - left, h: NAME.h };
    const stop = Math.min(right, ...[...shown, badge].filter((p) => p.x > left && meets(row, p, 8)).map((p) => p.x - 8));
    const end = Math.min(nertzR, stop);
    const line: NameAt = end - w >= left ? { x: end - w, y, w, h: NAME.h, full: false, align: 'end' } : { x: left, y, w: Math.min(w, stop - left), h: NAME.h, full: false, align: 'start' };
    return line.w >= NAME.min && ![...shown, badge].some((p) => meets(line, p, 4)) ? line : null;
  })();

  const things = [at.knobs, ...(clock ? [clock] : []), ...(name ? [name] : []), ...shown].filter((r) => r.y + r.h > base);
  /** The top of the first thing under the cards between `x0` and `x1` (4 clear of it). */
  const floor = (x0: number, x1: number): number => Math.min(H - 8, ...things.filter((r) => r.x < x1 + 4 && r.x + r.w > x0 - 4).map((r) => r.y - 4));
  const rooms = [0, 1, 2, 3].map((i) => Math.max(0, floor(workX + i * (ow + h.gap), workX + i * (ow + h.gap) + ow) - base));
  return { name, ...pair, rooms, countUp };
}

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
export function computeLayout(W: number, fullH: number, game: GameState, you: number, stage: Stage = 'live', peek: number | null = null, keep: Insets = NO_INSETS, sitting: readonly number[] = [], fit: Fittings = NO_FITTINGS, hands: PlayerState[] = game.players): Layout {
  const H = fullH - keep.b; // the strip at the bottom that the screen keeps is simply not used
  const cards: Placed[] = [];
  const n = game.players.length; // (the felt and its cards are sized for those in the round)
  // The round's hands that are at the table (`hands`: all of them, but on the score sheet, see stage.ts `handsAt`) each
  // have a place round it. While the round is played, whoever sits at the table without one of them (`sitting`: they
  // came in the middle of the round, or were away at the deal) has a place all the same, in seat order with the rest: a
  // hand with no cards in it. Once it is over nobody does: whoever is not of the round (the queue sits down as it ends,
  // anyone may at the score sheet) has a place once the next deal puts them in it. (A newcomer who is you watches until
  // then, as anyone does who has no place.)
  const empty = stage === 'live' ? sitting.filter((seat) => !hands.some((p) => p.seat === seat)) : [];
  const ring: PlayerState[] = empty.length
    ? [...hands, ...empty.map((seat): PlayerState => ({ seat, nertz: [], work: Array.from({ length: WORK_PILES }, () => ({ cards: [], down: 0 })), stock: [], waste: [], draw: null, stuck: false, holding: null }))].sort((a, b) => a.seat - b.seat)
    : hands;
  const mine = ring.find((p) => p.seat === you);
  const open: Open = { work: game.status.at !== 'dealing', nertz: hasOpened(game) };
  // Someone who has no seat at the table at all watches from the first player's chair.
  const view = Math.max(0, ring.indexOf(mine!));
  // Opponents in seat order starting after you: clockwise round the table, from your left.
  const others = mine ? [...ring.slice(view + 1), ...ring.slice(0, view)] : ring;
  const shape = shapeOf(W, H);
  const tall = shape === 'tall';
  const low = shape === 'low';
  const edge = tall ? TALL.edge : 16;

  // Your hand: bottom, as large as the window allows. (Upright: in two rows, see TALL.)
  const ow = mine ? ownWidth(W, H, tall) : 0;
  const oh = ow * RATIO;
  /** Upright: the second row, where the nertz pile, the stock and the waste lie. */
  const rowY = H - 10 - oh;
  // Room below the row for work piles to fan into is kept short: a long pile squeezes, or rises into the cloth above.
  // (Watching without a seat: where the table ends, above the line that says so.)
  const ownTop = !mine ? H - 12 - WATCH.h : tall ? rowY - oh * (TALL.between + TALL.room + 1) : H - 12 - oh * 1.85;
  const handX = tall ? edge : (W - OWN_UNITS * ow) / 2;

  // Everyone else, by the side of the felt they sit at (`seating`) and the direction their seat lies in as seen from
  // yours: (0, 1) is straight down, towards you. (Whoever watches without a seat does so from behind the first player,
  // whose hand is then at the bottom; on a phone it is in the rows or the columns with the rest.)
  const behind = mine || tall || low ? 0 : Math.min(1, others.length);
  const round = seating(others.length - behind, W, H);
  // More than one at a side: they stand upright in a column, and those across the top are spread evenly between the
  // two columns. Otherwise each is where their chair stands, and the one at a side lies turned to face the felt.
  const cols = low || round.left > 1;
  const seats = others.map((p, i) => {
    const dir = seatDir((ring.indexOf(p) - view + ring.length) % ring.length, ring.length);
    const nth = i - behind; // which of those round the three sides, clockwise
    const where = nth < 0 ? ('bottom' as const) : nth < round.left ? ('left' as const) : nth < round.left + round.top ? ('top' as const) : ('right' as const);
    // (How far across the top one of the row is, in the row's own measure: -1 is its left end and 1 its right.)
    const x = where !== 'top' ? 0 : cols ? (2 * (nth - round.left) + 1) / round.top - 1 : dir.x;
    return { p, dir, nth, where, x };
  });
  const size = cardSize(n);
  const hw = feltHw(n);
  // Upright, the felt runs the width of the screen, and how high that makes it is known before anything else is placed.
  const feltRoom = W - 2 * (tall ? 6 : edge);
  // Upright: the hands of the others in rows under the bar. As few to a row as leaves the cards largest in the room
  // there is above the felt (one opponent to a row is twice the size of two, while the rows fit).
  const grid = { cols: 1, w: -Infinity }; // (however small the cards come out, the most to a row that leaves them largest)
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
  const col = { u: 0, w: 0, topL: LOW.top, botL: H - LOW.knobs, topR: 6, botR: ownTop - 6 };
  /** Where the tray begins, when the middle's cards are `fh` high: beside your hand; watching, as high as its piles need. */
  const trayTopAt = (fh: number) => (mine ? ownTop : H - 12 - fh * 2.6);
  // Where a column that stops above your hand ends: above the count on your nertz pile too, which may stand at the
  // pile's top corner.
  const ends = Math.min(H - LOW.knobs, col.botR - (mine ? (0.5 + COUNT_OUT) * countD(ow) + 2 : 0));
  /** How wide the cards of `k` hands sharing `room` of a column's height may be. */
  const each = (room: number, k: number) => (k ? (room / k - TAG_H - 6) / (RATIO * 1.85) : Infinity);
  if (low) {
    const most = W - sideL - sideR - 2 * (LOW.col + CLEAR);
    col.u = Math.max(40, Math.min(most / (2 * hw), (ownTop - CLEAR - 4 - 6) / 2, (mine ? ow * CENTRE_MAX : 90) / size.w));
    col.botR = Math.min(col.botR, trayTopAt(size.w * col.u * RATIO) - 6); // (the right one stops above the tray)
    const wide = (W - 2 * hw * col.u) / 2 - CLEAR - Math.max(sideL, sideR);
    const width = (botL: number) => Math.min(wide / OPP_UNITS, each(botL - col.topL, round.left), each(col.botR - col.topR, round.right), mine ? ow * 0.62 : OPP_MAX);
    // The left column runs down to the menu's button only beside your hand, clear of it (a phone's hand is narrow and
    // leaves it the room); otherwise it stops above your hand, as the right one does. Whichever has its hands larger as
    // they are drawn, which is never smaller than OPP_LEAST: where neither has the room for hands that small, the longer
    // column, whose hands then lie over each other the less.
    const byHand = handX - CLEAR - sideL; // the width beside your hand
    const drawn = (w: number) => clamp(w, OPP_LEAST, OPP_MAX);
    const beside = drawn(Math.min(width(H - LOW.knobs), byHand / OPP_UNITS));
    const above = drawn(width(ends));
    if (beside >= above && beside <= byHand / OPP_UNITS) col.w = beside;
    else Object.assign(col, { w: above, botL: ends });
  } else if (cols) Object.assign(col, { topL: U.top, topR: U.top, botL: ends, botR: ends }); // a U: both stop above your hand
  const tops = seats.filter((s) => s.where === 'top');
  const sides = !cols && round.left > 0; // a hand at each side, turned
  const mw = tall
    ? clamp(grid.w, OPP_LEAST, OPP_MAX)
    : low
      ? col.w // (as drawn already: see `beside` and `above`)
      : clamp(
    Math.min(
      H * OPP_SIZE[Math.min(5, others.length)]!,
      mine ? ow * 0.62 : OPP_MAX,
      (W - 2 * CORNER - (tops.length - 1) * 18) / (Math.max(1, tops.length) * OPP_UNITS), // the top row fits between the corners
      sides ? (W * 0.16 - edge) / (1.85 * RATIO) : OPP_MAX, // two side hands, turned, leave most of the width to the felt
      sides ? (H * 0.62) / OPP_UNITS : OPP_MAX, // and run down no more than most of its height
      // A U: a column's hands are no wider than its share of the window, the row fits between the two columns, and
      // each column holds its hands above your own.
      cols ? Math.min(W * U.share, (W - sideL - sideR - (tops.length + 1) * 18) / (tops.length + 2)) / OPP_UNITS : OPP_MAX,
      cols ? Math.min(each(col.botL - col.topL, round.left), each(col.botR - col.topR, round.right)) : OPP_MAX,
    ),
    cols ? OPP_LEAST : 16,
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
  const bandBottom = (!mine && seats.some((s) => s.where === 'bottom') ? ownTop - handH - TAG_H : ownTop) - CLEAR - 4;
  const cy = (bandTop + bandBottom) / 2;
  // The top row is spread out when there is room (three across the top sit shoulder to shoulder), and stays out of the corners.
  const xs = tops.map((s) => s.x).sort((a, b) => a - b);
  const closest = Math.min(Infinity, ...xs.slice(1).map((x, i) => x - xs[i]!));
  const widest = Math.max(0.001, ...xs.map(Math.abs));
  // (In a U the row has what is between the two columns, and the corners, from end to end.)
  const between = W / 2 - Math.max(CORNER, Math.max(sideL, sideR) + handW + 18);
  const spread = Math.max(Number.isFinite(closest) ? (handW + 18) / closest : 0, cols ? between : Math.min(W * 0.3, (W / 2 - CORNER - handW / 2) / widest));

  // The felt: centred in the band, as large as fits in it and between the hands at the sides, but no larger than
  // makes its cards the size of your own.
  const room = tall ? feltRoom : W - 2 * (cols ? Math.max(sideL, sideR) + handW + CLEAR : sides ? edge + handH + CLEAR : edge);
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
  // (Watching, with no hand: at the foot of the right edge all the same, and the hands at the right stop above it.)
  const tw = Math.max(fw, ow * 0.6);
  const th = tw * RATIO;
  const pad = tw * TRAY_PAD;
  const gapT = ow * TALL.gap;
  const trayIn = tall ? clamp(W - (handX + 4 * ow + 3 * gapT) - 8, tw * 0.3, tw * TRAY_IN) : clamp(W - (handX + OWN_UNITS * ow) - 18, tw * 0.3, tw * TRAY_IN);
  const trayTop = trayTopAt(fh);
  const at = corners(W, fullH, keep, fit);
  // (Upright: beside the work piles, and no lower: the stock and the waste are under it. Otherwise down to the
  // bottom, or to the way to feedback where that stands under it.)
  const tray: Rect = { x: W - trayIn, y: trayTop, w: 2 * trayIn, h: (tall && mine ? rowY - 8 : at.feedback ? at.feedback.y - 8 : H - 10) - trayTop };
  const trayH = tray.h;
  // Dropping a finished pile is not a precision job: anywhere from a little short of the tray to past the edge of the screen.
  const trayHit: Rect = { x: tray.x - fw * 0.9, y: tray.y - fh * 0.4, w: fw * 0.9 + tray.w + W, h: tray.h + fh * 0.4 + H };
  const trays = game.tray.length;
  const trayStep = trays > 1 ? Math.min(th * 0.36, (trayH - 2 * pad - th) / (trays - 1)) : 0;
  // End of round: the tray piles walk out to a row across the middle of the table.
  const outStep = trays > 1 ? Math.min(fw * 1.15, (middle.w * 0.8 - fw) / (trays - 1)) : 0;
  const out = game.tray.map((_, k): Rect => ({ x: W / 2 - (outStep * (trays - 1) + fw) / 2 + k * outStep, y: middle.y + (middle.h - fh) / 2, w: fw, h: fh }));

  const span = OPP_UNITS * mw; // a side hand, turned, runs this far down the window
  const opponents = seats.map(({ p, dir, nth, where, x }, i) => {
    const spec: HandSpec = {
      x: 0,
      y: 0,
      w: mw,
      gap: mw * OPP.gap,
      wide: mw * OPP.wide,
      fan: 0,
      workFan: mh * 0.4,
      workRoom: mh * 0.85,
      workRise: [],
      minStrip: 0,
      z: 1000 + i * 200,
      mine: false,
      // Across the table a hand is seen from the other side: its owner's left is your right.
      flip: where === 'top',
      open,
    };
    if (sides && (where === 'left' || where === 'right')) {
      // A neighbour sits beside the felt, their hand turned to face it: level with its middle if they are straight to
      // one side, lower down the nearer they are to you. Clear of the chat button above and your hand below (and on
      // the right, of the tray).
      const y = clamp(cy + dir.y * (bandBottom - bandTop) * 0.8 - span / 2, Math.max(bandTop, 48) + TAG_H, (where === 'right' ? Math.min(ownTop, tray.y) : ownTop) - 8 - span);
      const local: Placed[] = [];
      const seat = placeHand(p, spec, local);
      const turned = turnHand(seat, local, where === 'left' ? 90 : -90, where === 'left' ? edge : W - edge - handH, y);
      cards.push(...local);
      return turned;
    }
    if (where === 'left' || where === 'right') {
      // Clockwise from your left: up the left column, then down the right one. Each has an equal share of its column.
      const left = where === 'left';
      const count = left ? round.left : round.right;
      const k = left ? round.left - 1 - nth : nth - round.left - round.top; // from the top
      const [top, bottom] = left ? [col.topL, col.botL] : [col.topR, Math.min(col.botR, tray.y - 6)]; // (the right one above the tray too)
      // (More of them than the column holds at the smallest cards: they lie over each other a little, and stay in it.)
      const share = (bottom - top) / count;
      const tight = share < TAG_H + handH && count > 1;
      const y = tight ? top + TAG_H + (k * (bottom - top - TAG_H - handH)) / (count - 1) : top + k * share + TAG_H + Math.max(0, (share - TAG_H - handH) / 2);
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
    return placeHand(p, { ...spec, x: W / 2 + (where === 'top' ? x * spread : 0) - handW / 2, y: where === 'top' ? topY : ownTop - handH }, cards);
  });

  // Your hand is placed last: a long work pile may rise into what cloth there is between the row and the felt.
  const own: HandSpec = {
    x: handX,
    y: ownTop,
    w: ow,
    gap: tall ? gapT : ow * OWN.gap,
    wide: ow * OWN.wide,
    fan: ow * (ow < MINI_BELOW ? 0.55 : OWN.fan),
    workFan: oh * 0.3,
    workRoom: tall ? oh * TALL.room : H - 8 - ownTop - oh,
    rows: tall ? { y: rowY, nertzX: edge, stockX: W - edge - 2 * ow - gapT, box: { x: edge, y: ownTop, w: W - 2 * edge, h: H - 10 - ownTop } } : undefined,
    workRise: [],
    minStrip: oh * 0.21,
    z: OWN_Z,
    mine: true,
    open,
    peek,
  };
  // A pile rises as far as the cloth over it is clear: up to the felt, or to the bottom of a hand above it (a column
  // of hands that stops above yours). (Not once the wash begins: the labels of the sorted piles are placed clear of
  // the hand's box.)
  const { workX } = pilesOf(own);
  own.workRise = [0, 1, 2, 3].map((i) => {
    const x = workX + i * (ow + own.gap);
    const over = opponents.filter((o) => o.box.x < x + ow && x < o.box.x + o.box.w).map((o) => o.box.y + o.box.h);
    return onCanvas(stage, 'tray') ? 0 : Math.max(0, ownTop - 6 - Math.max(cy + u, ...over));
  });
  // What stands by it is placed first, and the work piles fan down as far as that leaves them room.
  // The clock stands in the first of its places where nothing of the table is (the felt, someone's hand and name, your
  // own cards), and that leaves your line and the pills as whole as they are without it: it gives way, not they.
  const taken = [...opponents.map((o) => ({ x: o.box.x, y: o.box.y - TAG_H, w: o.box.w, h: o.box.h + TAG_H })), ...(mine ? [{ x: handX, y: ownTop - 6, w: OWN_UNITS * ow, h: H - ownTop + 6 }] : [])];
  const furnished = (c: ClockAt | null) => (mine ? furnish(W, H, keep, at, c, fit, own, tray.x) : null);
  const bare = furnished(null);
  const need = clamp(fit.name, NAME.min, NAME.max);
  const whole = (f: Furniture | null): boolean => {
    if (!f || !bare) return true;
    const [n, b] = [f.name, bare.name];
    const named = !b || (!!n && n.full === b.full && Math.min(n.w, need) >= Math.min(b.w, need));
    return named && f.stuck.w >= bare.stuck.w && (!fit.vote || f.vote.w >= bare.vote.w);
  };
  const free = at.clocks.filter((c) => !taken.some((r) => meets(r, c, 4)) && !onFelt(felt, hw, c));
  const placed = free.map((c) => ({ c, f: furnished(c) })).find(({ f }) => whole(f));
  const clock = placed?.c ?? null;
  const by = placed ? placed.f : bare;
  const me = mine ? placeHand(mine, { ...own, rooms: by?.rooms, countUp: by?.countUp }, cards) : null;

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
        pile.cards.slice(-2).forEach((card, k) => cards.push({ card, x: r.x, y: r.y, s: r.w / CARD_W, z: 5000 + i * 4 + k, face: 'up', pile: 'slot', mine: false, at: i, rot: r.rot }));
        return;
      }
      pile.cards.forEach((card, j) => {
        const o = slotStack(i, j, r.w);
        cards.push({ card, x: r.x + o.x, y: r.y + o.y, s: r.w / CARD_W, z: 5000 + i * 14 + j, face: 'down', pile: 'slot', mine: false, at: i, rot: r.rot + o.rot });
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
        cards.push({ card, x: r.x + o.x, y: r.y + o.y, s: r.w / CARD_W, z: (stage === 'out' ? 20100 : 5200) + k * 20 + j, face: 'down', pile: 'tray', mine: false, at: k, rot: o.rot });
      });
    });
  }

  // Piles are at least 0.14 of a card apart in every direction (shared/table.ts), so a margin of 0.05 keeps drop areas from touching.
  const cleared = shape !== 'wide' && sorting(stage);
  return { cards, me, opponents, felt, slots, slotHit: slots.map((r) => r && grow(r, fw * 0.05)), tray, trayHit, out, middle, window: { w: W, h: H }, fs, shape, bar: tall ? TALL.bar : 0, cols, cleared, keep, at, clock, name: by?.name ?? null, stuck: by?.stuck ?? null, vote: by?.vote ?? null, pills: by?.pills ?? false };
}

/** Is any point of `r` on the felt as drawn (its corners are round)? */
function onFelt(f: Felt, hw: number, r: Rect): boolean {
  const [a, b] = [toTable(f, r.x, r.y), toTable(f, r.x + r.w, r.y + r.h)];
  const apart = (lo: number, hi: number, half: number) => Math.max(0, lo - half, -half - hi);
  return Math.hypot(apart(a.x, b.x, hw - TABLE.corner), apart(a.y, b.y, 1 - TABLE.corner)) < TABLE.corner;
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

/** The way from `p` (on screen, off the felt) to the nearest point of the felt's edge. */
function nearestEdge(felt: Felt, n: number, p: Pt): Pt {
  const t = toTable(felt, p.x, p.y);
  const [ix, iy] = [feltHw(n) - TABLE.corner, 1 - TABLE.corner];
  const c = { x: clamp(t.x, -ix, ix), y: clamp(t.y, -iy, iy) };
  const d = { x: t.x - c.x, y: t.y - c.y };
  const len = Math.hypot(d.x, d.y) || 1;
  const q = { x: c.x + (d.x / len) * TABLE.corner, y: c.y + (d.y / len) * TABLE.corner };
  return { x: (q.x - t.x) * felt.u, y: (q.y - t.y) * felt.u };
}

/** What a window is told of a card another player is carrying (protocol.ts `DragAt`): how far along its path, and where it is. */
type Report = { h: readonly [number, number]; p: readonly [number, number]; w: number };

/** Another player's card in the air as this window draws it: its middle on screen, its scale, and its tilt in degrees. */
export interface Aloft {
  x: number;
  y: number;
  s: number;
  rot: number;
}

/**
 * How another player's carried card is drawn this frame: the cards `ids` (the one reported first, a run under it),
 * whose place in their hand as drawn here is `home`, by their latest report `at`; `linger` (0 to 1) is how far it has
 * come over to where it really is while it lingers over the felt. It goes along its path (`aloftPath`) to the pile it
 * is heading for (`pileFor`). It grows from its size in their hand to the middle's (`fs`) as it goes out, half way by
 * the felt's edge, or as it lingers, whichever is further: this window cannot know its owner's screen, so not by how
 * your own grows (hand.ts `feltScale`). And it turns upright for whoever is watching as it leaves the hand (a
 * neighbour's hand is turned to face the felt).
 */
export function aloftAt(L: Pick<Layout, 'felt' | 'fs' | 'slots' | 'opponents'>, game: GameState, carried: { seat: number; ids: readonly string[]; home: Placed; at: Report; linger: number }): Aloft {
  const { seat, ids, home, at, linger } = carried;
  const hw = home.s * CARD_W;
  const middle = { x: home.x + hw / 2, y: home.y + (home.s * CARD_H) / 2 };
  const pile = ids.length === 1 ? pileFor(L, game, seat, ids[0]!, at) : undefined;
  const c = aloftPath(L.felt, game.players.length, { home: middle, hw, hand: L.opponents.find((o) => o.seat === seat), at, pile, linger });
  return { ...c, s: home.s + (L.fs - home.s) * Math.max(at.w / 2, linger), rot: home.rot * (1 - clamp(Math.max(at.h[1] / 0.6, at.w * 4, linger), 0, 1)) };
}

/**
 * The pile in the middle another player's card `id` is heading for, on this screen (its middle): of those that would
 * take it, the nearest to where it is. None until it is past the felt's edge (`at.w` over 1), nor if none would.
 */
export function pileFor(L: Pick<Layout, 'felt' | 'slots'>, game: GameState, seat: number, id: string, at: Report): Pt | undefined {
  if (at.w <= 1) return undefined;
  const there = toScreen(L.felt, { x: at.p[0], y: at.p[1] });
  const off = (q: Pt) => Math.hypot(q.x - there.x, q.y - there.y);
  let pile: Pt | undefined;
  L.slots.forEach((r, i) => {
    if (!r || !canDrop(game, seat, id, { k: 'slot', i })) return;
    const q = { x: r.x + r.w / 2, y: r.y + r.h / 2 };
    if (!pile || off(q) < off(pile)) pile = q;
  });
  return pile;
}

/**
 * The path of a card that another player is carrying: where its middle is drawn in this
 * window. The felt is the same on every screen and the hands are not: its
 * owner carries the card up from the bottom of their screen, and here it has
 * to come from wherever this window seats them. So it is not simply drawn
 * where it is: it is drawn on one path, as far along it as its owner says
 * (`at.w`). From 0 to 1 it goes out about its owner's hand, in cards of their
 * hand as drawn here (`hw` wide, the card's home at `home`): as far along the
 * row as they have it (`at.h[0]`), and that share of the way out from the hand
 * to the felt's edge (never less than its hop within the hand, `at.h[1]`). Its
 * sideways place gives way as it goes, and is gone at the edge: which way is
 * sideways on its owner's screen says nothing about where on the felt it is
 * going from here. From 1 to 2 it goes straight on from the felt's edge to the
 * pile it is going to (`pile`: the middle of that pile on this screen; where
 * it really is, if there is none). And any card comes over to where it really
 * is (`at.p`, its point of the felt) as it lingers over the felt (`linger`, 0
 * to 1).
 */
export function aloftPath(
  felt: Felt,
  n: number,
  { home, hw, hand, at, pile, linger }: { home: Pt; hw: number; hand: Pick<Seat, 'box' | 'flip' | 'turn'> | undefined; at: Report; pile: Pt | undefined; linger: number },
): Pt {
  const there = toScreen(felt, { x: at.p[0], y: at.p[1] });
  // "Towards the middle" is up the screen for whoever is dragging; for their hand as drawn here it is wherever the felt lies.
  // (Straight at the nearest point of the felt's edge from its place in the hand.)
  const to = hand ? nearestEdge(felt, n, home) : { x: 0, y: -1 };
  const len = Math.hypot(to.x, to.y) || 1;
  const f = Math.min(at.w, 1);
  // Which way the row runs here: across, the other way round for a hand across the table, down or up for a turned one.
  const row = hand?.turn === 90 ? { x: 0, y: 1 } : hand?.turn === -90 ? { x: 0, y: -1 } : { x: hand?.flip ? -1 : 1, y: 0 };
  // Its sideways place counts for less the nearer the felt it is.
  const along = at.h[0] * (1 - f) * (1 - f);
  // Out towards the felt: pulled back away from it, as far the other way.
  const lift = Math.min(at.h[1], LIFT);
  const out = f > 0 ? Math.max(lift, (f * offFelt(toTable(felt, home.x, home.y), n) * felt.u) / hw) : lift;
  let x = home.x + (along * row.x + (out * to.x) / len) * hw;
  let y = home.y + (along * row.y + (out * to.y) / len) * hw;
  // On from the felt's edge.
  const end = pile ?? there;
  [x, y] = [x + (end.x - x) * (at.w - f), y + (end.y - y) * (at.w - f)];
  return { x: x + (there.x - x) * linger, y: y + (there.y - y) * linger };
}

// ---------------------------------------------------------------- the deal

/**
 * The deal at the start of a round. After `lead` ms the work piles are dealt
 * off each deck, spread evenly over `work` ms however many there are (a table
 * without face-downs deals fewer, each at a slower step); then, after a `pause`, the nertz pile
 * is counted off as one quick ribbon (a card every `stream` ms). Each card
 * takes `duration` s to land, and the last is down a beat before the server's
 * DEAL_MS is up and the face-up cards turn over.
 */
/** How long a card takes to glide to its place (`move`) and to turn over (`flip`), in s; reduced motion has none (client/Table.tsx). */
export const MOTION = { move: 0.15, flip: 0.16 } as const;

export const DEAL = { lead: 100, work: 1300, pause: 180, stream: 50, duration: 0.38, ease: [0.2, 0.8, 0.2, 1] } as const;

/**
 * How long until the `i`th card to leave a deck does so (the `work` work-pile
 * cards first, then the nertz pile), in a window that was told `dealMs` of the
 * deal remain. Null if it has left already (a window that arrived late): that
 * card is simply in its place.
 */
export function dealWait(i: number, dealMs: number, work = 10): number | null {
  const at = i < work ? (i * DEAL.work) / work : DEAL.work + DEAL.pause + (i - work) * DEAL.stream;
  const wait = DEAL.lead + at - (DEAL_MS - dealMs);
  return wait >= 0 ? wait : null;
}

/** When each card of a full deal lands and flicks (work-pile cards first, then the nertz pile), in seconds from now. */
export function dealTimes(work = 10, nertz = 13): number[] {
  return Array.from({ length: work + nertz }, (_, i) => ((dealWait(i, DEAL_MS, work) ?? 0) + DEAL.duration * 700) / 1000);
}
