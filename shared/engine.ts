// Nertz rules engine. Pure: no IO, no clock, no Math.random (the RNG is injected
// into `deal`). The server runs it on the full state; the client runs the very
// same reducer on its redacted view to predict its own moves.
//
// Pile convention: the TOP of every pile is the LAST array element.
import { MAX_PLAYERS, parseIntent, SLOTS_PER_PLAYER, WORK_PILES, type SetUp } from './protocol';
import { faceDown } from './settings';
import { openPlace, roomAt, tiltAt, type Pt } from './table';
import type { AnyCard, Card, CentrePile, GameState, HiddenCard, Intent, PileRef, PlayerState, PlayerView, RoundEnd, RoundScore, Suit, WorkPile } from './types';

export { DEAL_MS, GRACE_MS, SLOTS_PER_PLAYER, START_BEAT_MS, START_BEATS, START_MS, WORK_PILES } from './protocol';
export const SUITS: readonly Suit[] = ['S', 'H', 'D', 'C'];
export const NERTZ_SIZE = 13;
/** Cards in a group dealt off the stock by one `draw`. */
export const DRAW_COUNT = 3;
const DECK_SIZE = 52;
const KING = 13;

export type Rng = () => number;
export type Result = { ok: true; state: GameState } | { ok: false; reason: string };

/** Where a grabbed card comes from (always one of the acting seat's own piles). */
export type Source = { k: 'nertz' } | { k: 'waste' } | { k: 'work'; i: number };
/** `cards[0]` is the grabbed card; more than one card only for a run lifted off a work pile. */
export interface Grab {
  from: Source;
  cards: Card[];
}

export const isHidden = (c: AnyCard): c is HiddenCard => 'hidden' in c;
export const isRed = (suit: Suit): boolean => suit === 'H' || suit === 'D';
/** A centre pile that has its King: nothing more goes on it. */
export const isComplete = (pile: readonly Card[]): boolean => pile.length === KING;
/** The seat that placed the King of a complete centre pile (the only one who may clear it), else null. (Null too for a slot with no pile in it.) */
export const completedBy = (pile: CentrePile | null | undefined): number | null => (pile && isComplete(pile.cards) ? pile.cards[KING - 1]!.owner : null);
/** The round is live: play is open and nobody has ended it. Only then can a card be picked up, a pile cleared, a vote taken or the round paused. */
export const isLive = (state: GameState): boolean => state.status.at === 'play';
/** Play has opened, whether or not it is over since: the nertz tops are turned up. */
export const hasOpened = (state: GameState): boolean => state.status.at === 'play' || state.status.at === 'grace' || state.status.at === 'over';
/** The round is over, however it ended: nothing can change any more. */
export const isOver = (state: GameState): boolean => state.status.at === 'over';
/** The seat that called Nertz, while cards in hand may still land and once the round is over by that call; null if nobody has (yet, or at all). */
export const calledBy = ({ status }: GameState): number | null => (status.at === 'grace' ? status.calledBy : status.at === 'over' && status.end.by === 'nertz' ? status.end.seat : null);
/** The seats whose nertz piles are empty, in seat order. */
const emptied = (state: GameState): number[] => state.players.filter((p) => p.nertz.length === 0).map((p) => p.seat);
/**
 * The seats that got Nertz: once it is called, everyone whose nertz pile is empty (the caller, and anyone else who
 * emptied theirs, whether or not they called); once the round is over by the call, those it ended with (`RoundEnd.out`).
 * None before a call, or in a round that ended without one.
 */
export const wentOut = (state: GameState): number[] => (state.status.at === 'grace' ? emptied(state) : state.status.at === 'over' && state.status.end.by === 'nertz' ? state.status.end.out : []);
/** The seats in the held-card grace window: after a call everyone else's hand is emptied, so exactly those still holding a card. */
export const inGrace = (state: GameState): number[] => (state.status.at === 'grace' ? state.players.filter((p) => p.holding !== null).map((p) => p.seat) : []);
/** The seats whose windows Nertz has been called in but have not said yet that they have it (`heard`). None but in grace. */
export const yetToHear = (state: GameState): number[] => (state.status.at === 'grace' ? state.status.unheard : []);
/** The call has reached `seat`'s window: it is waited for no longer. */
const hears = (state: GameState, seat: number): GameState =>
  state.status.at === 'grace' ? { ...state, status: { ...state.status, unheard: state.status.unheard.filter((s) => s !== seat) } } : state;
/** `seat` placed the King of a centre pile that is still on the table. */
const finishedOn = (state: GameState, seat: number): boolean => state.slots.some((pile) => completedBy(pile) === seat);
/**
 * Clear-first: `seat` put a King on a centre pile and has not carried the pile to the tray yet. Until they do,
 * `applyIntent` refuses everything else from them. (While the round is live: once it is called or over nothing can be cleared.)
 */
export const mustClear = (state: GameState, seat: number): boolean => isLive(state) && finishedOn(state, seat);
export const CLEAR_FIRST = 'Move your finished pile to the tray first';
const top = <T>(pile: readonly T[]): T | undefined => pile[pile.length - 1];
/** The face-up run of a work pile, bottom first: what can be picked up off it. */
export const faceUp = (pile: WorkPile): AnyCard[] => pile.cards.slice(pile.down);

// ---------------------------------------------------------------- dealing

/**
 * Deals a fresh round: one shuffled 52-card deck per seat, with opaque random
 * card ids. Per seat: 13 in the nertz pile, work piles of 1, 2, 3 and 4 cards
 * (0 to 3 face-down under one face-up), and the other 29 as stock. The middle
 * gets 4 empty slots per seat. The round starts out
 * `dealing`: closed to every intent and fully redacted until
 * `finishDeal`; see `openPlay`.
 *
 * A small table buries fewer cards (`faceDown` in settings.ts): with two seats
 * no work pile has a face-down card (4 cards in the work piles, 35 in the
 * stock), with three they have 0/0/1/2 (7 and 32), from four up 0/1/2/3.
 * (A hand put on the table or taken off it afterwards changes that: `withHands`.)
 */
