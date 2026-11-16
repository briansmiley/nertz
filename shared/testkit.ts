// What the tests build their tables from: seeded generators, a round in play, a rigged hand, a pile in the middle, a
// whole table built by hand, the intents, and a room as one window sees it. For tests only: imported by *.test.ts files
// and server/testkit.ts.
import { expect } from 'vitest';
import { checkInvariants, deal, finishDeal, isHidden, openPlay, startCountdown, SUITS, viewFor, type Rng } from './engine';
import { PLAIN_LOOK } from './protocol';
import { DEFAULT_SETTINGS } from './settings';
import { MAX_PLAYERS } from './protocol';
import { openPlace, type Spot } from './table';
import type { AnyCard, Card, CentrePile, GameState, Intent, PileRef, PlayerState, RoomView, Suit } from './types';

// ---------------------------------------------------------------- seeded generators
// Three, because the tests' seeds were picked against each: a seed found for one is just another seed for the others.

/** mulberry32. */
export function seeded(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A linear congruential generator (Numerical Recipes' constants). */
export function lcg(seed: number): Rng {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
}

/** Park and Miller's minimal standard generator. */
export function lehmer(seed: number): Rng {
  return () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
}

// ---------------------------------------------------------------- rounds

/** Seats 0 to `n` - 1. */
export const seats = (n: number): number[] => Array.from({ length: n }, (_, i) => i);
/** Walks a round through its opening to `play`: the deal over, the dealer's Start pressed, the count done. */
export const toPlay = (s: GameState): GameState => openPlay(startCountdown(finishDeal(s)));
/** A round dealt and in play. (The deal and the opening have their own tests.) */
export const inPlay = (seats: readonly number[], rng: Rng): GameState => toPlay(deal(seats, rng));

/** A card by suit and rank: 'S1' is the Ace of spades, 'D13' the King of diamonds. */
export type Face = `${Suit}${number}`;
const is = (face: Face) => (c: AnyCard): c is Card => !isHidden(c) && c.suit === face[0] && c.rank === Number(face.slice(1));

/**
 * `g` with every player's hand rigged: their work piles single face-up cards, the given four; the waste the given
 * cards; the nertz pile the next 13 of what is left (none for the seats in `emptyNertz`); the stock the rest.
 */
export function rig(g: GameState, hand: { work: [Face, Face, Face, Face]; waste?: Face[]; emptyNertz?: readonly number[] }): GameState {
  return {
    ...g,
    players: g.players.map((p) => {
      const cards = [...p.nertz, ...p.work.flat(), ...p.stock, ...p.waste] as Card[];
      const take = (face: Face) => {
        const i = cards.findIndex(is(face));
        if (i < 0) throw new Error(`rig: no ${face} left in seat ${p.seat}'s hand`);
        return cards.splice(i, 1)[0]!;
      };
      const work = hand.work.map((f) => [take(f)]);
      const waste = (hand.waste ?? []).map(take);
      const nertz = hand.emptyNertz?.includes(p.seat) ? [] : cards.splice(0, 13);
      return { ...p, work, down: [0, 0, 0, 0], nertz, stock: cards, waste, dealt: 0, holding: null };
    }),
  };
}

/** `g` with `owner`'s `suit`, Ace up to `upTo`, taken from wherever it lies in their hand and lying in slot `i`. */
export function withPile(g: GameState, i: number, owner: number, suit: Suit, upTo: number, at: Spot = { x: 0, y: 0, r: 0 }): GameState {
  const p = g.players.find((q) => q.seat === owner)!;
  const mine = (c: AnyCard): c is Card => !isHidden(c) && c.suit === suit && c.rank <= upTo;
  const cards = [...p.nertz, ...p.work.flat(), ...p.waste, ...p.stock].filter(mine).sort((a, b) => a.rank - b.rank);
  expect(cards).toHaveLength(upTo);
  const rest = <T extends AnyCard>(pile: T[]) => pile.filter((c) => !mine(c));
  return {
    ...g,
    players: g.players.map((q) => (q === p ? { ...q, nertz: rest(q.nertz), work: q.work.map(rest), waste: rest(q.waste), stock: rest(q.stock) } : q)),
    slots: g.slots.map((s, k) => (k === i ? { cards: [cards[0]!, ...cards.slice(1)], at } : s)),
  };
}

// ---------------------------------------------------------------- tables built by hand

const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

/**
 * A card of `owner`'s deck by suit and rank, the rank by number or by name: 'H5', 'SA' or 'S1', 'DK' or 'D13'. Its id
 * names it as it is called, after its owner: '0:H5', '0:SA', '0:DK'.
 */
export function card(face: string, owner = 0): Card {
  const suit = face[0] as Suit;
  const name = face.slice(1);
  const rank = RANKS.includes(name) ? RANKS.indexOf(name) + 1 : Number(name);
  if (!SUITS.includes(suit) || !Number.isInteger(rank) || rank < 1 || rank > 13) throw new Error(`no card ${face}`);
  return { id: `${owner}:${suit}${RANKS[rank - 1]}`, owner, suit, rank };
}
/** Cards by face, bottom first: 'C9 H6', or ['C9', 'H6']. */
export const cards = (faces: string | readonly string[] = [], owner = 0): Card[] =>
  (typeof faces === 'string' ? faces.split(' ').filter(Boolean) : faces).map((f) => card(f, owner));
/** A pile for the middle: `owner`'s Ace of the suit of `top`, up to `top`. */
export const pile = (top: string, owner = 0): Card[] => Array.from({ length: card(top).rank }, (_, r) => card(`${top[0]}${r + 1}`, owner));

/** One seat at a table built by hand: each pile named bottom first. The cards not named go where `rest` says (under the stock by default). */
export interface Hand {
  nertz?: string | readonly string[];
  work?: readonly (string | readonly string[])[];
  down?: readonly number[];
  stock?: string | readonly string[];
  waste?: string | readonly string[];
  stuck?: boolean;
  /** Where the cards not named lie: under the stock (the default), or face-down under work pile `i` (one with cards named in it). */
  rest?: 'stock' | number;
}
/** A pile in the middle: the cards, wherever there is room (the middle first), or lying at a given point. */
export type Laid = readonly Card[] | { cards: readonly Card[]; x: number; y: number } | null;

/**
 * A whole round in play, seat `i` holding `hands[i]`: the piles each hand names, `slots` and `tray` in the middle, and
 * every card of every deck somewhere, so it passes `checkInvariants` (it fails here if it does not).
 */
export function table(hands: readonly Hand[], { slots = [], tray = [], ...extra }: { slots?: readonly Laid[]; tray?: readonly Card[][] } & Partial<Omit<GameState, 'players' | 'slots' | 'tray'>> = {}): GameState {
  const n = hands.length;
  if (slots.length > 4 * n) throw new Error(`table: ${slots.length} slots for ${n} seats (at most ${4 * n})`);
  const placed: Spot[] = [];
  const laid = Array.from({ length: 4 * n }, (_, i): CentrePile | null => {
    const s = slots[i] ?? null;
    const [ace, ...more] = s === null ? [] : 'cards' in s ? s.cards : s;
    if (!ace) return null;
    const at = s !== null && 'x' in s ? { x: s.x, y: s.y, r: 0 } : { ...openPlace(placed, n)!, r: 0 };
    placed.push(at);
    return { cards: [ace, ...more], at };
  });
  const middle = new Set([...laid.flatMap((p) => p?.cards ?? []), ...tray.flat()].map((c) => c.id));
  const players = hands.map((h, seat): PlayerState => {
    const p = { nertz: cards(h.nertz, seat), work: [0, 1, 2, 3].map((i) => cards(h.work?.[i], seat)), stock: cards(h.stock, seat), waste: cards(h.waste, seat) };
    const named = new Set([...p.nertz, ...p.work.flat(), ...p.stock, ...p.waste].map((c) => c.id));
    const left = SUITS.flatMap((s) => pile(`${s}13`, seat)).filter((c) => !named.has(c.id) && !middle.has(c.id));
    const down = [0, 1, 2, 3].map((i) => h.down?.[i] ?? 0);
    const under = h.rest ?? 'stock';
    if (under === 'stock') p.stock.unshift(...left);
    else {
      p.work[under]!.unshift(...left);
      down[under] = down[under]! + left.length;
    }
    return { seat, ...p, down, dealt: 0, stuck: h.stuck ?? false, holding: null };
  });
  const state: GameState = { players, status: { at: 'play' }, slots: laid, tray: tray.map((t) => [...t]), ...extra };
  expect(checkInvariants(state)).toBeNull();
  return state;
}

/** The top card of `seat`'s work pile `i`. */
export const workTop = (g: GameState, seat: number, i: number) => g.players.find((p) => p.seat === seat)!.work[i]!.at(-1)!.id;

// ---------------------------------------------------------------- intents

/** `count` is the number of cards lifted: 1 unless a run is being moved. */
export const move = (cardId: string, to: PileRef, count = 1): Intent => ({ k: 'move', cardId, count, to });
export const slot = (i: number): PileRef => ({ k: 'slot', i });
export const work = (i: number): PileRef => ({ k: 'work', i });
export const felt = (x: number, y: number): Extract<PileRef, { k: 'felt' }> => ({ k: 'felt', x, y });
export const hold = (cardId: string): Intent => ({ k: 'hold', cardId });

// ---------------------------------------------------------------- the wire

/** `v` as it arrives over the wire. */
export const wire = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** The room as `you` see it in the middle of `game`: everyone connected, nothing on the clocks. */
export const roomOf = (game: GameState, you: number, extra: Partial<RoomView> = {}): RoomView => ({
  code: 'ABCD',
  phase: 'playing',
  round: 1,
  me: you,
  seat: you,
  players: game.players.map((p) => ({ id: p.seat, seat: p.seat, name: `p${p.seat}`, connected: true, score: 0, rounds: 0, isHost: p.seat === 0, look: PLAIN_LOOK })),
  settings: DEFAULT_SETTINGS,
  seats: { of: MAX_PLAYERS, taken: game.players.length },
  game: viewFor(game, you),
  timerMs: null,
  clock: null,
  paused: null,
  lastRound: null,
  ...extra,
});
