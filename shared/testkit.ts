// What the tests build their tables from: seeded generators, a round in play, a rigged hand, a pile in the middle, a
// whole table built by hand, the intents, and a room as one window sees it. For tests only: imported by *.test.ts files
// and server/testkit.ts.
import { expect } from 'vitest';
import { applyIntent, canDrop, checkInvariants, completedBy, deal, dealOn, DRAW_COUNT, finishDeal, grab, isComplete, isHidden, legalDrops, mustClear, openPlay, startCountdown, SUITS, viewFor, type Rng } from './engine';
import { PLAIN_LOOK } from './protocol';
import { DEFAULT_SETTINGS } from './settings';
import { MAX_PLAYERS } from './protocol';
import { openPlace, type Spot } from './table';
import type { AnyCard, Card, CentrePile, GameState, Intent, PileRef, PlayerState, RoomView, Suit, WorkPile } from './types';

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
      const cards = [...p.nertz, ...p.work.flatMap((w) => w.cards), ...p.stock, ...p.waste] as Card[];
      const take = (face: Face) => {
        const i = cards.findIndex(is(face));
        if (i < 0) throw new Error(`rig: no ${face} left in seat ${p.seat}'s hand`);
        return cards.splice(i, 1)[0]!;
      };
      const work = hand.work.map((f): WorkPile => ({ cards: [take(f)], down: 0 }));
      const waste = (hand.waste ?? []).map(take);
      const nertz = hand.emptyNertz?.includes(p.seat) ? [] : cards.splice(0, 13);
      return { ...p, work, nertz, stock: cards, waste, dealt: 0, holding: null };
    }),
  };
}

/** `suit` from rank `from` to rank `to`, one by one, as faces: run('S', 13, 1) is the spades from the King down to the Ace. */
export const run = (suit: Suit, from: number, to: number): Face[] =>
  Array.from({ length: Math.abs(from - to) + 1 }, (_, i) => `${suit}${from + (to < from ? -i : i)}` as Face);

/**
 * `g` with `seat`'s nertz pile exactly `faces`, bottom first (the last is its top), taken from its nertz pile and
 * stock; whatever else was in its nertz pile goes under its stock. A deal that leaves a run to be played out.
 */
export function nertzOf(g: GameState, seat: number, faces: readonly Face[]): GameState {
  return {
    ...g,
    players: g.players.map((p) => {
      if (p.seat !== seat) return p;
      const cards = [...p.nertz, ...p.stock] as Card[];
      const nertz = faces.map((face) => {
        const i = cards.findIndex(is(face));
        if (i < 0) throw new Error(`nertzOf: no ${face} in seat ${seat}'s nertz pile or stock`);
        return cards.splice(i, 1)[0]!;
      });
      return { ...p, nertz, stock: cards };
    }),
  };
}