export function deal(seats: readonly number[], rng: Rng): GameState {
  const pick = (n: number) => Math.min(n - 1, Math.max(0, Math.floor(rng() * n)));
  const ID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const used = new Set<string>();
  const newId = (): string => {
    let id = '';
    for (let i = 0; i < 8; i++) id += ID_CHARS[pick(ID_CHARS.length)];
    // A collision is practically impossible with a real rng; a broken one must not hang the server.
    if (used.has(id)) id += `-${used.size}`;
    used.add(id);
    return id;
  };
  const players = seats.map((seat): PlayerState => {
    const deck: Card[] = SUITS.flatMap((suit) =>
      Array.from({ length: KING }, (_, r) => ({ id: newId(), owner: seat, suit, rank: r + 1 })),
    );
    for (let i = deck.length - 1; i > 0; i--) {
      const j = pick(i + 1);
      [deck[i], deck[j]] = [deck[j]!, deck[i]!];
    }
    const nertz = deck.splice(0, NERTZ_SIZE);
    const work = faceDown(seats.length).slice(0, WORK_PILES).map((down): WorkPile => ({ cards: deck.splice(0, down + 1), down }));
    return { seat, nertz, work, stock: deck, waste: [], dealt: 0, stuck: false, holding: null };
  });
  const slots = Array.from({ length: SLOTS_PER_PLAYER * seats.length }, () => null);
  return { players, status: { at: 'dealing' }, slots, tray: [], reshuffles: 0 };
}

/**
 * For trying things out (never in production): what each set-up puts on top of each hand's piles (`nertz`, or a work
 * pile by number), and how many cards it leaves in the nertz pile (the rest go under the stock).
 */
const SET_UP_TOPS: Record<SetUp, { tops: [pile: 'nertz' | number, suit: Suit, rank: number][]; nertz?: number }> = {
  // An Ace to put down and a 2 to put on it, twice over.
  aces: { tops: [[0, 'S', 1], [1, 'S', 2], [2, 'H', 1], [3, 'H', 2]] },
  // Everyone's Ace of spades is up, and their 2 of spades waits on their nertz pile: once two of the Aces are down, each 2 has two piles to go to.
  'two-piles': { tops: [[0, 'S', 1], ['nertz', 'S', 2]] },
  // Two Aces left in the nertz pile: put them down and call.
  out: { tops: [['nertz', 'D', 1], ['nertz', 'C', 1]], nertz: 2 },
};

/**
 * A freshly dealt round (`deal`) rearranged into a set-up: within each hand, each card the set-up names is swapped
 * onto the top it names (for several on one pile, the first named on top and the next under it), and the card that
 * lay there goes where it came from. Everything else stays as dealt.
 */
export function setUpDeal(state: GameState, name: SetUp): GameState {
  const { tops, nertz: left } = SET_UP_TOPS[name];
  const players = state.players.map((p): PlayerState => {
    const nertz = [...p.nertz];
    const work = p.work.map((w) => ({ ...w, cards: [...w.cards] }));
    const stock = [...p.stock];
    const piles = [nertz, ...work.map((w) => w.cards), stock];
    const placed = new Map<AnyCard[], number>();
    for (const [at, suit, rank] of tops) {
      const to = at === 'nertz' ? nertz : work[at]!.cards;
      const i = to.length - 1 - (placed.get(to) ?? 0);
      placed.set(to, (placed.get(to) ?? 0) + 1);
      const is = (c: AnyCard) => !isHidden(c) && c.suit === suit && c.rank === rank;
      const from = piles.find((pile) => pile.some(is))!;
      const j = from.findIndex(is);
      [to[i], from[j]] = [from[j]!, to[i]!];
    }
    const under = left === undefined ? [] : nertz.splice(0, nertz.length - left);
    return { ...p, nertz, work, stock: [...under, ...stock] };
  });
  return { ...state, players };
}

// ---------------------------------------------------------------- legality

/** Can `card` go on a work pile whose top is `onto` (undefined = empty pile)? One rank down, opposite colour. */
function stacksOn(card: Card, onto: AnyCard | undefined): boolean {
  if (!onto) return true;
  return !isHidden(onto) && card.rank === onto.rank - 1 && isRed(card.suit) !== isRed(onto.suit);
}

/** Does this centre pile take `card`? It needs the same suit one rank below on top (so never an Ace: that starts a pile of its own). */
const slotAccepts = ({ cards }: CentrePile, card: Card): boolean => cards.length === card.rank - 1 && cards[0].suit === card.suit;

/** The places of the piles lying in these slots. */
const piled = (slots: GameState['slots']): Pt[] => slots.flatMap((pile) => (pile ? [pile.at] : []));

/**
 * May a new pile be started at `at` (table space)? There must be a slot left
 * (4 per player), the whole card must lie on the felt, and it must keep the
 * gap to every pile that is there (shared/table.ts): exactly what everyone
 * sees on their screen.
 */
export const feltFree = (state: GameState, at: Pt): boolean =>
  state.slots.includes(null) && roomAt(at, piled(state.slots), state.players.length);

/**
 * What `seat` would pick up by grabbing `cardId`: the top of their nertz pile
 * or waste (not while a group is in flight onto it: its top is face-down), or a face-up card in one of their work piles together with
 * everything on top of it. Null if the card is not theirs to move, is
 * face-down, or its face is not known in this (redacted) state.
 */
export function grab(state: GameState, seat: number, cardId: string): Grab | null {
  const p = state.players.find((p) => p.seat === seat);
  if (!p) return null;
  const lift = (from: Source, cards: AnyCard[]): Grab | null => (cards.some(isHidden) ? null : { from, cards: cards as Card[] });
  if (top(p.nertz)?.id === cardId) return lift({ k: 'nertz' }, p.nertz.slice(-1));
  if (top(p.waste)?.id === cardId) return p.dealt > 0 ? null : lift({ k: 'waste' }, p.waste.slice(-1));
  for (const [i, pile] of p.work.entries()) {
    const at = pile.cards.findIndex((c) => c.id === cardId);
    if (at >= 0) return at >= pile.down ? lift({ k: 'work', i }, pile.cards.slice(at)) : null;
  }
  return null;
}

