// The hand: the card (with any run on top of it) or the finished pile a player has hold of, and what each thing they
// do with a pointer does to it. Pure: `decide` is given the hand, the gesture, and the table as it is laid out and
// played, and says what the hand is next and what is to be done about it. Table.tsx listens to the pointer and carries
// that out (it sends the intents and moves the card elements); it decides nothing.
//
// Placement is exact. A card lands only if it is put down on one specific pile (the one under the pointer, else the
// one under the card's centre) and fits there; nothing is rerouted.
import { canDrop, grab } from '../shared/engine';
import { DRAG_HZ, type DragAt } from '../shared/protocol';
import { cardSize, offFelt, type Pt } from '../shared/table';
import type { GameState, Intent, PileRef } from '../shared/types';
import { CARD_H, CARD_W } from './cards/Face';
import { dropTarget, landingAt, toTable, type Layout, type Placed, type Rect } from './layout';

const DRAG_SLOP = 6; // px of travel before a press becomes a carry
/** A card under a finger rises clear of it over this much travel, and ends this far above the fingertip. */
const TOUCH_RISE_PX = 44;
const TOUCH_CLEAR_PX = 10;
/** On a phone a card carried over the felt is drawn this wide (px): bigger than the piles there, easier to aim with a finger. */
const TOUCH_CARD_PX = 48;
/** A card carried out of your hand comes to its size over the felt (`feltScale`) over the last few px before it. */
const SHRINK_PX = 14;
/** A card taken up by a tap stands this much of its height above where it lay. */
const STAND = 0.16;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const round3 = (v: number) => Math.round(v * 1000) / 1000;

// ---------------------------------------------------------------- the hand

/**
 * What is in hand: one of your cards (with any run on top of it), or a finished centre pile on its way to the tray.
 * `ace`: it is an Ace, which may start a pile wherever there is room.
 */
export type Held = { k: 'card'; id: string; ace: boolean } | { k: 'pile'; slot: number };

/** What was taken hold of and how: the same from the press until it is put down. */
interface Grip {
  held: Held;
  /** The elements that move, and the one that was grabbed. */
  ids: string[];
  lead: string;
  /** Where the pointer went down, and where each of the cards lay then. */
  sx: number;
  sy: number;
  base: Pt[];
  /** The scale the grabbed card lay at: what is in hand is drawn about it at `s / home` of how it lay. */
  home: number;
  /** A finger, not a mouse: the card is carried above it, where it can be seen, and is aimed by its own middle. */
  touch: boolean;
  /** The card on top of every pile in the middle when this one was picked up (its id; none for an empty place): what has been played since is what there was a race for. */
  tops: (string | undefined)[];
}
/** Where the grabbed card is drawn while it is in hand (its corner), and at what scale. */
interface Drawn {
  at: Pt;
  s: number;
}

/**
 * The hand, from the press to the putting down. `pressed`: the pointer is down on it and has not moved; it still lies
 * in its pile. `carried`: it goes where the pointer goes. `tapped`: it was tapped (or clicked) and stands lifted where
 * it was, in your hand all the same, until the next tap says where it goes; no pointer has it.
 */
export type Hand =
  | (Grip & { phase: 'pressed'; pointer: number })
  | (Grip & Drawn & { phase: 'carried'; pointer: number; px: number; py: number })
  | (Grip & Drawn & { phase: 'tapped' });
type Pressed = Extract<Hand, { phase: 'pressed' }>;
type Carried = Extract<Hand, { phase: 'carried' }>;
export type InHand = Exclude<Hand, Pressed>;

/** Between one gesture and the next: the hand, and whether the tap that is down has had its say (it put down what stood tapped: lifting the finger does nothing more). */
export interface Grasp {
  hand: Hand | null;
  spent: boolean;
}
export const EMPTY: Grasp = { hand: null, spent: false };

