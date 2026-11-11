// Nertz rules engine. Pure: no IO, no clock, no Math.random (the RNG is injected
// into `deal`). The server runs it on the full state; the client runs the very
// same reducer on its redacted view to predict its own moves.
//
// Pile convention: the TOP of every pile is the LAST array element.
import { parseIntent, SLOTS_PER_PLAYER, WORK_PILES } from './protocol';
import { SMALL_TABLE } from './settings';
import type { AnyCard, Card, GameState, HiddenCard, Intent, PileRef, PlayerState, RoundScore, Suit } from './types';

export { DEAL_MS, GRACE_MS, SLOTS_PER_PLAYER, WORK_PILES } from './protocol';
export const SUITS: readonly Suit[] = ['S', 'H', 'D', 'C'];
export const NERTZ_SIZE = 13;
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
/** The seat that placed the King of a complete centre pile (the only one who may clear it), else null. */
export const completedBy = (pile: readonly Card[]): number | null => (isComplete(pile) ? pile[KING - 1]!.owner : null);
/** Nertz has been called and nobody is left in the held-card grace window: nothing can change any more. */
export const isOver = (state: GameState): boolean => state.nertzCalledBy !== null && state.grace.length === 0;
const top = <T>(pile: readonly T[]): T | undefined => pile[pile.length - 1];

// ---------------------------------------------------------------- dealing

/**
 * Deals a fresh round: one shuffled 52-card deck per seat, with opaque random
 * card ids. Per seat: 13 in the nertz pile, work piles of 1, 2, 3 and 4 cards
 * (0 to 3 face-down under one face-up), and the other 29 as stock. The middle
 * gets 4 empty slots per seat. The round starts out `dealing`: closed to every
 * intent and fully redacted until `finishDeal`.
 *
 * `rules.fewerDown` is the small-table house rule: with fewer than four seats
 * every work pile gets one fewer face-down card (0/0/1/2: 7 cards in the work
 * piles, 32 in the stock). With four or more seats it changes nothing.
 */
export function deal(seats: readonly number[], rng: Rng, rules: { fewerDown?: boolean } = {}): GameState {
  const fewer = rules.fewerDown && seats.length < SMALL_TABLE ? 1 : 0;
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
    const down = Array.from({ length: WORK_PILES }, (_, i) => Math.max(0, i - fewer));
    const work = down.map((n) => deck.splice(0, n + 1));
    return { seat, nertz, work, down, stock: deck, waste: [], stuck: false, holding: null };
  });
  const slots = Array.from({ length: SLOTS_PER_PLAYER * seats.length }, (): Card[] => []);
  return { players, dealing: true, slots, tray: [], nertzCalledBy: null, grace: [] };
}

// ---------------------------------------------------------------- legality

/** Can `card` go on a work pile whose top is `onto` (undefined = empty pile)? One rank down, opposite colour. */
function stacksOn(card: Card, onto: AnyCard | undefined): boolean {
  if (!onto) return true;
  return !isHidden(onto) && card.rank === onto.rank - 1 && isRed(card.suit) !== isRed(onto.suit);
}

/** Does this centre pile take `card`? An Ace needs the slot empty; anything else needs the same suit one rank below on top. */
const slotAccepts = (pile: readonly Card[], card: Card): boolean =>
  pile.length === card.rank - 1 && (pile.length === 0 || pile[0]!.suit === card.suit);

/**
 * What `seat` would pick up by grabbing `cardId`: the top of their nertz pile
 * or waste, or a face-up card in one of their work piles together with
 * everything on top of it. Null if the card is not theirs to move, is
 * face-down, or its face is not known in this (redacted) state.
 */