/** `g` with `owner`'s `suit`, Ace up to `upTo`, taken from wherever it lies in their hand and lying in slot `i`. */
export function withPile(g: GameState, i: number, owner: number, suit: Suit, upTo: number, at: Spot = { x: 0, y: 0, r: 0 }): GameState {
  const p = g.players.find((q) => q.seat === owner)!;
  const mine = (c: AnyCard): c is Card => !isHidden(c) && c.suit === suit && c.rank <= upTo;
  const cards = [...p.nertz, ...p.work.flatMap((w) => w.cards), ...p.waste, ...p.stock].filter(mine).sort((a, b) => a.rank - b.rank);
  expect(cards).toHaveLength(upTo);
  const rest = <T extends AnyCard>(pile: T[]) => pile.filter((c) => !mine(c));
  return {
    ...g,
    players: g.players.map((q) => (q === p ? { ...q, nertz: rest(q.nertz), work: q.work.map((w) => ({ ...w, cards: rest(w.cards) })), waste: rest(q.waste), stock: rest(q.stock) } : q)),
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

/** Cards named by face, bottom first: 'C9 H6', or ['C9', 'H6']. */
type Faces = string | readonly string[];
/** A work pile by its cards, all face-up; or by its face-down cards and the face-up run on them. */
type WorkFaces = Faces | { down: Faces; up: Faces };
/** One seat at a table built by hand: each pile named bottom first. The cards not named go where `rest` says (under the stock by default). */
export interface Hand {
  nertz?: Faces;
  work?: readonly WorkFaces[];
  stock?: Faces;
  waste?: Faces;
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
    const workPile = (w: WorkFaces = []): WorkPile => {
      if (typeof w === 'string' || !('up' in w)) return { cards: cards(w, seat), down: 0 };
      const under = cards(w.down, seat);
      return { cards: [...under, ...cards(w.up, seat)], down: under.length };
    };
    const p = { nertz: cards(h.nertz, seat), work: [0, 1, 2, 3].map((i) => workPile(h.work?.[i])), stock: cards(h.stock, seat), waste: cards(h.waste, seat) };
    const named = new Set([...p.nertz, ...p.work.flatMap((w) => w.cards), ...p.stock, ...p.waste].map((c) => c.id));
    const left = SUITS.flatMap((s) => pile(`${s}13`, seat)).filter((c) => !named.has(c.id) && !middle.has(c.id));
    const under = h.rest ?? 'stock';
    if (under === 'stock') p.stock.unshift(...left);
    else {
      const w = p.work[under]!;
      p.work[under] = { cards: [...left, ...w.cards], down: w.down + left.length };
    }
    return { seat, ...p, dealt: 0, stuck: h.stuck ?? false, holding: null };
  });
  const state: GameState = { players, status: { at: 'play' }, slots: laid, tray: tray.map((t) => [...t]), reshuffles: 0, ...extra };
  expect(checkInvariants(state)).toBeNull();
  return state;
}

/** Work piles of these cards, every one face-up. */
export const upWork = (piles: readonly AnyCard[][]): WorkPile[] => piles.map((cards) => ({ cards, down: 0 }));
/** How many face-down cards each of `p`'s work piles has. */
export const downs = (p: PlayerState): number[] => p.work.map((w) => w.down);
/** What of `p`'s hand shows, or will once play opens: its nertz pile and the top of each work pile. */
export const faceUps = (p: PlayerState) => ({ seat: p.seat, nertz: p.nertz, tops: p.work.map((w) => w.cards.at(-1)) });

/** The top card of `seat`'s work pile `i`. */
export const workTop = (g: GameState, seat: number, i: number) => g.players.find((p) => p.seat === seat)!.work[i]!.cards.at(-1)!.id;

// ---------------------------------------------------------------- intents

/** `count` is the number of cards lifted: 1 unless a run is being moved. */
/** The server's timeline in random play: each group in flight takes its next step (`dealOn`), or not yet, by chance. */
export const stepDraws = (state: GameState, rng: Rng): GameState => state.players.reduce((s, p) => (rng() < 0.5 ? dealOn(s, p.seat) : s), state);
/**
 * `n` cards off `seat`'s stock as the server deals them: a draw starts a group and the server's steps (`dealOn`) deal
 * the rest; a group all dealt is turned up at once (its last step). On an empty stock (no group in flight) a draw turns
 * the waste over, which counts as one. Throws if a draw is refused.
 */
export function deals(state: GameState, seat: number, n = DRAW_COUNT): GameState {
  let s = state;
  for (let i = 0; i < n; i++) {
    const me = s.players.find((p) => p.seat === seat)!;
    if (me.dealt > 0) s = dealOn(s, seat);
    else {
      const r = applyIntent(s, seat, { k: 'draw' });
      if (!r.ok) throw new Error(`draw refused: ${r.reason}`);
      s = r.state;
    }
    const now = s.players.find((p) => p.seat === seat)!;
    if (now.dealt === DRAW_COUNT || (now.dealt > 0 && now.stock.length === 0)) s = dealOn(s, seat);
  }
  return s;
}
export const move = (cardId: string, to: PileRef, count = 1): Intent => ({ k: 'move', cardId, count, to });
export const slot = (i: number): PileRef => ({ k: 'slot', i });
export const work = (i: number): PileRef => ({ k: 'work', i });
export const felt = (x: number, y: number): Extract<PileRef, { k: 'felt' }> => ({ k: 'felt', x, y });
export const hold = (cardId: string): Intent => ({ k: 'hold', cardId });

