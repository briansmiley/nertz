// Nertz rules engine. Pure: no IO, no clock, no Math.random (the RNG is injected
// into `deal`). The server runs it on the full state; the client runs the very
// same reducer on its redacted view to predict its own moves.
//
// Pile convention: the TOP of every pile is the LAST array element.
import { parseIntent, WORK_PILES } from './protocol';
import type { AnyCard, Card, Foundation, GameState, HiddenCard, Intent, PileRef, PlayerState, RoundScore, Suit } from './types';

export { WORK_PILES };
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
export const isComplete = (f: Foundation): boolean => f.cards.length === KING;
const top = <T>(pile: readonly T[]): T | undefined => pile[pile.length - 1];

// ---------------------------------------------------------------- dealing

/** Deals a fresh round: one shuffled 52-card deck per seat, with opaque random card ids. */
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
    const workStart = NERTZ_SIZE;
    const stockStart = NERTZ_SIZE + WORK_PILES;
    return {
      seat,
      nertz: deck.slice(0, workStart),
      work: deck.slice(workStart, stockStart).map((c) => [c]),
      stock: deck.slice(stockStart),
      waste: [],
      stuck: false,
    };
  });
  return { players, foundations: [], nertzCalledBy: null };
}

// ---------------------------------------------------------------- legality

/** Can `card` go on a work pile whose top is `onto` (undefined = empty pile)? One rank down, opposite colour. */
function stacksOn(card: Card, onto: AnyCard | undefined): boolean {
  if (!onto) return true;
  return !isHidden(onto) && card.rank === onto.rank - 1 && isRed(card.suit) !== isRed(onto.suit);
}

const foundationAccepts = (f: Foundation, card: Card): boolean => f.suit === card.suit && f.cards.length === card.rank - 1;

function bestFoundationFor(state: GameState, card: Card): PileRef | null {
  if (card.rank === 1) return { k: 'newFoundation' };
  const f = state.foundations.find((f) => foundationAccepts(f, card));
  return f ? { k: 'foundation', id: f.id } : null;
}

function findCard(state: GameState, cardId: string): AnyCard | undefined {
  for (const p of state.players) {
    for (const pile of [p.nertz, p.waste, p.stock, ...p.work]) {
      const c = pile.find((c) => c.id === cardId);
      if (c) return c;
    }
  }
  for (const f of state.foundations) {
    const c = f.cards.find((c) => c.id === cardId);
    if (c) return c;
  }
  return undefined;
}

/**
 * What `seat` would pick up by grabbing `cardId`: the top of their nertz pile
 * or waste, or a card in one of their work piles together with everything on
 * top of it. Null if the card is not theirs to move or is face-down.
 */
export function grab(state: GameState, seat: number, cardId: string): Grab | null {
  const p = state.players.find((p) => p.seat === seat);
  if (!p) return null;
  const lift = (from: Source, cards: AnyCard[]): Grab | null => (cards.some(isHidden) ? null : { from, cards: cards as Card[] });
  if (top(p.nertz)?.id === cardId) return lift({ k: 'nertz' }, p.nertz.slice(-1));
  if (top(p.waste)?.id === cardId) return lift({ k: 'waste' }, p.waste.slice(-1));
  for (const [i, pile] of p.work.entries()) {
    const at = pile.findIndex((c) => c.id === cardId);
    if (at >= 0) return lift({ k: 'work', i }, pile.slice(at));
  }
  return null;
}

/** The foundation `cardId` could be played to right now (a new one for an Ace), ignoring whose card it is. */
export function bestFoundation(state: GameState, cardId: string): PileRef | null {
  const card = findCard(state, cardId);
  return card && !isHidden(card) ? bestFoundationFor(state, card) : null;
}

interface Plan {
  player: number; // index into state.players
  grab: Grab;
  to: PileRef;
}

/**
 * Validates a move and resolves its real destination. With `strict` the named
 * target itself must accept the card; otherwise a foundation move falls back
 * to any foundation that accepts it (someone may have beaten us to the one we
 * aimed at). Returns the plan, or the reason it is illegal.
 */