/** The table as the player has it before them at the moment of a gesture. */
export interface Scene {
  game: GameState;
  you: number;
  L: Layout;
  /** Every card of the layout, by id. */
  byId: ReadonlyMap<string, Placed>;
  /** The round is on the table as it is played (not the end of a round). */
  live: boolean;
  /** The end of a round is playing out: no press is answered. */
  playingOut: boolean;
  /** Nothing can be started. (A card already in hand may still land.) */
  frozen: boolean;
  /** The table rule for moving a card without dragging it: tap (or click) it, then where it goes. */
  tapToMove: boolean;
  /** The slot of your finished pile that is waiting to be carried to the tray, or -1 (clearFirst.tsx `waitingPile`). */
  waiting: number;
  /** Would the window play this intent right now? Asked of the game as it is, not as it was last drawn (client/net.ts `playable`). */
  plays(intent: Intent): boolean;
}

/** What the browser reports. `on`: the card of the table the pointer went down on, or the stock's place, or neither. */
export type Gesture =
  | { k: 'down'; pointer: number; x: number; y: number; touch: boolean; main: boolean; on: { card: string } | 'stock' | null }
  | { k: 'move'; pointer: number; x: number; y: number }
  | { k: 'up'; pointer: number; x: number; y: number; touch: boolean }
  | { k: 'cancel'; pointer: number }
  | { k: 'escape' }
  /** Not the player's doing: the table changed under the hand (a snapshot came). */
  | { k: 'table' };

/** What is to be done about a gesture, in order. */
export type Effect =
  | { k: 'send'; intent: Intent }
  /** One card put back, wherever it was let go: the server says whether it was sniped while in hand (`seen`: the piles' tops when it was taken up). */
  | { k: 'tried'; card: string; seen: (string | null)[] }
  /** A group off the stock (or the waste turned back over). */
  | { k: 'deal' }
  /** Clear-first: something other than the waiting pile was tried. */
  | { k: 'nag' }
  /** A tap on a touch screen that took nothing up: the work pile under it fans out in full, or the one that is closes. */
  | { k: 'fan'; x: number; y: number };

export interface Step extends Grasp {
  effects: Effect[];
}

// ---------------------------------------------------------------- where it is, and what it is over

const gripOf = ({ held, ids, lead, sx, sy, base, home, touch, tops }: Grip): Grip => ({ held, ids, lead, sx, sy, base, home, touch, tops });
const leadBase = (d: Grip): Pt => d.base[d.ids.indexOf(d.lead)]!;
/** The middle of the grabbed card, where it is drawn. */
const centreOf = (d: InHand): Pt => ({ x: d.at.x + (d.s * CARD_W) / 2, y: d.at.y + (d.s * CARD_H) / 2 });
/** Where card `i` of what is in hand is drawn (its corner): the grabbed one where the hand has it, the others as they lay about it, at its scale. */
export const drawnAt = (d: InHand, i: number): Pt => {
  const k = d.s / d.home;
  return { x: d.at.x + (d.base[i]!.x - leadBase(d).x) * k, y: d.at.y + (d.base[i]!.y - leadBase(d).y) * k };
};

/**
 * The scale what is in hand is drawn at over the felt. An Ace, which may start a pile wherever there is room: the
 * size of a pile in the middle, exactly what would lie there. Any other card on a phone: TOUCH_CARD_PX. Otherwise as
 * it lay.
 */
const feltScale = (held: Held, home: number, L: Layout): number =>
  held.k === 'card' && held.ace ? L.fs : held.k === 'card' && L.shape !== 'wide' ? TOUCH_CARD_PX / CARD_W : home;