// ---------------------------------------------------------------- random play

/** Every card in `s`, wherever it lies (hidden ones included). */
export const allCards = (s: GameState): AnyCard[] => [
  ...s.players.flatMap((p) => [...p.nertz, ...p.stock, ...p.waste, ...p.work.flatMap((w) => w.cards)]),
  ...s.slots.flatMap((pile) => pile?.cards ?? []),
  ...s.tray.flat(),
];

/** Every move `seat` may make right now, each card with the run on top of it to every place it may go. */
export function legalMoves(s: GameState, seat: number): Intent[] {
  const p = s.players.find((q) => q.seat === seat)!;
  const lifts = [p.nertz.at(-1), p.waste.at(-1), ...p.work.flatMap((w) => w.cards)].flatMap((card) => {
    const lift = card && grab(s, seat, card.id);
    return lift ? [{ id: card.id, count: lift.cards.length }] : [];
  });
  return lifts.flatMap(({ id, count }) => legalDrops(s, seat, id).filter((to) => canDrop(s, seat, id, to)).map((to) => move(id, to, count)));
}

/**
 * How often `randomIntent` sends each kind of intent, as weights. `legal` is a move the view says is legal (to the
 * middle mostly), `felt` one of one's own cards to a random point of the felt, `nonsense` any card at all to anywhere
 * (or a drag of it): almost always refused.
 */
export type Mix = Readonly<Record<'legal' | 'felt' | 'nonsense' | 'hold' | 'release' | 'draw' | 'stuck' | 'end' | 'nertz' | 'clear', number>>;

export const MIXES = {
  /** For the rules: as many drags, wrong moves and nonsense as plays. */
  wild: { legal: 26, felt: 3, nonsense: 14, hold: 18, release: 4, draw: 25, stuck: 4, end: 1, nertz: 5, clear: 4 },
  /** For a table: mostly play, so that rounds move on and the piles in the middle are fought over. No votes to end the round. */
  playing: { legal: 48, felt: 3, nonsense: 6, hold: 8, release: 4, draw: 20, stuck: 3, end: 0, nertz: 3, clear: 5 },
} as const satisfies Record<string, Mix>;

/**
 * What a careless, impatient, slightly dishonest player sends next, going by `view` (theirs, maybe stale, or the whole
 * state): an intent of a kind drawn from `mix`. Whatever the mix, someone with a finished pile waiting mostly clears it
 * (or play would lock up on clear-first), and someone mid-drag often finishes it first. Only looks at what is visible.
 */