function planMove(state: GameState, seat: number, cardId: string, to: PileRef, strict: boolean): Plan | string {
  const player = state.players.findIndex((p) => p.seat === seat);
  const g = grab(state, seat, cardId);
  if (player < 0 || !g) return 'That card cannot be moved';
  const card = g.cards[0]!;
  if (to.k === 'work') {
    const pile = state.players[player]!.work[to.i];
    if (!pile) return 'No such pile';
    if (g.from.k === 'work') {
      if (g.from.i === to.i) return 'Already there';
      const whole = state.players[player]!.work[g.from.i]!.length === g.cards.length;
      if (whole && pile.length === 0) return 'Pointless move';
    }
    return stacksOn(card, top(pile)) ? { player, grab: g, to } : 'Does not fit there';
  }
  if (g.cards.length > 1) return 'Only single cards go to the foundations';
  const exact = to.k === 'newFoundation' ? card.rank === 1 : state.foundations.some((f) => f.id === to.id && foundationAccepts(f, card));
  const target = exact ? to : strict ? null : bestFoundationFor(state, card);
  return target ? { player, grab: g, to: target } : 'No foundation takes that card';
}

/**
 * Would dropping `cardId` (and any run on top of it) on exactly `to` be legal
 * for `seat`? Strict: no foundation fallback, so it is suitable for
 * highlighting drop targets. `applyIntent` itself is more forgiving.
 */
export function canDrop(state: GameState, seat: number, cardId: string, to: PileRef): boolean {
  return state.nertzCalledBy === null && typeof planMove(state, seat, cardId, to, true) !== 'string';
}

// ---------------------------------------------------------------- reducer

const clonePlayer = (p: PlayerState): PlayerState => ({
  ...p,
  nertz: [...p.nertz],
  work: p.work.map((w) => [...w]),
  stock: [...p.stock],
  waste: [...p.waste],
});

const fail = (reason: string): Result => ({ ok: false, reason });

/**
 * The one reducer. Pure, never throws (garbage intents and seats are rejected),
 * never mutates `state`. Works on redacted views too: face-down cards can be
 * flipped, recycled or uncovered, but can never be the subject or target of a move.
 */
export function applyIntent(state: GameState, seat: number, rawIntent: Intent): Result {
  const intent = parseIntent(rawIntent);
  if (!intent) return fail('Malformed intent');
  if (state.nertzCalledBy !== null) return fail('The round is over');
  const index = state.players.findIndex((p) => p.seat === seat);
  if (index < 0) return fail('Not playing in this round');
  const me = clonePlayer(state.players[index]!);
  const done = (patch: Partial<GameState> = {}): Result => ({
    ok: true,
    state: { ...state, ...patch, players: state.players.map((p, i) => (i === index ? me : p)) },
  });

  switch (intent.k) {
    case 'flip': {
      if (me.stock.length === 0) {
        if (me.waste.length === 0) return fail('Nothing to flip');
        me.stock = me.waste.reverse(); // turn the waste over: first card flipped is on top again
        me.waste = [];
      } else {
        for (let n = 0; n < FLIP_COUNT && me.stock.length > 0; n++) me.waste.push(me.stock.pop()!);
      }
      return done();
    }
    case 'stuck': {
      me.stuck = intent.on;
      return done();
    }
    case 'nertz': {
      if (me.nertz.length > 0) return fail('Your nertz pile is not empty');
      return done({ nertzCalledBy: seat });
    }
    case 'move': {
      const plan = planMove(state, seat, intent.cardId, intent.to, false);
      if (typeof plan === 'string') return fail(plan);
      const { from, cards } = plan.grab;
      if (from.k === 'work') me.work[from.i]!.splice(-cards.length);
      else me[from.k].pop();
      me.stuck = false;
      const to = plan.to;
      if (to.k === 'work') {
        me.work[to.i]!.push(...cards);
        return done();
      }
      const card = cards[0]!;
      const foundations =
        to.k === 'newFoundation'
          ? [...state.foundations, { id: card.id, suit: card.suit, cards: [card] }]
          : state.foundations.map((f) => (f.id === to.id ? { ...f, cards: [...f.cards, card] } : f));
      return done({ foundations });
    }
  }
}

// ---------------------------------------------------------------- stuck