export function grab(state: GameState, seat: number, cardId: string): Grab | null {
  const p = state.players.find((p) => p.seat === seat);
  if (!p) return null;
  const lift = (from: Source, cards: AnyCard[]): Grab | null => (cards.some(isHidden) ? null : { from, cards: cards as Card[] });
  if (top(p.nertz)?.id === cardId) return lift({ k: 'nertz' }, p.nertz.slice(-1));
  if (top(p.waste)?.id === cardId) return lift({ k: 'waste' }, p.waste.slice(-1));
  for (const [i, pile] of p.work.entries()) {
    const at = pile.findIndex((c) => c.id === cardId);
    if (at >= 0) return at >= p.down[i]! ? lift({ k: 'work', i }, pile.slice(at)) : null;
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
  if (to.k === 'slot') {
    const pile = state.slots[to.i];
    if (!pile) return 'No such slot';
    if (g.cards.length > 1) return 'Only single cards go to the middle';
    return slotAccepts(pile, card) ? g : 'Does not fit there';
  }
  const pile = me.work[to.i];
  if (!pile) return 'No such pile';
  if (g.from.k === 'work') {
    if (g.from.i === to.i) return 'Already there';
    const whole = me.work[g.from.i]!.length === g.cards.length;
    if (whole && pile.length === 0) return 'Pointless move';
  }
  return stacksOn(card, top(pile)) ? g : 'Does not fit there';
}

/**
 * Every pile on which `seat` could legally put `cardId` (with any run on top
 * of it), going purely by the cards: it ignores whether the round is still on
 * or whose turn the grace window allows. Empty if the card cannot be picked up.
 */
export function legalDrops(state: GameState, seat: number, cardId: string): PileRef[] {
  const targets: PileRef[] = [
    ...Array.from({ length: WORK_PILES }, (_, i): PileRef => ({ k: 'work', i })),
    ...state.slots.map((_, i): PileRef => ({ k: 'slot', i })),
  ];
  return targets.filter((to) => typeof planMove(state, seat, cardId, to) !== 'string');
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
    work: old.work.map((w) => [...w]),
    down: [...old.down],
    stock: [...old.stock],
    waste: [...old.waste],
  };
  let next: GameState = state;

  switch (intent.k) {
    case 'flip': {
      if (me.stock.length === 0) {
        if (me.waste.length === 0) return 'Nothing to flip';
        me.stock = me.waste.reverse(); // turn the waste over: first card flipped is on top again
        me.waste = [];
      } else {
        for (let n = 0; n < FLIP_COUNT && me.stock.length > 0; n++) me.waste.push(me.stock.pop()!);
      }
      break;
    }
    case 'stuck': {
      me.stuck = intent.on;
      break;
    }
    case 'nertz': {
      if (me.nertz.length > 0) return 'Your nertz pile is not empty';
      me.holding = null; // the caller pressed a button, they are not dragging: the caller is never in grace
      next = { ...state, nertzCalledBy: seat };
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
      next = { ...state, slots: state.slots.map((s, i) => (i === intent.slot ? [] : s)), tray: [...state.tray, pile] };
      break;
    }
    case 'move': {
      const g = planMove(state, seat, intent.cardId, intent.to, intent.count);
      if (typeof g === 'string') return g;
      const { from, cards } = g;
      if (from.k === 'work') {
        const pile = me.work[from.i]!;
        pile.splice(-cards.length);
        // The face-up cards are gone: the next face-down card turns over. (On a redacted view its face stays unknown until the next snapshot.)
        const down = me.down[from.i]!;
        if (down > 0 && pile.length === down) me.down[from.i] = down - 1;
      } else {
        me[from.k].pop();
      }
      me.stuck = false;
      me.holding = null;
      const to = intent.to;
      if (to.k === 'work') me.work[to.i]!.push(...cards);
      else next = { ...state, slots: state.slots.map((s, i) => (i === to.i ? [...s, cards[0]!] : s)) };
      break;
    }
  }
  next = { ...next, players: state.players.map((p, i) => (i === index ? me : p)) };
  // A flip can bury the card being held; a hold never outlives the card being pickable.
  if (me.holding !== null && !grab(next, seat, me.holding)) me.holding = null;
  return next;
}

/**
 * Narrows the grace list to those of `candidates` who are holding a card that
 * still has somewhere legal to go, and takes the card out of everyone else's
 * hand (their drag is cancelled).
 */
