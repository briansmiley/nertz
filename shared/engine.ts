// Nertz rules engine. Pure: no IO, no clock, no Math.random (the RNG is injected
// into `deal`). The server runs it on the full state; the client runs the very
// same reducer on its redacted view to predict its own moves.
//
// Pile convention: the TOP of every pile is the LAST array element.
import { parseIntent, SLOTS_PER_PLAYER, WORK_PILES } from './protocol';
import { faceDown } from './settings';
import { openPlace, roomAt, tiltAt, type Pt } from './table';
import type { AnyCard, Card, CentrePile, GameState, HiddenCard, Intent, PileRef, PlayerState, PlayerView, RoundEnd, RoundScore, Suit, WorkPile } from './types';

export { DEAL_MS, GRACE_MS, SLOTS_PER_PLAYER, START_BEAT_MS, START_BEATS, START_MS, WORK_PILES } from './protocol';
export const SUITS: readonly Suit[] = ['S', 'H', 'D', 'C'];
export const NERTZ_SIZE = 13;
/** Cards in a group dealt off the stock: each is one action, and the group turns face-up when the last one lands. */
export const FLIP_COUNT = 3;
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
/** The seats in the held-card grace window: after a call everyone else's hand is emptied, so exactly those still holding a card. */
export const inGrace = (state: GameState): number[] => (state.status.at === 'grace' ? state.players.filter((p) => p.holding !== null).map((p) => p.seat) : []);
/**
 * Clear-first: `seat` put a King on a centre pile and has not carried the pile to the tray yet. Until they do,
 * `applyIntent` refuses everything else from them. (While the round is live: once it is called or over nothing can be cleared.)
 */