/**
 * Validates a move against the exact pile it names. There is no fallback of
 * any kind: if that pile does not take the card, the move is illegal. Returns
 * what was grabbed, or the reason it is illegal. `count` is how many cards the
 * mover believes they lifted (omitted: whatever lies there). Ignores whether
 * the round is still on.
 */
function planMove(state: GameState, seat: number, cardId: string, to: PileRef, count?: number): Grab | string {
  const me = state.players.find((p) => p.seat === seat);
  const g = grab(state, seat, cardId);
  if (!me || !g) return 'That card cannot be moved';
  if (count !== undefined && g.cards.length !== count) return 'Those are not the cards that were lifted';
  const card = g.cards[0]!;
  if (to.k !== 'work' && g.cards.length > 1) return 'Only single cards go to the middle';
  if (to.k === 'felt') {
    if (card.rank !== 1) return 'Only an Ace starts a pile';
    return feltFree(state, to) ? g : 'No room for a pile there';
  }
  if (to.k === 'slot') {
    const pile = state.slots[to.i];
    if (pile === undefined) return 'No such slot';
    if (pile === null) return 'No pile there';
    return slotAccepts(pile, card) ? g : 'Does not fit there';
  }
  const pile = me.work[to.i];
  if (!pile) return 'No such pile';
  if (g.from.k === 'work') {
    if (g.from.i === to.i) return 'Already there';
    const whole = me.work[g.from.i]!.cards.length === g.cards.length;
    if (whole && pile.cards.length === 0) return 'Pointless move';
  }
  return stacksOn(card, top(pile.cards)) ? g : 'Does not fit there';
}

/**
 * Every pile on which `seat` could legally put `cardId` (with any run on top
 * of it), going purely by the cards: it ignores whether the round is still on
 * or whose turn the grace window allows. Empty if the card cannot be picked up.
 * An Ace can go to any clear patch of felt: that is listed as ONE such place
 * (the clear one nearest the middle), if there is any.
 */
export function legalDrops(state: GameState, seat: number, cardId: string): PileRef[] {
  const targets: PileRef[] = [
    ...Array.from({ length: WORK_PILES }, (_, i): PileRef => ({ k: 'work', i })),
    ...state.slots.map((_, i): PileRef => ({ k: 'slot', i })),
  ];
  const drops = targets.filter((to) => typeof planMove(state, seat, cardId, to) !== 'string');
  if (state.slots.includes(null) && grab(state, seat, cardId)?.cards[0]?.rank === 1) {
    const at = openPlace(piled(state.slots), state.players.length);
    if (at && typeof planMove(state, seat, cardId, { k: 'felt', ...at }) !== 'string') drops.push({ k: 'felt', ...at });
  }
  return drops;
}

/**
 * Would `seat` dropping `cardId` on exactly `to` be accepted right now? The
 * same verdict `applyIntent` gives the move, including the frozen table after
 * a Nertz call and the one-held-card rule during grace.
 */
export function canDrop(state: GameState, seat: number, cardId: string, to: PileRef): boolean {
  const count = grab(state, seat, cardId)?.cards.length;
  return count !== undefined && applyIntent(state, seat, { k: 'move', cardId, count, to }).ok;
}

// ---------------------------------------------------------------- reducer

const fail = (reason: string): Result => ({ ok: false, reason });

/** The top `n` cards lifted off a work pile. If that leaves only face-down cards, the top one of them turns over. */
function liftOff(pile: WorkPile, n: number): WorkPile {
  const cards = pile.cards.slice(0, pile.cards.length - n);
  return { cards, down: pile.down > 0 && cards.length === pile.down ? pile.down - 1 : pile.down };
}
/** Cards put on a work pile: face-up, on top. */
const putOn = (pile: WorkPile, cards: readonly Card[]): WorkPile => ({ ...pile, cards: [...pile.cards, ...cards] });

/**
 * One intent from the player at `index`, by the ordinary rules of play (the
 * caller has already dealt with the round being over or in grace). Returns the
 * next state or the reason for refusing. Never mutates `state`.
 */