/** The hand with the pointer at `p`: the card goes with it. */
function carry(d: Pressed | Carried, p: Pt, { L, game }: Scene): Carried {
  const { home } = d;
  const b = leadBase(d);
  // Under a finger the card comes up as it is carried off, until its lower edge is just above the fingertip: you
  // see the whole of it and what it is over. (Not a pile on its way to the tray: that is not a precision job.)
  const grip = d.sy - d.base[0]!.y; // how far down the grabbed card it was taken
  const up = d.touch && d.held.k === 'card' ? clamp(Math.hypot(p.x - d.sx, p.y - d.sy) / TOUCH_RISE_PX, 0, 1) : 0;
  const at = { x: p.x - (d.sx - b.x), y: p.y - up * Math.max(0, home * CARD_H + TOUCH_CLEAR_PX - grip) - (d.sy - b.y) };
  // It is drawn as it lay while it is over your hand, and comes to its size over the felt as it reaches it. It changes
  // size about the point it is aimed by (the pointer, or under a finger its own middle), which stays where it is.
  const aim = d.touch ? { x: at.x + (home * CARD_W) / 2, y: at.y + (home * CARD_H) / 2 } : p;
  const near = clamp(1 - (offFelt(toTable(L.felt, aim.x, aim.y), game.players.length) * L.felt.u) / SHRINK_PX, 0, 1);
  const k = 1 + (feltScale(d.held, home, L) / home - 1) * near;
  return { ...gripOf(d), phase: 'carried', pointer: d.pointer, px: p.x, py: p.y, at: { x: aim.x + (at.x - aim.x) * k, y: aim.y + (at.y - aim.y) * k }, s: home * k };
}

/** Somewhere the card in hand may be put down. `hit` is where it has to be let go. */
interface Target {
  to: PileRef;
  rect: Rect;
  hit: Rect;
}
/** Exactly the piles that would take the card in hand right now. */
function pilesFor(id: string, { game, you, L }: Scene): Target[] {
  const out: Target[] = [];
  L.me?.work.forEach((rect, i) => {
    if (canDrop(game, you, id, { k: 'work', i })) out.push({ to: { k: 'work', i }, rect, hit: L.me!.workHit[i]! });
  });
  L.slots.forEach((rect, i) => {
    if (rect && canDrop(game, you, id, { k: 'slot', i })) out.push({ to: { k: 'slot', i }, rect, hit: L.slotHit[i]! });
  });
  return out;
}

/** Where the hand points to put down: the pointer, and the middle of the card it carried there (none for one that stood tapped: it goes where the tap is). */
interface Aim {
  pointer: Pt;
  centre: Pt | null;
}
/** What the hand points with: the pointer, or under a finger (which hides what is beneath it) the middle of the card it carries. */
const pointOf = (d: Grip, at: Aim): Pt => (d.touch && at.centre ? at.centre : at.pointer);
/** How far from a pile a finger may let go and still be taken to mean it: about half a card of the middle, and never less than a fingertip. */
const reachOf = (d: Grip, L: Layout): number => (d.touch && d.held.k === 'card' ? Math.max(26, L.fs * CARD_W * 0.55) : 0);
/**
 * The one pile the hand is over: the drop area under the pointer, and only if the pointer is over none, the one under
 * the centre of the grabbed card. (A card held by its corner is aimed with the pointer, not with a centre that is half
 * a card away.) Drop areas never overlap, so between two piles is neither.
 */
const pileUnder = <T extends { hit: Rect }>(d: Grip, at: Aim, piles: readonly T[], L: Layout): T | undefined => dropTarget(piles, pointOf(d, at), at.centre, reachOf(d, L));
/**
 * An Ace that is over no pile of yours aims at the felt under `centre`: that very point, nothing snaps. Returned as
 * soon as any of the card is over the felt, whether or not a pile may start there (`ok`), for the outline.
 */
function feltUnder(d: Grip, centre: Pt, { game, you, L }: Scene): { to: PileRef; rect: Rect; ok: boolean } | undefined {
  if (d.held.k !== 'card' || !d.held.ace) return undefined;
  const at = toTable(L.felt, centre.x, centre.y);
  if (offFelt(at, game.players.length) > cardSize(game.players.length).h / 2) return undefined;
  const to: PileRef = { k: 'felt', x: round3(at.x), y: round3(at.y) };
  return { to, rect: landingAt(L, centre), ok: canDrop(game, you, d.held.id, to) };
}

/**
 * Where the card in hand is, for the others: its centre as a distance from its pile (along your row, and towards the
 * middle) in cards of your hand, and as a point of the table, with how far along its way it is: 0 to 1 out to the
 * felt's edge, and from there to 2 on to a pile in the middle that would take it (`piles`; no further than 1 if there
 * is none).
 */