export const mustClear = (state: GameState, seat: number): boolean => isLive(state) && state.slots.some((pile) => completedBy(pile) === seat);
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
  return { players, status: { at: 'dealing' }, slots, tray: [] };
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
 * or waste (not while a group is half-dealt onto it: its top is face-down), or a face-up card in one of their work piles together with
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
    case 'flip': {
      if (me.stock.length === 0) {
        if (me.waste.length === 0) return 'Nothing to flip';
        me.stock = me.waste.reverse(); // turn the waste over: first card dealt is on top again
        me.waste = [];
        me.dealt = 0; // (it was: a group is never left half-dealt on an empty stock)
      } else {
        // One card per action, face-down onto the waste. The third of a group, or the last of the stock, turns the group up.
        me.waste.push(me.stock.pop()!);
        me.dealt = me.dealt + 1 === FLIP_COUNT || me.stock.length === 0 ? 0 : me.dealt + 1;
      }
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
      next = { ...state, status: { at: 'grace', calledBy: seat } };
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

/** The round is over, in the one way every round ends: whatever is in anyone's hand goes back, and nothing changes after. */
function endRound(state: GameState, end: RoundEnd): GameState {
  return { ...state, status: { at: 'over', end }, players: state.players.map((p) => (p.holding === null ? p : { ...p, holding: null })) };
}

/**
 * After a Nertz call, and after each thing done in grace: whoever holds a card that has nowhere legal to go has it
 * taken out of their hand (their drag is cancelled), which leaves in grace those still holding one. With nobody left
 * in it the round is over: the one way out of grace.
 */
function settleGrace(state: GameState): GameState {
  if (state.status.at !== 'grace') return state;
  const players = state.players.map((p) => (p.holding === null || legalDrops(state, p.seat, p.holding).length > 0 ? p : { ...p, holding: null }));
  return players.some((p) => p.holding !== null) ? { ...state, players } : endRound(state, { by: 'nertz', seat: state.status.calledBy });
}

// The opening of a round is the first steps of its status: dealing -> ready -> countdown -> play. Each step is taken by
// the server (two timers and the dealer's button); each function returns the same object when it is not its turn.

/** The deal is over (the server's deal timer fired): the work piles show their tops and the table waits for the dealer. */
export function finishDeal(state: GameState): GameState {
  return state.status.at === 'dealing' ? { ...state, status: { at: 'ready' } } : state;
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
 * card now has nowhere to go is cut off with them. When nobody is left in it the
 * round is over.
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
      const held = state.players[index]!.holding;
      if (held === null) return fail('The round is over');
      if (intent.k !== 'release' && !(intent.k === 'move' && intent.cardId === held)) return fail('Only the held card may be played');
      break;
    }
    case 'play':
      if (intent.k !== 'clear' && intent.k !== 'end' && mustClear(state, seat)) return fail(CLEAR_FIRST);
  }
  const next = play(state, index, intent);
  return typeof next === 'string' ? fail(next) : { ok: true, state: settleGrace(next) };
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
 * else put the very same card (suit and rank) there since `seat` took its card up: that card is the pile's top, and
 * `seen`, the top `seat` saw there then, lies under it. `seen` is null if there was no pile there yet, and for a
 * move that was sent: on its sender's screen the pile was still waiting for the card. The same card lying there
 * already, or a card that never went there, is no snipe, only a card with nowhere to go. Returns who did it and with
 * which card. (The server's question: the full state, and the pile is the record of who played what on it.)
 */
export function snipedBy(state: GameState, seat: number, cardId: string, slot: number, seen: string | null): { by: number; card: string } | null {
  const lifted = grab(state, seat, cardId)?.cards;
  const pile = state.slots[slot]?.cards;
  if (lifted?.length !== 1 || !pile) return null;
  const card = lifted[0]!;
  const top = pile.at(-1)!;
  if (card.rank === 1) return null; // an Ace beaten to a place has others to go to
  if (top.owner === seat || top.suit !== card.suit || top.rank !== card.rank) return null;
  if (seen !== null && !pile.slice(0, -1).some((c) => c.id === seen)) return null;
  return { by: top.owner, card: top.id };
}

/** Ends the grace window (the server's 4-second timer fired): everyone still in it is cut off, and the round is over. Same object if there is none. */
export function expireGrace(state: GameState): GameState {
  return state.status.at === 'grace' ? endRound(state, { by: 'nertz', seat: state.status.calledBy }) : state;
}

// ---------------------------------------------------------------- stuck

/**
 * Could `card`, one of `seat`'s stock or waste cards, do anything if it were on top of their waste? Go to the middle,
 * or onto one of their work piles. (Judged on the full state: the server's question, not a client's.)
 */
function stockCardMoves(state: GameState, seat: number, card: Card): boolean {
  const trial: GameState = { ...state, players: state.players.map((p) => (p.seat === seat ? { ...p, stock: [], waste: [card], dealt: 0, holding: null } : p)) };
  return legalDrops(trial, seat, card.id).length > 0;
}

/**
 * Is there a move for `seat` that gets anywhere? Their nertz top to the middle or a work pile; any card of their stock
 * or waste (wherever it lies in them: shifting the stock brings any of them up) likewise; or from a work pile, a
 * card to the middle, or a run onto another pile when that turns up a face-down card, empties the pile, or uncovers a
 * card that can go to the middle. Shuffling runs between work piles to no purpose does not count.
 */
export function canProgress(state: GameState, seat: number): boolean {
  const p = state.players.find((q) => q.seat === seat);
  if (!p) return false;
  const nertzTop = top(p.nertz);
  if (nertzTop && !isHidden(nertzTop) && legalDrops(state, seat, nertzTop.id).length > 0) return true;
  if ([...p.stock, ...p.waste].some((c) => !isHidden(c) && stockCardMoves(state, seat, c))) return true;
  return p.work.some((pile, i) => {
    const { cards, down } = pile;
    const last = top(cards);
    if (last && !isHidden(last) && legalDrops(state, seat, last.id).some((to) => to.k !== 'work')) return true;
    // A run onto another work pile: the whole face-up part (turning up a face-down card, or emptying the pile), or
    // part of it when the card it uncovers can then go to the middle.
    return cards.some((c, j) => {
      if (j < down || isHidden(c) || !legalDrops(state, seat, c.id).some((to) => to.k === 'work')) return false;
      if (j === down) return true;
      const under = cards[j - 1]!;
      const trial: GameState = { ...state, players: state.players.map((q) => (q.seat === seat ? { ...q, work: q.work.map((w, k) => (k === i ? liftOff(pile, cards.length - j) : w)) } : q)) };
      return legalDrops(trial, seat, under.id).some((to) => to.k !== 'work');
    });
  });
}

/**
 * If every seat in `activeSeats` (the connected players) has flagged "stuck":
 * - when nobody at the table can make a move that gets anywhere (`canProgress`), the table is jammed: the round ends
 *   there (over by a `jam`), to be scored as it stands;
 * - otherwise every player's waste is turned back onto their stock (restoring the original order; a half-dealt group
 *   is waste like the rest), then the top stock card moves to the bottom so the next flips come up differently, and
 *   all flags clear.
 * Returns the SAME state object when nothing happens (always, unless the round is live).
 */
export function resolveStuck(state: GameState, activeSeats: Iterable<number>): GameState {
  if (!isLive(state)) return state;
  const active = new Set(activeSeats);
  const voters = state.players.filter((p) => active.has(p.seat));
  if (voters.length === 0 || !voters.every((p) => p.stuck)) return state;
  if (!state.players.some((p) => canProgress(state, p.seat))) return endRound({ ...state, players: state.players.map((p) => ({ ...p, stuck: false })) }, { by: 'jam' });
  const players = state.players.map((p): PlayerState => {
    const stock = [...p.stock, ...p.waste.toReversed()];
    // The top card goes to the bottom, so the next pass of threes brings up different cards (and the one after that
    // the rest: three stuck votes show every card).
    if (stock.length > 1) stock.unshift(stock.pop()!);
    // A held waste card has just gone back into the stock: it is no longer in hand.
    const holding = p.waste.some((c) => c.id === p.holding) ? null : p.holding;
    return { ...p, stock, waste: [], dealt: 0, stuck: false, holding };
  });
  return { ...state, players };
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

/** The `people` of `endVote` as a room view lists them: those with a seat who are here and are not bots. */
export const seatedPeople = (players: readonly PlayerView[]): number[] => players.flatMap((p) => (p.seat !== null && p.connected && !p.bot ? [p.seat] : []));

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
 * still being dealt onto a waste (`dealt`), your own included.
 * While the cards are being dealt that is every card, and until play opens
 * (`ready`, `countdown`) it is still every nertz top: nobody gets a head start.
 * No hand is private in Nertz, so today every seat gets the same view; `seat`
 * is kept so that can change without touching callers.
 */
export function viewFor(state: GameState, _seat: number): GameState {
  const dealing = state.status.at === 'dealing';
  const opened = hasOpened(state);
  return {
    ...state,
    players: state.players.map((p) => ({
      ...p,
      nertz: p.nertz.map((c, i) => (i === p.nertz.length - 1 && opened ? c : hide(c))),
      work: p.work.map(({ cards, down }) => ({ cards: cards.map((c, j) => (j < down || dealing ? hide(c) : c)), down })),
      stock: p.stock.map(hide),
      waste: p.waste.map((c, i) => (dealing || i >= p.waste.length - p.dealt ? hide(c) : c)),
    })),
  };
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
    if (!Number.isInteger(p.dealt) || p.dealt < 0 || p.dealt >= FLIP_COUNT || p.dealt > p.waste.length) return `${at}: bad half-dealt group`;
    if (p.dealt > 0 && p.stock.length === 0) return `${at}: a group left half-dealt on an empty stock`;
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
  for (const seat of seats) {
    if (perOwner.get(seat) !== DECK_SIZE) return `seat ${seat}: has ${perOwner.get(seat) ?? 0} cards, expected ${DECK_SIZE}`;
  }
  const caller = calledBy(state);
  if (caller !== null && state.players.find((p) => p.seat === caller)?.nertz.length !== 0) return 'nertz called by a seat with cards left';
  if (!hasOpened(state) && (middle.some(([, pile]) => pile.length > 0) || state.players.some((p) => p.holding !== null || p.waste.length > 0))) {
    return 'play began before the round was open';
  }
  if (state.players.some((p) => p.holding !== null && mustClear(state, p.seat))) return 'holding a card with a finished pile still to clear';
  if (state.status.at === 'grace') {
    if (inGrace(state).length === 0) return 'grace with nobody holding a card';
    for (const p of state.players) {
      if (p.holding !== null && legalDrops(state, p.seat, p.holding).length === 0) return `seat ${p.seat}: in grace without a playable held card`;
    }
  }
  if (isOver(state) && state.players.some((p) => p.holding !== null)) return 'a frozen player is holding a card';
  return null;
}