function play(state: GameState, index: number, intent: Intent): GameState | string {
  const old = state.players[index]!;
  const seat = old.seat;
  const me: PlayerState = {
    ...old,
    nertz: [...old.nertz],
    work: [...old.work],
    stock: [...old.stock],
    waste: [...old.waste],
  };
  let next: GameState = state;

  switch (intent.k) {
    case 'draw': {
      if (me.dealt > 0) return 'A draw is under way';
      if (me.stock.length > 0) dealStep(me);
      else if (me.waste.length > 0) [me.stock, me.waste] = [me.waste.reverse(), []]; // turn the waste over: first card dealt is on top again
      else return 'Nothing to draw';
      break;
    }
    case 'stuck': {
      me.stuck = intent.on;
      break;
    }
    case 'end': {
      if (intent.on) me.ending = true;
      else delete me.ending;
      break;
    }
    case 'nertz': {
      if (me.nertz.length > 0) return 'Your nertz pile is not empty';
      me.holding = null; // the caller pressed a button, they are not dragging: the caller is never in grace
      // (Nor waited for: the call is theirs. Only seats of the round can hear it.)
      const unheard = state.players.flatMap((p) => (p.seat !== seat && intent.unheard?.includes(p.seat) ? [p.seat] : []));
      next = { ...state, status: { at: 'grace', calledBy: seat, unheard } };
      break;
    }
    case 'heard': {
      if (state.status.at !== 'grace') return 'Nothing has been called';
      next = hears(state, seat);
      break;
    }
    case 'hold': {
      if (!grab(state, seat, intent.cardId)) return 'That card cannot be picked up';
      me.holding = intent.cardId;
      break;
    }
    case 'release': {
      if (me.holding === null) return 'Not holding a card';
      me.holding = null;
      break;
    }
    case 'clear': {
      const pile = state.slots[intent.slot];
      if (!pile || completedBy(pile) !== seat) return 'Only the player who placed the King can clear a finished pile';
      me.stuck = false;
      next = {
        ...state,
        // The felt it lay on is anybody's again.
        slots: state.slots.map((s, i) => (i === intent.slot ? null : s)),
        tray: [...state.tray, pile.cards],
      };
      break;
    }
    case 'move': {
      const g = planMove(state, seat, intent.cardId, intent.to, intent.count);
      if (typeof g === 'string') return g;
      const { from, cards } = g;
      // (A card turned over on a redacted view keeps its face unknown until the next snapshot.)
      if (from.k === 'work') me.work[from.i] = liftOff(me.work[from.i]!, cards.length);
      else me[from.k].pop();
      me.stuck = false;
      me.holding = null;
      const to = intent.to;
      if (to.k === 'work') me.work[to.i] = putOn(me.work[to.i]!, cards);
      else if (to.k === 'slot') next = { ...state, slots: state.slots.map((s, i): CentrePile | null => (s && i === to.i ? { ...s, cards: [...s.cards, cards[0]!] } : s)) };
      else {
        // A new pile, in the first slot nobody is using, at the very place the Ace was put down.
        const slot = state.slots.indexOf(null);
        const pile: CentrePile = { cards: [cards[0]!], at: { x: to.x, y: to.y, r: tiltAt(to) } };
        next = { ...state, slots: state.slots.map((s, i) => (i === slot ? pile : s)) };
      }
      break;
    }
  }
  next = { ...next, players: state.players.map((p, i) => (i === index ? me : p)) };
  // Dealing a card onto the waste buries the card being held; a hold never outlives the card being pickable.
  if (me.holding !== null && !grab(next, seat, me.holding)) me.holding = null;
  return next;
}

/**
 * The one step of a group in flight off `me`'s stock, the first one a `draw`'s and each after it the server's
 * (`dealOn`), STOCK_CARD_MS apart: the next card off the stock, face-down onto the waste; or, the group all dealt
 * (`DRAW_COUNT` cards, or the stock ran out), the group turns up together, and the draw is over.
 */
function dealStep(me: PlayerState): void {
  if (me.dealt === DRAW_COUNT || (me.dealt > 0 && me.stock.length === 0)) me.dealt = 0;
  else {
    me.waste = [...me.waste, me.stock.pop()!];
    me.dealt++;
  }
}

/**
 * The server's step of `seat`'s group in flight (`dealStep`), while the round is live. The state as it was if there
 * is none, or the round is not live (a group in flight at the call stays as it is). Never mutates `state`.
 */
export function dealOn(state: GameState, seat: number): GameState {
  const old = state.players.find((p) => p.seat === seat);
  if (!old || old.dealt === 0 || !isLive(state)) return state;
  const me: PlayerState = { ...old, stock: [...old.stock] };
  dealStep(me);
  return { ...state, players: state.players.map((p) => (p === old ? me : p)) };
}

/** The round is over, in the one way every round ends: whatever is in anyone's hand goes back, and nothing changes after. */
function endRound(state: GameState, end: RoundEnd): GameState {
  return { ...state, status: { at: 'over', end }, players: state.players.map((p) => (p.holding === null ? p : { ...p, holding: null })) };
}

/** The end of grace: the round is over by the call, and whoever has an empty nertz pile then got Nertz. */
function endCalled(state: GameState, calledBy: number): GameState {
  return endRound(state, { by: 'nertz', seat: calledBy, out: emptied(state) });
}

/**
 * After a Nertz call, and after each thing done in grace: whoever holds a card that has nowhere legal to go has it
 * taken out of their hand (their drag is cancelled), which leaves in grace those still holding one. With nobody left
 * in it, and nobody left to hear the call, the round is over: the one way out of grace.
 */
function settleGrace(state: GameState): GameState {
  if (state.status.at !== 'grace') return state;
  const players = state.players.map((p) => (p.holding === null || legalDrops(state, p.seat, p.holding).length > 0 ? p : { ...p, holding: null }));
  return players.some((p) => p.holding !== null) || state.status.unheard.length > 0 ? { ...state, players } : endCalled(state, state.status.calledBy);
}

// The opening of a round is the first steps of its status: dealing -> ready -> countdown -> play. Each step is taken by
// the server (two timers and the dealer's button); each function returns the same object when it is not its turn.

/** The deal is over (the server's deal timer fired): the work piles show their tops and the table waits for the dealer. */
export function finishDeal(state: GameState): GameState {
  return state.status.at === 'dealing' ? { ...state, status: { at: 'ready' } } : state;
}

/**
 * `hand`, nothing played from it yet, buried as deep as a table of `players` hands is dealt (`faceDown`): each work
 * pile keeps its face-up top, and the face-down cards under it come off the bottom of the stock (the end drawn last)
 * or go back there. Nobody has seen either. It goes a table size at a time, each step back undoing the one forward,
 * so that a hand is the same at the same depth however it got there: nobody has other cards by getting up and
 * sitting down again.
 */
function buried(hand: PlayerState, players: number): PlayerState {
  const total = (downs: number[]) => downs.reduce((a, b) => a + b, 0);
  const deeper = total(faceDown(players)) > total(hand.work.map((w) => w.down));
  const sizes = Array.from({ length: MAX_PLAYERS }, (_, i) => i + 1).filter((n) => (deeper ? n <= players : n >= players));
  let { work, stock } = hand;
  for (const n of deeper ? sizes : sizes.reverse()) {
    const left = [...stock];
    const back: AnyCard[] = [];
    work = work.map((w, i): WorkPile => {
      const down = faceDown(n)[i]!;
      if (deeper ? down <= w.down : down >= w.down) return w;
      back.push(...w.cards.slice(0, Math.max(0, w.down - down)));
      return { cards: [...left.splice(0, Math.max(0, down - w.down)), ...w.cards.slice(Math.max(0, w.down - down))], down };
    });
    stock = [...back, ...left];
  }
  return { ...hand, work, stock };
}