function settleGrace(state: GameState, candidates: readonly number[]): GameState {
  const grace = state.players
    .filter((p) => candidates.includes(p.seat) && p.holding !== null && legalDrops(state, p.seat, p.holding).length > 0)
    .map((p) => p.seat);
  return { ...state, grace, players: state.players.map((p) => (grace.includes(p.seat) || p.holding === null ? p : { ...p, holding: null })) };
}

/** The deal is over (the server's deal timer fired): play opens. Same object if it already had. */
export function finishDeal(state: GameState): GameState {
  return state.dealing ? { ...state, dealing: false } : state;
}

/**
 * The one reducer. Pure, never throws (garbage intents and seats are rejected),
 * never mutates `state`. Works on redacted views too: face-down cards can be
 * flipped, recycled or uncovered, but can never be the subject or target of a move.
 *
 * Held-card grace: a `nertz` call freezes the table except for the seats that
 * are holding a card with at least one legal destination (`state.grace`).
 * Each of them may make exactly one more intent: a `move` of the held card, or
 * a `release`. Either takes them out of grace (a refused move too, see `refused`), and anyone else in grace whose
 * card now has nowhere to go is cut off with them. When `grace` is empty the
 * round is over and everything is rejected. While the cards are being dealt
 * (`state.dealing`) everything is rejected too.
 */