function whereabouts(d: InHand, piles: readonly Target[], { L, byId, game }: Scene): DragAt | null {
  const c = byId.get(d.lead);
  if (d.held.k !== 'card' || !c) return null;
  const centre = centreOf(d);
  const hw = c.s * CARD_W;
  const home = { x: d.base[0]!.x + hw / 2, y: d.base[0]!.y + (c.s * CARD_H) / 2 };
  const at = toTable(L.felt, centre.x, centre.y);
  // How far out to the felt, by the pointer: not the card, which a finger carries risen above it from the start.
  const n = game.players.length;
  const start = offFelt(toTable(L.felt, d.sx, d.sy), n);
  const now = d.phase === 'carried' ? offFelt(toTable(L.felt, d.px, d.py), n) : start;
  const out = start > 0 ? clamp(1 - now / start, 0, 1) : 1;
  // And on to the pile, by the card: under a finger it is over the felt, and on a pile at the near edge, before the
  // finger is. How far it has come over the felt (as much of the line back to where it lay as lies on it) against how
  // far it is still short of the pile.
  let [lo, hi] = [0, 1];
  if (offFelt(at, n) < 0)
    for (let i = 0; i < 12; i++) {
      const mid = (lo + hi) / 2;
      if (offFelt(toTable(L.felt, centre.x + (home.x - centre.x) * mid, centre.y + (home.y - centre.y) * mid), n) < 0) lo = mid;
      else hi = mid;
    }
  const over = lo * Math.hypot(home.x - centre.x, home.y - centre.y);
  // Within a third of a card of the pile's middle it has arrived.
  const there = L.fs * CARD_W * 0.35;
  let on = 0;
  for (const t of piles) {
    const left = Math.hypot(t.rect.x + t.rect.w / 2 - centre.x, t.rect.y + t.rect.h / 2 - centre.y) - there;
    on = Math.max(on, left <= 0 ? 1 : over / (over + left));
  }
  return {
    id: d.held.id,
    w: round3(out + on * (2 - out)),
    h: [round3(clamp((centre.x - home.x) / hw, -60, 60)), round3(clamp((home.y - centre.y) / hw, -60, 60))],
    p: [round3(clamp(at.x, -8, 8)), round3(clamp(at.y, -8, 8))],
  };
}

/** What there is to show of a hand, where it is now. */
export interface Sight {
  /** The card is over the felt: the pile underneath shows through it. */
  over: boolean;
  /** A finished pile is carried over the tray. */
  tray: boolean;
  /** Where the Ace carried over the felt would start a pile, and whether one may start there. */
  felt: { rect: Rect; ok: boolean } | undefined;
  /** Where it is, for the others. */
  report: DragAt | null;
}

/** After every movement of the hand, and whenever the table changes under it. (A release asks the very same of the piles: what is shown is what will be done.) */
export function sight(d: InHand, scene: Scene): Sight {
  const centre = centreOf(d);
  const over = offFelt(toTable(scene.L.felt, centre.x, centre.y), scene.game.players.length) < 0;
  const at: Aim | null = d.phase === 'carried' ? { pointer: { x: d.px, y: d.py }, centre } : null;
  if (d.held.k === 'pile') return { over, tray: !!at && !!pileUnder(d, at, [{ hit: scene.L.trayHit }], scene.L), felt: undefined, report: null };
  const piles = pilesFor(d.held.id, scene);
  const felt = at && !pileUnder(d, at, piles, scene.L) ? feltUnder(d, centre, scene) : undefined;
  return { over, tray: false, felt, report: whereabouts(d, piles.filter((t) => t.to.k === 'slot'), scene) };
}

// ---------------------------------------------------------------- taking up and putting down

const send = (intent: Intent): Effect => ({ k: 'send', intent });

/**
 * Takes up what was pressed: carried off by the pointer (now at `p`), or tapped and standing lifted where it was. The
 * server is told of a card either way: who holds what decides the grace window. (A finished pile is not held: nobody
 * else can move it.) Null if the card may not be held.
 */