/**
 * `hands` are the ones on the table of a round dealt and not yet started, with the middle's four slots for each. Until
 * the dealer's Start nothing has been played, so a hand comes off with whoever gets up from it and goes on with whoever
 * sits down there, and every hand on the table is buried as deep as so many hands are dealt (`buried`): its face-up
 * cards and nertz pile stay as they are. Same state from the count on: from then cards lie where they are.
 */
export function withHands(state: GameState, hands: readonly PlayerState[]): GameState {
  if (state.status.at !== 'dealing' && state.status.at !== 'ready') return state;
  const players = hands.map((h) => buried(h, hands.length)).sort((a, b) => a.seat - b.seat);
  return { ...state, players, slots: Array.from({ length: SLOTS_PER_PLAYER * hands.length }, () => null) };
}

/** The dealer pressed Start: "1, 2, 3...". */
export function startCountdown(state: GameState): GameState {
  return state.status.at === 'ready' ? { ...state, status: { at: 'countdown' } } : state;
}

/** "...NERTZ!" (the server's start timer fired): the nertz tops turn over and play opens, for everyone at once. */
export function openPlay(state: GameState): GameState {
  return state.status.at === 'countdown' ? { ...state, status: { at: 'play' } } : state;
}

const CLOSED = { dealing: 'The cards are still being dealt', ready: 'Waiting for the dealer to start', countdown: 'Wait for it' } as const;

/**
 * The one reducer. Pure, never throws (garbage intents and seats are rejected),
 * never mutates `state`. Works on redacted views too: face-down cards can be
 * dealt, recycled or uncovered, but can never be the subject or target of a move.
 *
 * What is taken goes by `state.status`, and by nothing else. Before play opens
 * everything is rejected, and once the round is over.
 *
 * Held-card grace: a `nertz` call freezes the table except for the seats that
 * are holding a card with at least one legal destination (`inGrace`).
 * Each of them may make exactly one more intent: a `move` of the held card, or
 * a `release`. Either takes them out of grace (a refused move too, see `refused`), and anyone else in grace whose
 * card now has nowhere to go is cut off with them. When nobody is left in it, and
 * the call has reached every window it was waiting for, the round is over.
 *
 * The call reaches a window a moment after it is made: until a seat says it has
 * (`heard`), it may still take a card up (`hold`), as it could just before, and
 * a card with somewhere to go puts it in grace. So a card someone was taking up
 * as the call went out is in hand at the call, as they saw it, wherever it was
 * on its way to the server. Its one play is the seat's last: made, the seat has
 * heard the call too.
 *
 * Clear-first: a seat with a finished centre pile of its own still on the table
 * (`mustClear`) may only `clear` it; every other intent is refused until it has.
 * Nobody else is affected. It cannot coincide with grace: the King was that
 * seat's last move, which emptied its hand, and it has not been able to pick
 * anything up since. If somebody else calls Nertz first the pile simply stays
 * where it is and scores as it lies.
 */
export function applyIntent(state: GameState, seat: number, rawIntent: Intent): Result {
  const intent = parseIntent(rawIntent);
  if (!intent) return fail('Malformed intent');
  const index = state.players.findIndex((p) => p.seat === seat);
  if (index < 0) return fail('Not playing in this round');
  switch (state.status.at) {
    case 'dealing':
    case 'ready':
    case 'countdown':
      return fail(CLOSED[state.status.at]);
    case 'over':
      return fail('The round is over');
    case 'grace': {
      // Whoever the call has yet to reach may still take a card up, as they could a moment ago (not with a finished
      // pile of their own to clear, as then), and say that they have heard it.
      if (state.status.unheard.includes(seat) && (intent.k === 'hold' || intent.k === 'heard')) {
        if (intent.k === 'hold' && finishedOn(state, seat)) return fail(CLEAR_FIRST);
        break;
      }
      const held = state.players[index]!.holding;
      if (held === null) return fail('The round is over');
      if (intent.k !== 'release' && !(intent.k === 'move' && intent.cardId === held)) return fail('Only the held card may be played');
      break;
    }
    case 'play':
      if (intent.k !== 'clear' && intent.k !== 'end' && mustClear(state, seat)) return fail(CLEAR_FIRST);
  }
  const next = play(state, index, intent);
  if (typeof next === 'string') return fail(next);
  // A card in hand at the call has one play: once it is made, that window is not waited for either.
  return { ok: true, state: settleGrace(intent.k === 'move' || intent.k === 'release' ? hears(next, seat) : next) };
}

/**
 * What a REFUSED intent still does. Nothing, with one exception: a drop ends
 * the drag wherever it was aimed, so a refused `move` (someone got there
 * first) empties the mover's hand exactly as a `release` would. Without this
 * the server would go on believing a card is held that went home long ago,
 * and a Nertz call would open a grace window for it. In grace it is what makes
 * "exactly one move" true: a refused drop takes the seat out of grace.
 * Returns the same object when nothing changes.
 */
export function refused(state: GameState, seat: number, intent: Intent): GameState {
  if (intent.k !== 'move') return state;
  const result = applyIntent(state, seat, { k: 'release' });
  return result.ok ? result.state : state;
}

/**
 * Was `seat` sniped, putting its one card `cardId` on the pile in `slot` (which does not take it)? Only if someone
 * else put the very same card (suit and rank) there since `seat` took its card up: that card lies above `seen`, the
 * top `seat` saw there then, though others may have gone on it since. `seen` is null if there was no pile there yet,
 * and for a move that was sent: on its sender's screen the pile was still waiting for the card. The same card lying
 * there already, or a card that never went there, is no snipe, only a card with nowhere to go. Returns who did it and
 * with which card. (The server's question: the full state, and the pile is the record of who played what on it.)
 */
