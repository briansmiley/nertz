// What the tests build their tables from: seeded generators, a round in play, a rigged hand, a pile in the middle, the
// intents, and a room as one window sees it. For tests only: imported by *.test.ts files and server/testkit.ts.
import { expect } from 'vitest';
import { deal, finishDeal, isHidden, openPlay, startCountdown, viewFor, type Rng } from './engine';
import { DEFAULT_SETTINGS } from './settings';
import type { Spot } from './table';
import type { AnyCard, Card, GameState, Intent, PileRef, RoomView, Suit } from './types';

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
  players: game.players.map((p) => ({ id: p.seat, seat: p.seat, name: `p${p.seat}`, connected: true, score: 0, rounds: 0, isHost: p.seat === 0, stuck: p.stuck, ending: false })),
  settings: DEFAULT_SETTINGS,
  game: viewFor(game, you),
  graceMs: null,
  dealMs: null,
  startMs: null,
  clock: null,
  paused: null,
  lastRound: null,
  ...extra,
});