function take(d: Pressed, phase: 'carried' | 'tapped', p: Pt, scene: Scene): { hand: InHand; effects: Effect[] } | null {
  const hold: Intent | null = d.held.k === 'card' ? { k: 'hold', cardId: d.held.id } : null;
  if (hold && !scene.plays(hold)) return null;
  const s = scene.byId.get(d.lead)?.s ?? 1;
  const hand: InHand = phase === 'carried' ? carry(d, p, scene) : { ...gripOf(d), phase, at: { x: leadBase(d).x, y: leadBase(d).y - s * CARD_H * STAND }, s };
  return { hand, effects: hold ? [send(hold)] : [] };
}

/**
 * Puts down what is in hand. Only the pile `at` points to counts: one that takes the card (the nearest, if a finger
 * is a little off), or for an Ace that very spot of the felt; for a finished pile, the tray. Anywhere else, and with
 * no `at`, it is put back. If the move is refused by the server a moment later (someone got there first) the card
 * goes home just the same, and the server takes it out of the hand by itself.
 */
function put(d: InHand, at: Aim | null, scene: Scene): Effect[] {
  const { L } = scene;
  if (d.held.k === 'pile') return at && pileUnder(d, at, [{ hit: L.trayHit }], L) ? [send({ k: 'clear', slot: d.held.slot })] : [];
  // One card put back, wherever: perhaps someone else's same card reached a pile in the middle while it was in hand.
  const back: Effect[] = [...(d.ids.length === 1 ? [{ k: 'tried' as const, card: d.held.id, seen: d.tops.map((top) => top ?? null) }] : []), send({ k: 'release' })];
  if (!at) return back;
  const felt = feltUnder(d, at.centre ?? at.pointer, scene);
  const to = pileUnder(d, at, pilesFor(d.held.id, scene), L)?.to ?? (felt?.ok ? felt.to : undefined);
  const move: Intent | undefined = to && { k: 'move', cardId: d.held.id, count: d.ids.length, to };
  return move && scene.plays(move) ? [send(move)] : back;
}

/** What a press on `on` takes hold of: a finished pile of yours that is waiting, or a card of yours with whatever lies on it. */
function gripAt(g: Extract<Gesture, { k: 'down' }>, id: string, { game, you, L, byId, waiting }: Scene): Grip | null {
  const placed = byId.get(id);
  let pick: Pick<Grip, 'held' | 'ids' | 'lead'> | null = null;
  if (placed?.pile === 'slot' && placed.at === waiting) {
    const ids = L.cards.filter((c) => c.pile === 'slot' && c.at === placed.at).map((c) => c.card.id);
    pick = { held: { k: 'pile', slot: placed.at }, ids, lead: ids[ids.length - 1]! };
  } else if (placed?.mine) {
    const got = grab(game, you, id);
    if (got) pick = { held: { k: 'card', id, ace: got.cards.length === 1 && got.cards[0]!.rank === 1 }, ids: got.cards.map((c) => c.id), lead: id };
  }
  return pick && { ...pick, sx: g.x, sy: g.y, base: pick.ids.map((i) => ({ x: byId.get(i)!.x, y: byId.get(i)!.y })), home: byId.get(pick.lead)!.s, touch: g.touch, tops: game.slots.map((pile) => pile?.cards.at(-1)?.id) };
}

// ---------------------------------------------------------------- the decisions