export function snipedBy(state: GameState, seat: number, cardId: string, slot: number, seen: string | null): { by: number; card: string } | null {
  const lifted = grab(state, seat, cardId)?.cards;
  const pile = state.slots[slot]?.cards;
  if (lifted?.length !== 1 || !pile) return null;
  const card = lifted[0]!;
  if (card.rank === 1) return null; // an Ace beaten to a place has others to go to
  const since = seen === null ? 0 : pile.findIndex((c) => c.id === seen) + 1;
  if (since === 0 && seen !== null) return null; // a top that was never on this pile
  const first = pile.slice(since).find((c) => c.suit === card.suit && c.rank === card.rank);
  return first && first.owner !== seat ? { by: first.owner, card: first.id } : null;
}

/** Ends the grace window (the server's 4-second timer fired): everyone still in it is cut off, and the round is over. Same object if there is none. */
export function expireGrace(state: GameState): GameState {
  return state.status.at === 'grace' ? endCalled(state, state.status.calledBy) : state;
}

// ---------------------------------------------------------------- stuck

/** How many times the whole table must have been stuck in a round (`GameState.reshuffles`) before ending it is offered at the table. */
export const RESHUFFLES_BEFORE_VOTE = 3;

/** The round drags: the whole table has been stuck, and had its stocks turned over, `RESHUFFLES_BEFORE_VOTE` times. */
export const dragsOn = (state: GameState): boolean => isLive(state) && state.reshuffles >= RESHUFFLES_BEFORE_VOTE;

/** Between `was` and `now`, two states of one round, the whole table was stuck and had its stocks turned over (`resolveStuck`). */
export const reshuffledSince = (was: GameState, now: GameState): boolean => now.reshuffles > was.reshuffles;

/**
 * Could `seat`, whatever they do with their own cards, ever get anywhere: put a card in the middle, or take one off
 * their nertz pile? The only two things that count: both score, and nothing else does. (Judged on the full state:
 * the server's question, not a client's. A face-down card counts for what it is.)
 *
 * Before the first of those, all a hand can do is put stock cards on its work piles and move runs between them, and
 * nobody else's cards come into it. So it is asked of that alone, and generously: every card that could ever come to
 * lie on top of a work pile is taken to lie there at once and for good, and an empty pile, once one can be had, to
 * stay. Whatever can really be reached is reached this way too (every real move is one of the steps below, and what
 * it needs was on top at the time), so a hand that gets nowhere here gets nowhere at all; a hand that seems to get
 * somewhere here may not (two cards wanting the same pile, say), which only leaves a dead table playing.
 * - A card goes off where it lies when it has somewhere to go: a card that can be on top and takes it, or an empty
 *   pile. A stock or waste card (any of them: shifting the stock brings each one up) then lies on top itself; a work
 *   card leaves on top the card it was dealt onto, turned up if it was face-down, or leaves its pile empty.
 * - It gets somewhere when the nertz top has somewhere to go, or a card that is loose (the nertz top, any stock or
 *   waste card, any card that can be on top of a work pile) goes to the middle: on a pile there, or an Ace anywhere
 *   (there is a slot for every Ace, and room for it once a finished pile is cleared).
 */
export function canProgress(state: GameState, seat: number): boolean {
  const p = state.players.find((q) => q.seat === seat);
  if (!p) return false;
  const known = (c: AnyCard | undefined): c is Card => c !== undefined && !isHidden(c);
  const toMiddle = (c: Card): boolean => c.rank === 1 || state.slots.some((pile) => pile !== null && slotAccepts(pile, c));
  const nertzTop = top(p.nertz);
  const loose = [...p.stock, ...p.waste].filter(known);
  if ([nertzTop, ...loose].some((c) => known(c) && toMiddle(c))) return true;

  /** Every card that can come to lie on top of a work pile, and whether a pile can be had empty. */
  const tops = p.work.map((w) => top(w.cards)).filter(known);
  let empty = p.work.some((w) => w.cards.length === 0);
  const takes = (c: Card): boolean => empty || tops.some((t) => stacksOn(c, t));
  /** The cards still where they were dealt, each with what its going leaves behind: a stock card itself, a work card the one under it (none: an empty pile). */
  let lying: { card: Card; leaves: AnyCard | undefined }[] = [
    ...loose.map((card) => ({ card, leaves: card })),
    ...p.work.flatMap((w) => w.cards.flatMap((card, j) => (known(card) ? [{ card, leaves: w.cards[j - 1] }] : []))),
  ];
  /** The work cards that can be picked up: face-up, as the ones under them become when they come to the top. */
  const up = new Set([...loose, ...p.work.flatMap(faceUp)].map((c) => c.id));
  for (let before = -1; before !== lying.length; ) {
    before = lying.length;
    lying = lying.filter(({ card, leaves }) => {
      if (!up.has(card.id) || !takes(card)) return true;
      if (leaves === undefined) empty = true;
      else if (known(leaves)) {
        up.add(leaves.id);
        tops.push(leaves);
      }
      return false;
    });
  }
  return (known(nertzTop) && takes(nertzTop)) || tops.some(toMiddle);
}

/**
 * If every seat in `activeSeats` (the connected players) has flagged "stuck":
 * - when no hand that is still played (`played`: by default every hand; not one whose player is up from it, which
 *   nobody will ever move) can ever get anywhere (`canProgress`), the table is jammed: the round ends there
 *   (over by a `jam`), to be scored as it stands;
 *   With no hand played at all it is jammed whoever has or has not said so.
 * - otherwise every player's waste is turned back onto their stock (restoring the original order; a half-dealt group
 *   is waste like the rest), then the top stock card moves to the bottom so the next draws come up differently,
 *   all flags clear, and the round has one more reshuffle to its count (`GameState.reshuffles`).
 * Returns the SAME state object when nothing happens (always, unless the round is live).
 */