export function applyIntent(state: GameState, seat: number, rawIntent: Intent): Result {
  const intent = parseIntent(rawIntent);
  if (!intent) return fail('Malformed intent');
  const index = state.players.findIndex((p) => p.seat === seat);
  if (index < 0) return fail('Not playing in this round');
  if (state.dealing) return fail('The cards are still being dealt');
  const called = state.nertzCalledBy !== null;
  if (called) {
    if (!state.grace.includes(seat)) return fail('The round is over');
    const held = state.players[index]!.holding;
    if (intent.k !== 'release' && !(intent.k === 'move' && intent.cardId === held)) return fail('Only the held card may be played');
  }
  const next = play(state, index, intent);
  if (typeof next === 'string') return fail(next);
  if (called) return { ok: true, state: settleGrace(next, state.grace) };
  if (next.nertzCalledBy !== null) return { ok: true, state: settleGrace(next, next.players.map((p) => p.seat)) };
  return { ok: true, state: next };
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

/** Ends the grace window (the server's 4-second timer fired): everyone still in it is cut off. Same object if there is none. */
export function expireGrace(state: GameState): GameState {
  return state.grace.length === 0 ? state : settleGrace(state, []);
}

// ---------------------------------------------------------------- stuck

/**
 * If every seat in `activeSeats` (the connected players) has flagged "stuck",
 * unsticks the table: every player's waste is turned back onto their stock
 * (restoring the original order), then the top stock card moves to the bottom
 * so the next flips come up differently, and all flags clear. Returns the SAME
 * state object when nothing happens (always, once Nertz has been called).
 */
export function resolveStuck(state: GameState, activeSeats: Iterable<number>): GameState {
  if (state.nertzCalledBy !== null) return state;
  const active = new Set(activeSeats);
  const voters = state.players.filter((p) => active.has(p.seat));
  if (voters.length === 0 || !voters.every((p) => p.stuck)) return state;
  const players = state.players.map((p): PlayerState => {
    const stock = [...p.stock, ...p.waste.toReversed()];
    if (stock.length > 1) stock.unshift(stock.pop()!);
    // A held waste card has just gone back into the stock: it is no longer in hand.
    const holding = p.waste.some((c) => c.id === p.holding) ? null : p.holding;
    return { ...p, stock, waste: [], stuck: false, holding };
  });
  return { ...state, players };
}

// ---------------------------------------------------------------- views, scoring, invariants

const hide = (c: AnyCard): HiddenCard => (isHidden(c) ? c : { id: c.id, owner: c.owner, hidden: true });

/**
 * The state as a player may see it: same shape and same card ids, with every
 * face-down card redacted: stocks, everything under the top of each nertz pile
 * and the face-down cards at the bottom of each work pile, your own included.
 * While the cards are being dealt that is every card: nobody gets a head start.
 * No hand is private in Nertz, so today every seat gets the same view; `seat`
 * is kept so that can change without touching callers.
 */
export function viewFor(state: GameState, _seat: number): GameState {
  return {
    ...state,
    players: state.players.map((p) => ({
      ...p,
      nertz: p.nertz.map((c, i) => (i === p.nertz.length - 1 && !state.dealing ? c : hide(c))),
      work: p.work.map((w, i) => w.map((c, j) => (j < p.down[i]! || state.dealing ? hide(c) : c))),
      stock: p.stock.map(hide),
      waste: state.dealing ? p.waste.map(hide) : p.waste,
    })),
  };
}

/** Strictly: +1 per own card in the middle (centre slots and tray), -2 per card left in the nertz pile. */
export function scoreRound(state: GameState): RoundScore[] {
  const middle = [...state.slots, ...state.tray].flat();
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
    if (p.work.length !== WORK_PILES || p.down.length !== WORK_PILES) return `${at}: expected ${WORK_PILES} work piles`;
    if (p.nertz.length > NERTZ_SIZE) return `${at}: nertz pile too big`;
    const piles: [string, AnyCard[]][] = [['nertz', p.nertz], ['stock', p.stock], ['waste', p.waste]];
    p.work.forEach((w, i) => piles.push([`work ${i}`, w]));
    for (const [name, pile] of piles) {
      for (const c of pile) {
        const bad = count(c, `${at} ${name}`);
        if (bad) return bad;
        if (c.owner !== p.seat) return `${at} ${name}: holds a card owned by seat ${c.owner}`;
      }
    }
    for (const [i, w] of p.work.entries()) {
      const down = p.down[i]!;
      if (!Number.isInteger(down) || down < 0 || down > Math.max(0, w.length - 1)) return `${at} work ${i}: no face-up card on top`;
      // The face-up part must be a run. (A lone top card may be hidden in a predicted view: just turned over, face not yet sent.)
      for (let j = down + 1; j < w.length; j++) {
        const [below, above] = [w[j - 1]!, w[j]!];
        if (isHidden(below) || isHidden(above)) return `${at} work ${i}: face-down card`;
        if (!stacksOn(above, below)) return `${at} work ${i}: not a descending alternating run`;
      }
    }
    if (p.holding !== null && !grab(state, p.seat, p.holding)) return `${at}: holding a card they cannot pick up`;
  }
  if (state.slots.length !== SLOTS_PER_PLAYER * state.players.length) return 'wrong number of centre slots';
  const middle: [string, Card[]][] = [...state.slots.map((s, i): [string, Card[]] => [`slot ${i}`, s]), ...state.tray.map((s, i): [string, Card[]] => [`tray ${i}`, s])];
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
  if (state.nertzCalledBy !== null) {
    const caller = state.players.find((p) => p.seat === state.nertzCalledBy);
    if (!caller || caller.nertz.length > 0) return 'nertz called by a seat with cards left';
  }
  if (state.dealing && (state.nertzCalledBy !== null || middle.some(([, pile]) => pile.length > 0) || state.players.some((p) => p.holding !== null || p.waste.length > 0))) {
    return 'play began during the deal';
  }
  if (new Set(state.grace).size !== state.grace.length) return 'duplicate seat in grace';
  if (state.grace.length > 0 && state.nertzCalledBy === null) return 'grace without a nertz call';
  for (const seat of state.grace) {
    const p = state.players.find((p) => p.seat === seat);
    if (!p || p.holding === null || legalDrops(state, seat, p.holding).length === 0) return `seat ${seat}: in grace without a playable held card`;
  }
  if (state.nertzCalledBy !== null && state.players.some((p) => p.holding !== null && !state.grace.includes(p.seat))) {
    return 'a frozen player is holding a card';
  }
  return null;
}