/** What a gesture does, the hand being `was.hand` and the table `scene`: the hand after it, and what is to be done. */
export function decide(was: Grasp, g: Gesture, scene: Scene): Step {
  const d = was.hand;
  const stay: Step = { ...was, effects: [] };
  switch (g.k) {
    case 'down': {
      if (scene.playingOut) return stay; // the end of a round plays out; only Escape skips it
      // What was tapped (or clicked) is in your hand, and this tap says where it goes. A tap anywhere else puts it
      // back and does nothing more, exactly as letting go of it there would: it does not deal from the stock, nor
      // take up another card.
      if (d?.phase === 'tapped' && g.main) return { hand: null, spent: true, effects: put(d, { pointer: g, centre: null }, scene) };
      if (scene.frozen || d || !g.main || !g.on) return stay;
      const placed = g.on === 'stock' ? undefined : scene.byId.get(g.on.card);
      if (scene.waiting >= 0 && (g.on === 'stock' || placed?.mine)) return { ...was, effects: [{ k: 'nag' }] };
      // The stock: a click deals a group off it, or (empty) turns the waste back over.
      if (g.on === 'stock' || (placed?.mine && placed.pile === 'stock')) return { ...was, effects: [{ k: 'deal' }] };
      const grip = gripAt(g, g.on.card, scene);
      return grip ? { ...was, hand: { ...grip, phase: 'pressed', pointer: g.pointer }, effects: [] } : stay;
    }
    case 'move': {
      if (!d || d.phase === 'tapped' || g.pointer !== d.pointer) return stay;
      if (d.phase === 'carried') return { ...was, hand: carry(d, g, scene), effects: [] };
      if (Math.hypot(g.x - d.sx, g.y - d.sy) < DRAG_SLOP) return stay;
      return { spent: was.spent, ...(take(d, 'carried', g, scene) ?? { hand: null, effects: [] }) };
    }
    case 'up': {
      // Where the table allows it, a tap or a click on a card of yours (or a run of them, or a pile you finished)
      // takes it up without carrying it, and the next tap or click puts it down (see 'down').
      const taken = d?.phase === 'pressed' && g.pointer === d.pointer && scene.live && scene.tapToMove && !was.spent ? take(d, 'tapped', g, scene) : null;
      if (taken) return { spent: false, ...taken };
      const fan: Effect[] = g.touch && (!d || d.phase === 'pressed') && scene.live && !scene.frozen && !was.spent ? [{ k: 'fan', x: g.x, y: g.y }] : [];
      if (!d || d.phase === 'tapped' || g.pointer !== d.pointer) return { hand: d, spent: false, effects: fan };
      if (d.phase === 'pressed') return { hand: null, spent: false, effects: fan };
      return { hand: null, spent: false, effects: put(d, { pointer: g, centre: centreOf(d) }, scene) };
    }
    case 'cancel':
      if (!d || d.phase === 'tapped' || g.pointer !== d.pointer) return stay;
      return { ...was, hand: null, effects: d.phase === 'carried' ? put(d, null, scene) : [] };
    case 'escape':
      // Escape puts what was tapped (or clicked) back, as a tap anywhere else would.
      return d?.phase === 'tapped' ? { ...was, hand: null, effects: put(d, null, scene) } : stay;
    case 'table': {
      // The server can take a card out of your hand: Nertz was called and it has nowhere to go, the grace window
      // closed, or the card was buried. Then it is in hand no more, and goes home.
      if (!d || d.phase === 'pressed') return stay;
      const gone = d.held.k === 'card' ? scene.game.players.find((p) => p.seat === scene.you)?.holding !== d.held.id : scene.waiting !== d.held.slot;
      return gone ? { ...was, hand: null, effects: [] } : stay;
    }
  }
}

// ---------------------------------------------------------------- telling the others

/**
 * Tells the others where the card in hand is, at most DRAG_HZ a second: the first report of a hand goes at once, and
 * the last always goes out, late if need be. `stop` when the hand opens or the table is gone: nothing more is sent.
 */
export function reporter(post: (at: DragAt) => void): { tell(at: DragAt): void; stop(): void } {
  let last: DragAt | null = null;
  let sent = -Infinity;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const go = () => {
    timer = undefined;
    sent = performance.now();
    if (last) post(last);
  };
  return {
    tell(at) {
      last = at;
      const wait = sent + 1000 / DRAG_HZ - performance.now();
      if (wait <= 0) go();
      else timer ??= setTimeout(go, wait);
    },
    stop() {
      clearTimeout(timer);
      timer = undefined;
      last = null;
      sent = -Infinity;
    },
  };
}