export function resolveStuck(state: GameState, activeSeats: Iterable<number>, played: Iterable<number> = state.players.map((p) => p.seat)): GameState {
  if (!isLive(state)) return state;
  const hands = [...played];
  const jam = (): GameState => endRound({ ...state, players: state.players.map((p) => ({ ...p, stuck: false })) }, { by: 'jam' });
  if (hands.length === 0) return jam(); // nobody plays it any more: there is nobody to say so
  const active = new Set(activeSeats);
  const voters = state.players.filter((p) => active.has(p.seat));
  if (voters.length === 0 || !voters.every((p) => p.stuck)) return state;
  if (!hands.some((seat) => canProgress(state, seat))) return jam();
  const players = state.players.map((p): PlayerState => {
    const stock = [...p.stock, ...p.waste.toReversed()];
    // The top card goes to the bottom, so the next pass of threes brings up different cards (and the one after that
    // the rest: three stuck votes show every card).
    if (stock.length > 1) stock.unshift(stock.pop()!);
    // A held waste card has just gone back into the stock: it is no longer in hand.
    const holding = p.waste.some((c) => c.id === p.holding) ? null : p.holding;
    return { ...p, stock, waste: [], dealt: 0, stuck: false, holding };
  });
  return { ...state, players, reshuffles: state.reshuffles + 1 };
}

/**
 * The vote to end the round: how many have a say, and how many of them have voted. Those with a say are the seats in
 * `people` (the connected players who are not bots: a bot goes along with it) that were dealt into this round.
 */
export function endVote(state: GameState, people: Iterable<number>): { voters: number; voted: number } {
  const here = new Set(people);
  const voters = state.players.filter((p) => here.has(p.seat));
  return { voters: voters.length, voted: voters.filter((p) => p.ending).length };
}

/** Does `p` play at the table, as a room view lists them: has a seat, and is not up from the cards at it (`PlayerView.left`)? */
export const plays = (p: PlayerView): boolean => p.seat !== null && !p.left;

/**
 * Is whoever plays as `seat` in the round `state`: dealt into it, and not up from their cards? `seat` is the one they
 * play as, null (or -1) for anyone at no cards: the room view's `seat`, the server's `at`. Who is in the round may pause
 * it, and unpause it.
 */
export const inRound = (state: GameState, seat: number | null): boolean => seat !== null && state.players.some((p) => p.seat === seat);

/** Has `p` a say in the round's votes: plays, and is here and not standing (a bot too: see `seatedPeople`). */
export const hasSay = (p: PlayerView): boolean => plays(p) && p.connected && !p.standing;

/** The `people` of `endVote` as a room view lists them: those with a say who are not bots. */
export const seatedPeople = (players: readonly PlayerView[]): number[] => players.flatMap((p) => (hasSay(p) && !p.bot ? [p.seat!] : []));

/**
 * If everyone with a say in the `endVote` has voted to end the round, it ends there, to be scored as it stands
 * (over by a `vote`). Same state object otherwise.
 */
export function resolveEndVote(state: GameState, people: Iterable<number>): GameState {
  if (!isLive(state)) return state;
  const { voters, voted } = endVote(state, people);
  if (voters === 0 || voted < voters) return state;
  return endRound(state, { by: 'vote' });
}

// ---------------------------------------------------------------- views, scoring, invariants

const hide = (c: AnyCard): HiddenCard => (isHidden(c) ? c : { id: c.id, owner: c.owner, hidden: true });

/**
 * The state as a player may see it: same shape and same card ids, with every
 * face-down card redacted: stocks, everything under the top of each nertz pile,
 * the face-down cards at the bottom of each work pile and the cards of a group
 * in flight onto a waste (`dealt`), your own included.
 * While the cards are being dealt that is every card, and until play opens
 * (`ready`, `countdown`) it is still every nertz top: nobody gets a head start.
 *
 * While cards can still move (play, and the grace after a call), `seat` is also shown the faces of its own cards that its
 * next move could turn over (`comingUp`), still lying face-down: so a move it
 * makes turns them up on its own screen at once, not a round trip later.
 * A play to the middle can lose a race the client has not heard about yet, so a
 * card such a play uncovers (the one under the nertz top, or a work pile's
 * buried card) is kept face-unknown by the client until the move is confirmed:
 * net.ts `unconfirmed`. It never shows and then hides.
 */
export function viewFor(state: GameState, seat: number): GameState {
  const dealing = state.status.at === 'dealing';
  const opened = hasOpened(state);
  return {
    ...state,
    players: state.players.map((p) => {
      const shown = opened && !isOver(state) && p.seat === seat ? comingUp(p) : NONE;
      const show = (c: AnyCard): AnyCard => (shown.has(c.id) ? c : hide(c));
      return {
        ...p,
        nertz: p.nertz.map((c, i) => ((i === p.nertz.length - 1 && opened) || shown.has(c.id) ? c : hide(c))),
        work: p.work.map(({ cards, down }) => ({ cards: cards.map((c, j) => (dealing ? hide(c) : j < down ? show(c) : c)), down })),
        stock: p.stock.map(show),
        waste: p.waste.map((c, i) => (dealing || i >= p.waste.length - p.dealt ? hide(c) : c)),
      };
    }),
  };
}

const NONE: ReadonlySet<string> = new Set();

/**
 * The face-down cards a hand's next move could turn over: the card under its nertz top and the face-down card at the
 * top of each work pile's buried part. (A draw turns nothing over by itself: its group turns up on the server's step,
 * in the snapshot that says so.)
 */
function comingUp(p: PlayerState): ReadonlySet<string> {
  return new Set([
    ...p.nertz.slice(-2, -1),
    ...p.work.flatMap((w) => (w.down > 0 ? [w.cards[w.down - 1]!] : [])),
  ].map((c) => c.id));
}