export function randomIntent(view: GameState, seat: number, rng: Rng, mix: Mix): Intent {
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)]!;
  const point = () => Math.round((rng() * 2 - 1) * 1000) / 1000;
  const me = view.players.find((q) => q.seat === seat)!;
  if (mustClear(view, seat) && rng() < 0.7) return { k: 'clear', slot: view.slots.findIndex((pile) => completedBy(pile) === seat) };
  if (me.holding !== null && rng() < 0.4) {
    // On a legal spot (an Ace's one listed place mostly swapped for any point of the felt), back where it was, or on a pile at random.
    const drops = legalDrops(view, seat, me.holding);
    const roll = rng();
    if (drops.length && roll < 0.6) {
      const to = pick(drops);
      return move(me.holding, to.k === 'felt' && rng() < 0.8 ? felt(point(), point()) : to, grab(view, seat, me.holding)!.cards.length);
    }
    return roll < 0.85 ? { k: 'release' } : move(me.holding, slot(Math.floor(rng() * view.slots.length)));
  }
  const mine = [me.nertz.at(-1), me.waste.at(-1), ...me.work.flatMap((w) => w.cards)].filter((x) => x !== undefined);
  let roll = rng() * Object.values(mix).reduce((a, b) => a + b, 0);
  const kind = (Object.keys(mix) as (keyof Mix)[]).find((k) => (roll -= mix[k]) < 0) ?? 'draw';
  switch (kind) {
    case 'legal': {
      const legal = legalMoves(view, seat);
      const toCentre = legal.filter((m) => m.k === 'move' && m.to.k !== 'work');
      return legal.length ? pick(toCentre.length && rng() < 0.8 ? toCentre : legal) : { k: 'draw' };
    }
    case 'felt':
      return mine.length ? move(pick(mine).id, felt(point(), point())) : { k: 'draw' };
    case 'hold': {
      const playable = mine.filter((x) => grab(view, seat, x.id) && legalDrops(view, seat, x.id).length > 0);
      return mine.length ? hold(pick(playable.length && rng() < 0.8 ? playable : mine).id) : { k: 'release' };
    }
    case 'clear': {
      const full = view.slots.flatMap((pile, i) => (pile && isComplete(pile.cards) ? [i] : []));
      return { k: 'clear', slot: full.length && rng() < 0.9 ? pick(full) : Math.floor(rng() * 24) }; // (24: past every table's last slot)
    }
    case 'stuck':
    case 'end':
      return { k: kind, on: rng() < 0.6 };
    case 'release':
    case 'draw':
    case 'nertz':
      return { k: kind };
    case 'nonsense': {
      const everything = allCards(view);
      const own = everything.filter((x) => x.owner === seat);
      const card = rng() < 0.1 ? 'no-such-card' : pick(rng() < 0.8 && own.length ? own : everything).id;
      if (rng() < 0.15) return hold(card);
      const targets: PileRef[] = [slot(23), felt(point(), point()), ...view.slots.map((_, i) => slot(i)), ...[0, 1, 2, 3].map(work)];
      return move(card, pick(targets), 1 + Math.floor(rng() * 3));
    }
  }
}

/** The timeout of a long random run. Each is sized to take a few seconds on one slow core; this is room for a slower one, or a busy one. */
export const FUZZ_MS = 60_000;

/**
 * Runs `trial` on seeds 1, 2, 3, … until, between them, each goal has been reached as many times as `goals` says
 * (a list stands for once each), so that what a random run is meant to cover does not hang on a seed picked by hand.
 * Fails if the first `tries` seeds never get there. Each trial checks what it checks as it goes, and says what it
 * reached through `reached`.
 */
export function untilReached<G extends string>(goals: readonly G[] | Readonly<Record<G, number>>, tries: number, trial: (rng: Rng, reached: (goal: G) => void, seed: number) => void): void {
  const wanted = (Array.isArray(goals) ? Object.fromEntries(goals.map((g) => [g, 1])) : goals) as Record<G, number>;
  const seen = new Map<G, number>();
  const short = () => (Object.keys(wanted) as G[]).filter((g) => (seen.get(g) ?? 0) < wanted[g]);
  for (let seed = 1; seed <= tries; seed++) {
    trial(seeded(seed), (goal) => void seen.set(goal, (seen.get(goal) ?? 0) + 1), seed);
    if (short().length === 0) return;
  }
  expect(short(), `not reached in ${tries} seeds`).toEqual([]);
}

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
  players: game.players.map((p) => ({ id: p.seat, seat: p.seat, name: `p${p.seat}`, connected: true, score: 0, rounds: 0, calls: 0, isHost: p.seat === 0, look: PLAIN_LOOK })),
  settings: DEFAULT_SETTINGS,
  seats: { of: MAX_PLAYERS, taken: game.players.length },
  game: viewFor(game, you),
  timerMs: null,
  clock: null,
  paused: null,
  lastRound: null,
  ...extra,
});