/**
 * If every seat in `activeSeats` (the connected players) has flagged "stuck",
 * unsticks the table: every player's waste is turned back onto their stock
 * (restoring the original order), then the top stock card moves to the bottom
 * so the next flips come up differently, and all flags clear. Returns the SAME
 * state object when nothing happens.
 */
export function resolveStuck(state: GameState, activeSeats: Iterable<number>): GameState {
  if (state.nertzCalledBy !== null) return state;
  const active = new Set(activeSeats);
  const voters = state.players.filter((p) => active.has(p.seat));
  if (voters.length === 0 || !voters.every((p) => p.stuck)) return state;
  const players = state.players.map((p): PlayerState => {
    const stock = [...p.stock, ...p.waste.toReversed()];
    if (stock.length > 1) stock.unshift(stock.pop()!);
    return { ...p, stock, waste: [], stuck: false };
  });
  return { ...state, players };
}

// ---------------------------------------------------------------- views, scoring, invariants

const hide = (c: AnyCard): HiddenCard => (isHidden(c) ? c : { id: c.id, owner: c.owner, hidden: true });

/**
 * The state as a player may see it: same shape and same card ids, with stocks
 * (including your own) and everything under the top of each nertz pile
 * redacted. No hand is private in Nertz, so today every seat gets the same
 * view; `seat` is kept so that can change without touching callers.
 */
export function viewFor(state: GameState, _seat: number): GameState {
  return {
    ...state,
    players: state.players.map((p) => ({
      ...p,
      nertz: p.nertz.map((c, i) => (i === p.nertz.length - 1 ? c : hide(c))),
      stock: p.stock.map(hide),
    })),
  };
}

/** +1 per own card in the foundations, -2 per card left in the nertz pile. */
export function scoreRound(state: GameState): RoundScore[] {
  return state.players.map((p) => {
    const foundation = state.foundations.reduce((n, f) => n + f.cards.filter((c) => c.owner === p.seat).length, 0);
    const nertzLeft = p.nertz.length;
    return { seat: p.seat, foundation, nertzLeft, delta: foundation - 2 * nertzLeft };
  });
}

/**
 * Returns null if the state is well-formed, otherwise a description of the
 * first problem. Checks that every card of every deck is present exactly once
 * and that every pile has a legal shape. Hidden cards (in a view) are counted
 * but their faces are not checked.
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
    p.work.forEach((w, i) => piles.push([`work ${i}`, w]));
    for (const [name, pile] of piles) {
      for (const c of pile) {
        const bad = count(c, `${at} ${name}`);
        if (bad) return bad;
        if (c.owner !== p.seat) return `${at} ${name}: holds a card owned by seat ${c.owner}`;
      }
    }
    for (const [i, w] of p.work.entries()) {
      for (let j = 1; j < w.length; j++) {
        const [below, above] = [w[j - 1]!, w[j]!];
        if (isHidden(below) || isHidden(above)) return `${at} work ${i}: face-down card`;
        if (!stacksOn(above, below)) return `${at} work ${i}: not a descending alternating run`;
      }
    }
  }
  const foundationIds = new Set<string>();
  for (const f of state.foundations) {
    if (foundationIds.has(f.id)) return `duplicate foundation ${f.id}`;
    foundationIds.add(f.id);
    if (f.cards.length < 1 || f.cards.length > KING) return `foundation ${f.id}: bad size`;
    if (f.cards[0]!.id !== f.id) return `foundation ${f.id}: id is not its ace`;
    for (const [j, c] of f.cards.entries()) {
      const bad = count(c, `foundation ${f.id}`);
      if (bad) return bad;
      if (isHidden(c) || c.suit !== f.suit || c.rank !== j + 1) return `foundation ${f.id}: not ace-up in suit`;
    }
  }
  for (const seat of seats) {
    if (perOwner.get(seat) !== DECK_SIZE) return `seat ${seat}: has ${perOwner.get(seat) ?? 0} cards, expected ${DECK_SIZE}`;
  }
  if (state.nertzCalledBy !== null) {
    const caller = state.players.find((p) => p.seat === state.nertzCalledBy);
    if (!caller || caller.nertz.length > 0) return 'nertz called by a seat with cards left';
  }
  return null;
}