/** Strictly: +1 per own card in the middle (centre slots and tray), -2 per card left in the nertz pile. */
export function scoreRound(state: GameState): RoundScore[] {
  const middle = [...state.slots.map((pile) => pile?.cards ?? []), ...state.tray].flat();
  return state.players.map((p) => {
    const played = middle.filter((c) => c.owner === p.seat).length;
    const nertzLeft = p.nertz.length;
    return { seat: p.seat, played, nertzLeft, delta: played - 2 * nertzLeft };
  });
}

/**
 * Returns null if the state is well-formed, otherwise a description of the
 * first problem. Checks that every card of every deck is present exactly once,
 * that every pile has a legal shape, and that holds and grace are consistent.
 * Hidden cards (in a view) are counted but their faces are not checked.
 */
export function checkInvariants(state: GameState): string | null {
  const ids = new Set<string>();
  const faces = new Set<string>();
  const perOwner = new Map<number, number>();
  const seats = new Set(state.players.map((p) => p.seat));
  if (seats.size !== state.players.length) return 'duplicate seat';
  const count = (c: AnyCard, where: string): string | null => {
    if (ids.has(c.id)) return `card ${c.id} appears twice (${where})`;
    ids.add(c.id);
    if (!seats.has(c.owner)) return `card ${c.id} has unknown owner ${c.owner}`;
    perOwner.set(c.owner, (perOwner.get(c.owner) ?? 0) + 1);
    if (isHidden(c)) return null;
    if (!SUITS.includes(c.suit) || !Number.isInteger(c.rank) || c.rank < 1 || c.rank > KING) return `card ${c.id} has a bad face`;
    const face = `${c.owner}:${c.suit}${c.rank}`;
    if (faces.has(face)) return `duplicate face ${face} (${where})`;
    faces.add(face);
    return null;
  };
  for (const p of state.players) {
    const at = `seat ${p.seat}`;
    if (p.work.length !== WORK_PILES) return `${at}: expected ${WORK_PILES} work piles`;
    if (p.nertz.length > NERTZ_SIZE) return `${at}: nertz pile too big`;
    const piles: [string, AnyCard[]][] = [['nertz', p.nertz], ['stock', p.stock], ['waste', p.waste]];
    p.work.forEach((w, i) => piles.push([`work ${i}`, w.cards]));
    for (const [name, pile] of piles) {
      for (const c of pile) {
        const bad = count(c, `${at} ${name}`);
        if (bad) return bad;
        if (c.owner !== p.seat) return `${at} ${name}: holds a card owned by seat ${c.owner}`;
      }
    }
    for (const [i, { cards: w, down }] of p.work.entries()) {
      if (!Number.isInteger(down) || down < 0 || down > Math.max(0, w.length - 1)) return `${at} work ${i}: no face-up card on top`;
      // The face-up part must be a run. (A lone top card may be hidden in a predicted view: just turned over, face not yet sent.)
      for (let j = down + 1; j < w.length; j++) {
        const [below, above] = [w[j - 1]!, w[j]!];
        if (isHidden(below) || isHidden(above)) return `${at} work ${i}: face-down card`;
        if (!stacksOn(above, below)) return `${at} work ${i}: not a descending alternating run`;
      }
    }
    if (!Number.isInteger(p.dealt) || p.dealt < 0 || p.dealt > DRAW_COUNT || p.dealt > p.waste.length) return `${at}: bad group in flight`;
    if (p.holding !== null && !grab(state, p.seat, p.holding)) return `${at}: holding a card they cannot pick up`;
  }
  if (state.slots.length !== SLOTS_PER_PLAYER * state.players.length) return 'wrong number of centre slots';
  for (const [i, pile] of state.slots.entries()) {
    if (pile && !roomAt(pile.at, piled(state.slots.slice(0, i)), state.players.length)) return `slot ${i}: off the table or overlapping another pile`;
  }
  const middle: [string, Card[]][] = [...state.slots.map((s, i): [string, Card[]] => [`slot ${i}`, s?.cards ?? []]), ...state.tray.map((s, i): [string, Card[]] => [`tray ${i}`, s])];
  for (const [name, pile] of middle) {
    if (pile.length > KING) return `${name}: too many cards`;
    for (const [j, c] of pile.entries()) {
      const bad = count(c, name);
      if (bad) return bad;
      if (isHidden(c) || c.suit !== pile[0]!.suit || c.rank !== j + 1) return `${name}: not ace-up in suit`;
    }
  }
  if (state.tray.some((pile) => !isComplete(pile))) return 'unfinished pile in the tray';
  if (!Number.isInteger(state.reshuffles) || state.reshuffles < 0) return 'bad count of reshuffles';
  for (const seat of seats) {
    if (perOwner.get(seat) !== DECK_SIZE) return `seat ${seat}: has ${perOwner.get(seat) ?? 0} cards, expected ${DECK_SIZE}`;
  }
  const caller = calledBy(state);
  if (caller !== null && state.players.find((p) => p.seat === caller)?.nertz.length !== 0) return 'nertz called by a seat with cards left';
  if (caller !== null && wentOut(state).join() !== emptied(state).join()) return 'out is not every seat with an empty nertz pile';
  if (!hasOpened(state) && (middle.some(([, pile]) => pile.length > 0) || state.players.some((p) => p.holding !== null || p.waste.length > 0))) {
    return 'play began before the round was open';
  }
  if (state.players.some((p) => p.holding !== null && finishedOn(state, p.seat))) return 'holding a card with a finished pile still to clear';
  if (state.status.at === 'grace') {
    const { calledBy: by, unheard } = state.status;
    if (new Set(unheard).size !== unheard.length || unheard.some((s) => s === by || !seats.has(s))) return 'the call waits to be heard where it cannot be';
    if (inGrace(state).length === 0 && unheard.length === 0) return 'grace with nobody holding a card or yet to hear the call';
    for (const p of state.players) {
      if (p.holding !== null && legalDrops(state, p.seat, p.holding).length === 0) return `seat ${p.seat}: in grace without a playable held card`;
    }
  }
  if (isOver(state) && state.players.some((p) => p.holding !== null)) return 'a frozen player is holding a card';
  return null;
}
