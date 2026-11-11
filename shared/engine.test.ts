import { describe, expect, it } from 'vitest';
import {
  applyIntent,
  canDrop,
  checkInvariants,
  completedBy,
  deal as dealRound,
  expireGrace,
  finishDeal,
  grab,
  isComplete,
  isHidden,
  isOver,
  legalDrops,
  refused,
  resolveStuck,
  scoreRound,
  viewFor,
  type Result,
  type Rng,
} from './engine';
import type { AnyCard, Card, GameState, Intent, PileRef, PlayerState, Suit } from './types';

// ---------------------------------------------------------------- helpers

/** A round in play: dealt, and the deal over. (The deal itself has its own tests.) */
const deal = (seats: readonly number[], rng: () => number): GameState => finishDeal(dealRound(seats, rng));

function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

/** c('H5') is seat 0's five of hearts; its id is '0:H5'. */
function c(face: string, owner = 0): Card {
  const rank = RANKS.indexOf(face.slice(1)) + 1;
  if (rank < 1) throw new Error(`bad face ${face}`);
  return { id: `${owner}:${face}`, owner, suit: face[0] as Suit, rank };
}
const cs = (faces: string, owner = 0): Card[] => (faces ? faces.split(' ').map((f) => c(f, owner)) : []);

const player = (seat: number, parts: Partial<PlayerState> = {}): PlayerState => ({
  seat,
  nertz: [],
  work: [[], [], [], []],
  down: [0, 0, 0, 0],
  stock: [],
  waste: [],
  stuck: false,
  holding: null,
  ...parts,
});

/** A centre pile built from its ace up to `topFace`, all cards owned by `owner`. */
function pile(topFace: string, owner = 0): Card[] {
  const n = RANKS.indexOf(topFace.slice(1)) + 1;
  return RANKS.slice(0, n).map((r) => c(topFace[0] + r, owner));
}

/** A round with the given centre piles in slots 0, 1, ... and the rest of the 4-per-player slots empty. */
const game = (players: PlayerState[], piles: Card[][] = [], extra: Partial<GameState> = {}): GameState => ({
  players,
  dealing: false,
  slots: Array.from({ length: 4 * players.length }, (_, i) => piles[i] ?? []),
  tray: [],
  nertzCalledBy: null,
  grace: [],
  ...extra,
});
/** `count` is the number of cards lifted: 1 unless a run is being moved. */
const move = (cardId: string, to: PileRef, count = 1): Intent => ({ k: 'move', cardId, count, to });
const work = (i: number): PileRef => ({ k: 'work', i });
const slot = (i: number): PileRef => ({ k: 'slot', i });
const hold = (cardId: string): Intent => ({ k: 'hold', cardId });
const RELEASE: Intent = { k: 'release' };
const NERTZ: Intent = { k: 'nertz' };
const ids = (pile: AnyCard[]) => pile.map((x) => x.id);

function ok(r: Result): GameState {
  if (!r.ok) throw new Error(`expected ok, got: ${r.reason}`);
  return r.state;
}
const rejected = (r: Result) => expect(r.ok).toBe(false);
/** Applies intents in order, each as [seat, intent]; all must be accepted. */
const run = (s: GameState, ...steps: [number, Intent][]): GameState => steps.reduce((st, [seat, intent]) => ok(applyIntent(st, seat, intent)), s);

function deepFreeze<T>(v: T): T {
  if (typeof v === 'object' && v !== null && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const x of Object.values(v)) deepFreeze(x);
  }
  return v;
}

const allCards = (s: GameState): AnyCard[] => [
  ...s.players.flatMap((p) => [...p.nertz, ...p.stock, ...p.waste, ...p.work.flat()]),
  ...s.slots.flat(),
  ...s.tray.flat(),
];

// ---------------------------------------------------------------- the deal as a phase

describe('dealing', () => {
  const fresh = deepFreeze(dealRound([0, 1, 2], mulberry32(21)));
  const everyIntent = (s: GameState, seat: number): Intent[] => {
    const p = s.players.find((q) => q.seat === seat)!;
    const tops = [p.nertz.at(-1)!, ...p.work.map((w) => w.at(-1)!)];
    return [
      { k: 'flip' },
      { k: 'stuck', on: true },
      { k: 'stuck', on: false },
      { k: 'nertz' },
      { k: 'release' },
      { k: 'clear', slot: 0 },
      ...tops.map((c) => hold(c.id)),
      ...tops.flatMap((c) => [move(c.id, work(0)), move(c.id, work(3)), move(c.id, slot(0))]),
    ];
  };

  it('a fresh deal is still being dealt: every intent from every seat is refused and changes nothing', () => {
    expect(fresh.dealing).toBe(true);
    expect(checkInvariants(fresh)).toBeNull();
    for (const seat of [0, 1, 2]) {
      for (const intent of everyIntent(fresh, seat)) {
        const r = applyIntent(fresh, seat, intent);
        expect(r).toEqual({ ok: false, reason: 'The cards are still being dealt' });
        expect(refused(fresh, seat, intent)).toBe(fresh);
        expect(canDrop(fresh, seat, intent.k === 'move' ? intent.cardId : 'x', slot(0))).toBe(false);
      }
    }
    expect(resolveStuck(fresh, [0, 1, 2])).toBe(fresh);
    expect(expireGrace(fresh)).toBe(fresh);
    expect(isOver(fresh)).toBe(false);
  });

  it('shows nobody a single face until the deal is over, their own cards included; ids, owners and shape stay put', () => {
    for (const seat of [0, 1, 2, 7]) {
      const view = viewFor(fresh, seat);
      expect(view.dealing).toBe(true);
      expect(allCards(view)).toHaveLength(3 * 52);
      expect(allCards(view).every(isHidden)).toBe(true);
      expect(JSON.stringify(view)).not.toMatch(/suit|rank/);
      expect(allCards(view).map((x) => [x.id, x.owner])).toEqual(allCards(fresh).map((x) => [x.id, x.owner]));
      expect(view.players.map((p) => [p.nertz.length, p.work.map((w) => w.length), p.down, p.stock.length])).toEqual(
        fresh.players.map((p) => [p.nertz.length, p.work.map((w) => w.length), p.down, p.stock.length]),
      );
      expect(checkInvariants(view)).toBeNull();
      // The reducer refuses on the view exactly as on the full state, so a client predicts nothing during the deal.
      for (const intent of everyIntent(view, 0)) rejected(applyIntent(view, 0, intent));
    }
  });

  it('finishDeal opens play without touching a card, for every seat at once, and only once', () => {
    const open = finishDeal(fresh);
    expect(open).toEqual({ ...fresh, dealing: false });
    expect(finishDeal(open)).toBe(open);
    expect(checkInvariants(open)).toBeNull();
    for (const seat of [0, 1, 2]) {
      // The same ids, now with the face-up cards showing: the nertz top and the four work tops of every player.
      const view = viewFor(open, seat);
      expect(ids(allCards(view))).toEqual(ids(allCards(viewFor(fresh, seat))));
      for (const p of view.players) expect([...p.nertz, ...p.work.flat(), ...p.stock].filter((x) => !isHidden(x))).toHaveLength(5);
      ok(applyIntent(open, seat, { k: 'flip' }));
      ok(applyIntent(view, seat, hold(view.players.find((p) => p.seat === seat)!.nertz.at(-1)!.id)));
    }
  });

  it('checkInvariants rejects a deal during which something was played', () => {
    const played = ok(applyIntent(finishDeal(fresh), 0, { k: 'flip' }));
    expect(checkInvariants({ ...played, dealing: true })).toMatch(/during the deal/);
  });
});

// ---------------------------------------------------------------- deal

describe('deal', () => {
  const state = deal([0, 1, 2], mulberry32(1));

  it('gives every seat 13 nertz, work piles with 0, 1, 2 and 3 cards face-down under one face-up, 29 stock and an empty waste', () => {
    expect(state.players.map((p) => p.seat)).toEqual([0, 1, 2]);
    for (const p of state.players) {
      expect(p.nertz).toHaveLength(13);
      expect(p.work.map((w) => w.length)).toEqual([1, 2, 3, 4]);
      expect(p.down).toEqual([0, 1, 2, 3]);
      expect(p.work.flat()).toHaveLength(10);
      expect(p.stock).toHaveLength(29);
      expect(p.waste).toHaveLength(0);
      expect(p.stuck).toBe(false);
      expect(p.holding).toBeNull();
      const faces = new Set([...p.nertz, ...p.stock, ...p.work.flat()].map((x) => (isHidden(x) ? '?' : `${x.suit}${x.rank}`)));
      expect(faces.size).toBe(52);
    }
    expect(state.slots).toEqual(Array.from({ length: 12 }, () => [])); // 4 slots per player
    expect(deal([4, 9], mulberry32(1)).slots).toHaveLength(8);
    expect(state.tray).toEqual([]);
    expect(state.nertzCalledBy).toBeNull();
    expect(state.grace).toEqual([]);
    expect(isOver(state)).toBe(false);
    expect(checkInvariants(state)).toBeNull();
  });

  it('uses unique opaque ids that do not encode the face', () => {
    const cards = allCards(state) as Card[];
    expect(new Set(cards.map((x) => x.id)).size).toBe(156);
    for (const x of cards) expect(x.id).toMatch(/^[a-z0-9]{8}$/);
    // Same seed, same shuffle but the ids are unrelated to suit/rank: sorting by id does not sort by face.
    const byId = [...cards].sort((a, b) => a.id.localeCompare(b.id)).map((x) => x.rank);
    const sorted = [...byId].sort((a, b) => a - b);
    expect(byId).not.toEqual(sorted);
  });

  it('is deterministic for a given rng and different across seeds and seats', () => {
    expect(deal([0, 1], mulberry32(7))).toEqual(deal([0, 1], mulberry32(7)));
    expect(deal([0, 1], mulberry32(7))).not.toEqual(deal([0, 1], mulberry32(8)));
    const [a, b] = deal([0, 1], mulberry32(7)).players;
    expect(a!.nertz.map((x) => (x as Card).rank)).not.toEqual(b!.nertz.map((x) => (x as Card).rank));
  });

  it('survives a degenerate rng', () => {
    expect(checkInvariants(deal([0, 1], () => 0.999999999))).toBeNull();
    expect(checkInvariants(deal([3, 5], () => 1))).toBeNull();
  });
});

// ---------------------------------------------------------------- work pile moves

describe('work pile moves', () => {
  it('nertz top goes onto a work pile one rank up of the other colour and uncovers the next card', () => {
    const s = game([player(0, { nertz: cs('C9 H6'), work: [cs('S7'), cs('D7'), cs('H7'), []] })]);
    const next = ok(applyIntent(s, 0, move('0:H6', work(0))));
    expect(ids(next.players[0]!.nertz)).toEqual(['0:C9']);
    expect(ids(next.players[0]!.work[0]!)).toEqual(['0:S7', '0:H6']);
    rejected(applyIntent(s, 0, move('0:H6', work(1)))); // same colour
    rejected(applyIntent(s, 0, move('0:H6', work(2)))); // same suit
    ok(applyIntent(s, 0, move('0:H6', work(3)))); // empty pile takes anything
  });

  it('rejects wrong ranks and buried nertz cards', () => {
    const s = game([player(0, { nertz: cs('C9 H6'), work: [cs('S8'), cs('S6'), cs('S5'), cs('D10')] })]);
    for (const i of [0, 1, 2, 3]) rejected(applyIntent(s, 0, move('0:H6', work(i))));
    rejected(applyIntent(s, 0, move('0:C9', work(3)))); // legal fit, but not the top of the nertz pile
  });

  it('waste top can be played, buried waste and stock cards cannot', () => {
    const s = game([player(0, { waste: cs('H4 C3'), stock: cs('C2'), work: [cs('D4'), cs('S5'), cs('D3'), []] })]);
    const next = ok(applyIntent(s, 0, move('0:C3', work(0))));
    expect(ids(next.players[0]!.waste)).toEqual(['0:H4']);
    rejected(applyIntent(s, 0, move('0:H4', work(1))));
    rejected(applyIntent(s, 0, move('0:C2', work(2))));
  });

  it('moves a run (any suffix) between work piles, keeping its order', () => {
    const s = game([player(0, { work: [cs('S9 H8 C7 D6'), cs('C9'), cs('H7'), []] })]);
    const a = ok(applyIntent(s, 0, move('0:H8', work(1), 3)));
    expect(ids(a.players[0]!.work[0]!)).toEqual(['0:S9']);
    expect(ids(a.players[0]!.work[1]!)).toEqual(['0:C9', '0:H8', '0:C7', '0:D6']);
    const b = ok(applyIntent(s, 0, move('0:C7', work(3), 2)));
    expect(ids(b.players[0]!.work[0]!)).toEqual(['0:S9', '0:H8']);
    expect(ids(b.players[0]!.work[3]!)).toEqual(['0:C7', '0:D6']);
    rejected(applyIntent(s, 0, move('0:C7', work(1), 2))); // 7 on 9
    rejected(applyIntent(s, 0, move('0:D6', work(2)))); // red on red
    rejected(applyIntent(s, 0, move('0:H8', work(0), 3))); // onto itself
    expect(grab(s, 0, '0:C7')).toEqual({ from: { k: 'work', i: 0 }, cards: cs('C7 D6') });
  });

  it('refuses the pointless move of a whole pile onto an empty pile', () => {
    const s = game([player(0, { work: [cs('S9 H8'), [], cs('H10'), []] })]);
    rejected(applyIntent(s, 0, move('0:S9', work(1), 2)));
    expect(canDrop(s, 0, '0:S9', work(1))).toBe(false);
    ok(applyIntent(s, 0, move('0:H8', work(1))));
    ok(applyIntent(s, 0, move('0:S9', work(2), 2)));
  });

  it("never lets a seat move another seat's cards, or cards onto another seat's piles", () => {
    const s = game([player(0, { work: [cs('S9'), [], [], []] }), player(1, { nertz: cs('H8', 1), work: [cs('C9', 1), [], [], []] })]);
    rejected(applyIntent(s, 0, move('1:H8', work(0))));
    expect(grab(s, 0, '1:H8')).toBeNull();
    // seat 1 playing to work(0) lands on seat 1's own pile, not seat 0's
    const next = ok(applyIntent(s, 1, move('1:H8', work(0))));
    expect(ids(next.players[1]!.work[0]!)).toEqual(['1:C9', '1:H8']);
    expect(next.players[0]).toBe(s.players[0]);
    rejected(applyIntent(s, 7, move('1:H8', work(0)))); // seat not in the round
  });

  it('rejects unknown cards and out-of-range piles', () => {
    const s = game([player(0, { nertz: cs('H6') })]);
    rejected(applyIntent(s, 0, move('nope', work(0))));
    rejected(applyIntent(s, 0, move('0:H6', work(4))));
    rejected(applyIntent(s, 0, move('0:H6', work(-1))));
  });
});

// ---------------------------------------------------------------- face-down work cards

describe('face-down work cards', () => {
  // Pile 0: D4 and C9 face-down under a face-up H6. Pile 1: a face-up S7. Pile 2: K-Q face-up over one face-down card.
  const s = game([player(0, { nertz: cs('D8'), work: [cs('D4 C9 H6'), cs('S7'), cs('C2 SK HQ'), []], down: [2, 0, 1, 0] })]);

  it('cannot be picked up, held or played onto while face-down', () => {
    expect(grab(s, 0, '0:C9')).toBeNull();
    rejected(applyIntent(s, 0, move('0:C9', work(3))));
    rejected(applyIntent(s, 0, hold('0:C9')));
    rejected(applyIntent(s, 0, move('0:D4', work(3))));
    expect(grab(s, 0, '0:H6')).toEqual({ from: { k: 'work', i: 0 }, cards: cs('H6') }); // only the face-up part lifts
    expect(grab(s, 0, '0:SK')).toEqual({ from: { k: 'work', i: 2 }, cards: cs('SK HQ') });
  });

  it('the next one turns face-up when the face-up cards leave, one at a time', () => {
    const a = ok(applyIntent(s, 0, move('0:H6', work(1))));
    expect(ids(a.players[0]!.work[0]!)).toEqual(['0:D4', '0:C9']);
    expect(a.players[0]!.down).toEqual([1, 0, 1, 0]); // C9 is now the face-up top
    expect(grab(a, 0, '0:C9')).not.toBeNull();
    expect(grab(a, 0, '0:D4')).toBeNull();
    const b = ok(applyIntent(a, 0, move('0:D8', work(0)))); // and it can be built on
    expect(ids(b.players[0]!.work[0]!)).toEqual(['0:D4', '0:C9', '0:D8']);
    expect(b.players[0]!.down).toEqual([1, 0, 1, 0]); // adding cards turns nothing over
    const d = run(b, [0, move('0:C9', work(3), 2)]);
    expect(ids(d.players[0]!.work[0]!)).toEqual(['0:D4']);
    expect(d.players[0]!.down).toEqual([0, 0, 1, 0]);
    expect(viewFor(d, 0).players[0]!.work[0]).toEqual(cs('D4')); // face-up for everyone now
  });

  it('moving the whole face-up run to an empty pile is allowed when it uncovers a card, and works to the middle too', () => {
    const a = ok(applyIntent(s, 0, move('0:SK', work(3), 2)));
    expect(ids(a.players[0]!.work[2]!)).toEqual(['0:C2']);
    expect(a.players[0]!.down).toEqual([2, 0, 0, 0]);
    const lone = game([player(0, { work: [cs('C9 HA'), [], [], []], down: [1, 0, 0, 0] })]);
    const b = ok(applyIntent(lone, 0, move('0:HA', slot(0))));
    expect(b.players[0]!.down).toEqual([0, 0, 0, 0]);
    expect(ids(b.players[0]!.work[0]!)).toEqual(['0:C9']);
  });

  it('a pile with nothing left accepts any card or run', () => {
    // Pile 0 is emptied completely: its face-up H6 leaves, the C9 under it turns over and leaves too.
    const start = game([player(0, { nertz: cs('D8'), work: [cs('C9 H6'), cs('SK HQ CJ'), cs('S7'), cs('D10')], down: [1, 0, 0, 0] })]);
    const e = run(start, [0, move('0:H6', work(2))], [0, move('0:C9', work(3))]);
    expect(e.players[0]!.work[0]).toEqual([]);
    expect(e.players[0]!.down).toEqual([0, 0, 0, 0]);
    expect(ids(ok(applyIntent(e, 0, move('0:D8', work(0)))).players[0]!.work[0]!)).toEqual(['0:D8']);
    expect(ids(ok(applyIntent(e, 0, move('0:HQ', work(0), 2))).players[0]!.work[0]!)).toEqual(['0:HQ', '0:CJ']);
  });

  it('are redacted in every view, the owner included, with stable ids; the client sees the flip only in the next snapshot', () => {
    for (const seat of [0, 1]) {
      const v = viewFor(s, seat).players[0]!;
      expect(v.work[0]).toEqual([{ id: '0:D4', owner: 0, hidden: true }, { id: '0:C9', owner: 0, hidden: true }, c('H6')]);
      expect(v.work[2]).toEqual([{ id: '0:C2', owner: 0, hidden: true }, c('SK'), c('HQ')]);
      expect(v.down).toEqual(s.players[0]!.down);
    }
    // Prediction on the view: the pile shrinks and `down` drops, but the new top's face is unknown...
    const predicted = ok(applyIntent(viewFor(s, 0), 0, move('0:H6', work(1))));
    expect(predicted.players[0]!.down).toEqual([1, 0, 1, 0]);
    expect(predicted.players[0]!.work[0]).toEqual([{ id: '0:D4', owner: 0, hidden: true }, { id: '0:C9', owner: 0, hidden: true }]);
    // ...so it can be neither moved, held nor built on until the server reveals it.
    rejected(applyIntent(predicted, 0, move('0:C9', work(3))));
    rejected(applyIntent(predicted, 0, hold('0:C9')));
    rejected(applyIntent(predicted, 0, move('0:D8', work(0))));
    // The server's next snapshot has the same ids with the face filled in.
    const truth = viewFor(ok(applyIntent(s, 0, move('0:H6', work(1)))), 0);
    expect(truth.players[0]!.work[0]).toEqual([{ id: '0:D4', owner: 0, hidden: true }, c('C9')]);
    expect(truth.players[0]!.down).toEqual(predicted.players[0]!.down);
  });
});

// ---------------------------------------------------------------- centre slots

describe('centre slots', () => {
  it('an ace goes on exactly the empty slot it was dropped on', () => {
    const s = game([player(0, { nertz: cs('S5 HA') }), player(1)]);
    expect(s.slots).toHaveLength(8);
    const next = ok(applyIntent(s, 0, move('0:HA', slot(5))));
    expect(next.slots.map((p) => ids(p))).toEqual([[], [], [], [], [], ['0:HA'], [], []]);
    expect(ids(next.players[0]!.nertz)).toEqual(['0:S5']);
    rejected(applyIntent(s, 1, move('0:HA', slot(5)))); // not seat 1's card
    rejected(applyIntent(s, 0, move('0:HA', slot(8)))); // 2 players: slots 0..7 only
    rejected(applyIntent(s, 0, move('0:HA', slot(23))));
    rejected(applyIntent(s, 0, move('0:S5', slot(0)))); // buried
  });

  it('only an ace starts an empty slot, and an ace never goes on a pile', () => {
    const s = game([player(0, { nertz: cs('H2'), waste: cs('HA'), work: [cs('SA'), [], [], []] })], [pile('HA', 1), pile('S3', 1)]);
    rejected(applyIntent(s, 0, move('0:H2', slot(2)))); // a 2 on an empty slot
    rejected(applyIntent(s, 0, move('0:HA', slot(0)))); // an ace on an ace
    rejected(applyIntent(s, 0, move('0:SA', slot(1)))); // an ace on a pile of its suit
    ok(applyIntent(s, 0, move('0:HA', slot(3))));
    ok(applyIntent(s, 0, move('0:H2', slot(0))));
  });

  it('builds up by suit from nertz, waste and work tops, across owners, only on the exact pile', () => {
    const s = game(
      [player(0, { nertz: cs('H2'), waste: cs('S9 H3'), work: [cs('S5 H4'), [], [], []] }), player(1, { nertz: cs('H2', 1) })],
      [pile('SA', 1), pile('HA', 1)],
    );
    let next = run(s, [0, move('0:H2', slot(1))], [0, move('0:H3', slot(1))], [0, move('0:H4', slot(1))]);
    expect(ids(next.slots[1]!)).toEqual(['1:HA', '0:H2', '0:H3', '0:H4']);
    rejected(applyIntent(next, 1, move('1:H2', slot(1)))); // too late
    rejected(applyIntent(s, 0, move('0:H3', slot(1)))); // skips a rank
    rejected(applyIntent(s, 0, move('0:H2', slot(0)))); // wrong suit
    rejected(applyIntent(s, 0, move('0:S5', slot(0)))); // not the top of its work pile
    next = ok(applyIntent(s, 0, move('0:H2', slot(1))));
    expect(next.players[1]).toBe(s.players[1]);
  });

  it('only single cards go to the middle', () => {
    const s = game([player(0, { work: [cs('H3 S2'), [], [], []] })], [pile('H2', 1), pile('SA', 1)]);
    rejected(applyIntent(s, 0, move('0:H3', slot(0))));
    expect(canDrop(s, 0, '0:H3', slot(0))).toBe(false);
    ok(applyIntent(s, 0, move('0:S2', slot(1))));
  });

  describe('no fallback: the loser of a race gets its card back', () => {
    it('to a pile: rejected and nothing moves, even though another pile would take the card', () => {
      const s = deepFreeze(
        game([player(0, { nertz: cs('H2') }), player(1, { nertz: cs('S9 H2', 1) }), player(2, { nertz: cs('H2', 2) })], [pile('HA', 0), pile('HA', 1)]),
      );
      const afterFirst = ok(applyIntent(s, 0, move('0:H2', slot(0))));
      const lost = applyIntent(afterFirst, 1, move('1:H2', slot(0)));
      expect(lost).toEqual({ ok: false, reason: 'Does not fit there' });
      expect(canDrop(afterFirst, 1, '1:H2', slot(0))).toBe(false);
      expect(ids(afterFirst.players[1]!.nertz)).toEqual(['1:S9', '1:H2']); // still where it came from
      expect(afterFirst.slots.map((p) => ids(p)).slice(0, 2)).toEqual([['0:HA', '0:H2'], ['1:HA']]); // the other ace was not touched
      // The same card is fine on the pile it actually fits, when aimed there.
      const inMiddle = (g: GameState, seat: number, id: string) => legalDrops(g, seat, id).filter((to) => to.k === 'slot');
      expect(inMiddle(afterFirst, 1, '1:H2')).toEqual([slot(1)]);
      const retry = ok(applyIntent(afterFirst, 1, move('1:H2', slot(1))));
      expect(ids(retry.slots[1]!)).toEqual(['1:HA', '1:H2']);
      expect(inMiddle(retry, 2, '2:H2')).toEqual([]);
    });

    it('to an empty slot: two aces race for one slot, the first wins and the other returns', () => {
      const s = deepFreeze(game([player(0, { nertz: cs('HA') }), player(1, { nertz: cs('S9 SA', 1) })]));
      const afterFirst = ok(applyIntent(s, 0, move('0:HA', slot(3))));
      rejected(applyIntent(afterFirst, 1, move('1:SA', slot(3)))); // every other slot is empty, but it was not aimed at them
      expect(ids(afterFirst.players[1]!.nertz)).toEqual(['1:S9', '1:SA']);
      expect(afterFirst.slots.filter((p) => p.length > 0)).toHaveLength(1);
      const retry = ok(applyIntent(afterFirst, 1, move('1:SA', slot(4))));
      expect(ids(retry.slots[4]!)).toEqual(['1:SA']);
      // Same suit, different slots: two piles of one suit can coexist.
      const twin = game([player(0, { nertz: cs('HA') }), player(1, { nertz: cs('HA', 1) })]);
      expect(run(twin, [0, move('0:HA', slot(0))], [1, move('1:HA', slot(1))]).slots.slice(0, 2).map((p) => ids(p))).toEqual([['0:HA'], ['1:HA']]);
    });
  });
});

// ---------------------------------------------------------------- completed piles and the tray

describe('completed piles', () => {
  const s = game([player(0, { nertz: cs('SK'), waste: cs('HA') }), player(1, { nertz: cs('SK', 1), waste: cs('DA', 1) })], [[], [], pile('SQ', 1)]);
  const done = ok(applyIntent(s, 0, move('0:SK', slot(2))));

  it('a king completes a pile, which stays in its slot and takes nothing more', () => {
    expect(isComplete(s.slots[2]!)).toBe(false);
    expect(completedBy(s.slots[2]!)).toBeNull();
    expect(isComplete(done.slots[2]!)).toBe(true);
    expect(done.slots[2]).toHaveLength(13);
    expect(completedBy(done.slots[2]!)).toBe(0); // the seat that placed the King
    rejected(applyIntent(done, 1, move('1:SK', slot(2))));
    rejected(applyIntent(done, 1, move('1:DA', slot(2)))); // the slot is not free yet
    expect(legalDrops(done, 1, '1:SK').filter((to) => to.k === 'slot')).toEqual([]);
  });

  it("only the King's player can clear it to the tray; the slot is then free again", () => {
    rejected(applyIntent(done, 1, { k: 'clear', slot: 2 })); // most of the pile is seat 1's, but seat 0 placed the King
    rejected(applyIntent(done, 0, { k: 'clear', slot: 1 })); // empty slot
    rejected(applyIntent(done, 0, { k: 'clear', slot: 23 }));
    rejected(applyIntent(s, 1, { k: 'clear', slot: 2 })); // not complete
    rejected(applyIntent(s, 0, { k: 'clear', slot: 2 }));
    const cleared = ok(applyIntent(done, 0, { k: 'clear', slot: 2 }));
    expect(cleared.slots[2]).toEqual([]);
    expect(cleared.slots).toHaveLength(8);
    expect(cleared.tray).toEqual([done.slots[2]]);
    expect(cleared.tray[0]!.at(-1)).toEqual(c('SK'));
    rejected(applyIntent(cleared, 0, { k: 'clear', slot: 2 })); // nothing there any more
    const reused = ok(applyIntent(cleared, 1, move('1:DA', slot(2))));
    expect(ids(reused.slots[2]!)).toEqual(['1:DA']);
    expect(reused.tray).toHaveLength(1);
  });

  it('clearing counts as doing something (clears the stuck flag) and tray piles keep scoring', () => {
    const stuck = run(done, [0, { k: 'stuck', on: true }], [0, { k: 'clear', slot: 2 }]);
    expect(stuck.players[0]!.stuck).toBe(false);
    expect(scoreRound(done)).toEqual(scoreRound(stuck));
    expect(scoreRound(stuck)).toEqual([
      { seat: 0, played: 1, nertzLeft: 0, delta: 1 },
      { seat: 1, played: 12, nertzLeft: 1, delta: 10 },
    ]);
  });
});

// ---------------------------------------------------------------- stock

describe('flip and recycle', () => {
  const s = game([player(0, { stock: cs('S7 S6 S5 S4 S3 S2 SA') })]); // SA is the top

  it('flips three at a time, the third card ending up on top of the waste', () => {
    const a = ok(applyIntent(s, 0, { k: 'flip' }));
    expect(ids(a.players[0]!.waste)).toEqual(['0:SA', '0:S2', '0:S3']);
    expect(a.players[0]!.stock).toHaveLength(4);
    const b = ok(applyIntent(a, 0, { k: 'flip' }));
    expect(ids(b.players[0]!.waste)).toEqual(['0:SA', '0:S2', '0:S3', '0:S4', '0:S5', '0:S6']);
    const d = ok(applyIntent(b, 0, { k: 'flip' })); // only one card left
    expect(ids(d.players[0]!.waste).at(-1)).toBe('0:S7');
    expect(d.players[0]!.stock).toHaveLength(0);
  });

  it('recycles the waste into the stock in the original order when the stock is empty', () => {
    let st = s;
    for (let i = 0; i < 3; i++) st = ok(applyIntent(st, 0, { k: 'flip' }));
    st = ok(applyIntent(st, 0, { k: 'flip' }));
    expect(st.players[0]!.waste).toEqual([]);
    expect(st.players[0]!.stock).toEqual(s.players[0]!.stock);
  });

  it('rejects a flip with nothing to flip, and does not clear the stuck flag', () => {
    rejected(applyIntent(game([player(0)]), 0, { k: 'flip' }));
    const stuck = game([player(0, { stock: cs('S7'), stuck: true })]);
    expect(ok(applyIntent(stuck, 0, { k: 'flip' })).players[0]!.stuck).toBe(true);
  });
});

// ---------------------------------------------------------------- stuck

describe('stuck', () => {
  const base = game([
    player(0, { stock: cs('S5 S4'), waste: cs('SA S2 S3'), nertz: cs('H6'), work: [cs('S7'), [], [], []] }),
    player(1, { stock: cs('D9', 1), waste: [] }),
    player(2, { stock: [], waste: cs('C2 C3', 2) }),
  ]);
  const stuck = (s: GameState, seat: number, on = true) => ok(applyIntent(s, seat, { k: 'stuck', on }));

  it('toggles the flag, and a successful move clears it', () => {
    const a = stuck(base, 0);
    expect(a.players.map((p) => p.stuck)).toEqual([true, false, false]);
    expect(stuck(a, 0, false).players[0]!.stuck).toBe(false);
    rejected(applyIntent(a, 0, move('0:H6', slot(0)))); // a refused move changes nothing
    expect(ok(applyIntent(a, 0, move('0:H6', work(0)))).players[0]!.stuck).toBe(false);
  });

  it('does nothing until every connected player is stuck', () => {
    const a = stuck(stuck(base, 0), 1);
    expect(resolveStuck(a, [0, 1, 2])).toBe(a);
    expect(resolveStuck(base, [])).toBe(base);
    expect(resolveStuck(base, [9])).toBe(base);
  });

  it('rotates every stock when all connected players are stuck', () => {
    const a = stuck(stuck(base, 0), 1);
    const r = resolveStuck(a, [0, 1]); // seat 2 is disconnected and not stuck
    expect(r.players.map((p) => p.stuck)).toEqual([false, false, false]);
    expect(r.players.every((p) => p.waste.length === 0)).toBe(true);
    // seat 0: original order was (top first) SA S2 S3 S4 S5; the top goes to the bottom
    expect(ids(r.players[0]!.stock)).toEqual(['0:SA', '0:S5', '0:S4', '0:S3', '0:S2']);
    expect(ids(r.players[1]!.stock)).toEqual(['1:D9']);
    expect(ids(r.players[2]!.stock)).toEqual(['2:C2', '2:C3']);
    expect(r.players[0]!.nertz).toEqual(base.players[0]!.nertz);
    // the next flip now shows different cards than the first one did
    expect(ids(ok(applyIntent(r, 0, { k: 'flip' })).players[0]!.waste)).toEqual(['0:S2', '0:S3', '0:S4']);
  });

  it('is a no-op once Nertz has been called', () => {
    const over = { ...stuck(stuck(stuck(base, 0), 1), 2), nertzCalledBy: 1 };
    expect(resolveStuck(over, [0, 1, 2])).toBe(over);
  });
});

// ---------------------------------------------------------------- nertz + scoring

describe('calling nertz and scoring', () => {
  const s = game(
    [player(0, { nertz: cs('HA'), work: [cs('S9'), [], [], []] }), player(1, { nertz: cs('C5 C6 C7', 1), stock: cs('D2', 1) })],
    [[c('SA', 1), c('S2', 0), c('S3', 1)]],
  );

  it('is refused while the nertz pile has cards', () => {
    rejected(applyIntent(s, 0, NERTZ));
    rejected(applyIntent(s, 1, NERTZ));
    rejected(applyIntent(s, 5, NERTZ));
  });

  it('is an explicit action; with nobody holding a card the round is over at once and the table is frozen', () => {
    const emptied = ok(applyIntent(s, 0, move('0:HA', slot(1))));
    expect(emptied.nertzCalledBy).toBeNull(); // emptying the pile does not end the round by itself
    expect(isOver(emptied)).toBe(false);
    const over = ok(applyIntent(emptied, 0, NERTZ));
    expect(over.nertzCalledBy).toBe(0);
    expect(over.grace).toEqual([]);
    expect(isOver(over)).toBe(true);
    for (const seat of [0, 1]) {
      for (const intent of [{ k: 'flip' }, NERTZ, { k: 'stuck', on: true }, move('1:C7', work(0)), hold('1:C7'), RELEASE, { k: 'clear', slot: 0 }] as Intent[]) {
        rejected(applyIntent(over, seat, intent));
      }
    }
    expect(canDrop(over, 1, '1:C7', work(0))).toBe(false);
    expect(legalDrops(over, 1, '1:C7')).toHaveLength(4); // the cards would fit; the round is what forbids it
    expect(expireGrace(over)).toBe(over);
  });

  it('scores strictly cards in the middle (slots and tray) minus twice the nertz pile, with no bonus for going out', () => {
    const over = run(s, [0, move('0:HA', slot(1))], [0, NERTZ]);
    expect(scoreRound(over)).toEqual([
      { seat: 0, played: 2, nertzLeft: 0, delta: 2 }, // S2 and the HA: nothing extra for calling
      { seat: 1, played: 2, nertzLeft: 3, delta: -4 },
    ]);
    const mixed = (owner: (rank: number) => number): Card[] => pile('DK').map((x) => ({ ...x, owner: owner(x.rank), id: `${owner(x.rank)}:D${x.rank}` }));
    const withTray = game(
      [player(0, { nertz: cs('C2 C3') }), player(1), player(2, { nertz: cs('C4', 2), waste: cs('C5 C6', 2), work: [cs('C7', 2), [], [], []] })],
      [pile('H4', 1), [], mixed((r) => (r === 13 ? 2 : 0))],
      { tray: [mixed((r) => r % 2), mixed(() => 1).map((x) => ({ ...x, suit: 'S' as Suit }))] },
    );
    expect(scoreRound(withTray)).toEqual([
      { seat: 0, played: 12 + 6, nertzLeft: 2, delta: 14 },
      { seat: 1, played: 4 + 7 + 13, nertzLeft: 0, delta: 24 },
      { seat: 2, played: 1, nertzLeft: 1, delta: -1 }, // waste, work and stock cards cost nothing
    ]);
  });
});

// ---------------------------------------------------------------- holding

describe('holding a card', () => {
  const s = game([
    player(0, { nertz: cs('C9 H6'), waste: cs('D2 S4'), stock: cs('C8 C7'), work: [cs('D4 S7'), cs('SK HQ'), [], []], down: [1, 0, 0, 0] }),
    player(1, { nertz: cs('H8', 1) }),
  ]);

  it('is accepted only for a card that seat could pick up right now', () => {
    for (const id of ['0:H6', '0:S4', '0:S7', '0:SK', '0:HQ']) expect(ok(applyIntent(s, 0, hold(id))).players[0]!.holding).toBe(id);
    for (const id of ['0:C9', '0:D2', '0:C8', '0:D4', '1:H8', 'nope']) rejected(applyIntent(s, 0, hold(id))); // buried, stock, face-down, not theirs, unknown
    rejected(applyIntent(s, 5, hold('0:H6')));
    const hiddenTop = { ...viewFor(s, 0), players: [{ ...s.players[0]!, nertz: [{ id: '0:H6', owner: 0, hidden: true as const }] }, s.players[1]!] };
    rejected(applyIntent(hiddenTop, 0, hold('0:H6'))); // face not known yet on the client
  });

  it('is visible in every view, replaces an earlier hold and leaves the stuck flag alone', () => {
    const a = run(s, [0, { k: 'stuck', on: true }], [0, hold('0:H6')], [1, hold('1:H8')]);
    expect(viewFor(a, 1).players.map((p) => p.holding)).toEqual(['0:H6', '1:H8']);
    expect(a.players[0]!.stuck).toBe(true);
    expect(ok(applyIntent(a, 0, hold('0:S4'))).players.map((p) => p.holding)).toEqual(['0:S4', '1:H8']);
    expect(checkInvariants({ ...deal([0, 1], mulberry32(1)), players: deal([0, 1], mulberry32(1)).players.map((p) => ({ ...p, holding: p.stock[0]!.id })) })).toMatch(/holding/);
  });

  it('ends with a release (refused when nothing is held) or with any move', () => {
    rejected(applyIntent(s, 0, RELEASE));
    const held = ok(applyIntent(s, 0, hold('0:H6')));
    expect(ok(applyIntent(held, 0, RELEASE)).players[0]!.holding).toBeNull();
    expect(ok(applyIntent(held, 0, move('0:H6', work(2)))).players[0]!.holding).toBeNull();
    expect(ok(applyIntent(held, 0, move('0:S4', work(2)))).players[0]!.holding).toBeNull(); // a move of another card also empties the hand
    rejected(applyIntent(held, 0, move('0:H6', work(1)))); // a refused move does not
    expect(held.players[0]!.holding).toBe('0:H6');
  });

  it('never outlives the card being pickable: a flip or a stuck rotation that buries the held waste card drops it', () => {
    const waste = ok(applyIntent(s, 0, hold('0:S4')));
    expect(ok(applyIntent(waste, 0, { k: 'flip' })).players[0]!.holding).toBeNull();
    const nertz = ok(applyIntent(s, 0, hold('0:H6')));
    expect(ok(applyIntent(nertz, 0, { k: 'flip' })).players[0]!.holding).toBe('0:H6');
    const allStuck = (g: GameState) => resolveStuck(run(g, [0, { k: 'stuck', on: true }], [1, { k: 'stuck', on: true }]), [0, 1]);
    expect(allStuck(waste).players[0]!.holding).toBeNull();
    expect(allStuck(nertz).players[0]!.holding).toBe('0:H6');
  });
});

// ---------------------------------------------------------------- held-card grace

describe('a refused drop', () => {
  // Seat 0 has the Ace of spades on a red 2; seat 1 has an Ace of spades too. Slot 0 is the only slot either looks at.
  const s = game([
    player(0, { nertz: cs('D9'), work: [cs('H2 SA'), cs('C3'), [], []] }),
    player(1, { work: [cs('SA', 1), cs('D5', 1), [], []] }),
  ]);

  it('still ends the drag: the hand is empty afterwards, as after a release', () => {
    const raced = run(s, [0, hold('0:SA')], [1, move('1:SA', slot(0))]);
    const drop = move('0:SA', slot(0));
    rejected(applyIntent(raced, 0, drop));
    expect(raced.players[0]!.holding).toBe('0:SA');
    const after = refused(raced, 0, drop);
    expect(after.players[0]!.holding).toBeNull();
    expect(ids(after.players[0]!.work[0]!)).toEqual(['0:H2', '0:SA']); // the card is where it came from
    // So a Nertz call right after finds nobody holding anything.
    expect(isOver(ok(applyIntent(after, 1, NERTZ)))).toBe(true);
    expect(isOver(ok(applyIntent(raced, 1, NERTZ)))).toBe(false); // what it was like without
  });

  it('changes nothing for anything but a move, or when nothing was held', () => {
    const held = run(s, [0, hold('0:SA')]);
    for (const intent of [{ k: 'flip' }, hold('1:SA'), { k: 'clear', slot: 0 }, NERTZ, RELEASE] as Intent[]) expect(refused(held, 0, intent)).toBe(held);
    expect(refused(s, 0, move('0:SA', slot(0)))).toBe(s);
    expect(refused(s, 9, move('0:SA', slot(0)))).toBe(s);
  });

  it('in grace it is that seat\'s one move: they are out, and the round ends if they were the last', () => {
    const called = run(s, [0, hold('0:SA')], [1, NERTZ]);
    expect(called.grace).toEqual([0]);
    const drop = move('0:SA', work(1)); // an Ace on a 3
    rejected(applyIntent(called, 0, drop));
    const after = refused(called, 0, drop);
    expect([after.grace, after.players[0]!.holding, isOver(after)]).toEqual([[], null, true]);
    expect(refused(after, 0, drop)).toBe(after); // and that is final
  });

  it('a move names how many cards were lifted, and is refused if that is not what lies there', () => {
    rejected(applyIntent(s, 0, move('0:H2', work(1)))); // "one card", but the Ace is on it
    const both = ok(applyIntent(s, 0, move('0:H2', work(1), 2)));
    expect(ids(both.players[0]!.work[1]!)).toEqual(['0:C3', '0:H2', '0:SA']);
    rejected(applyIntent(s, 0, move('0:SA', slot(0), 2))); // "two cards", but it is the top one
    rejected(applyIntent(s, 0, move('0:D9', work(2), 2))); // the nertz pile only ever gives one
    expect(canDrop(s, 0, '0:H2', work(1))).toBe(true); // canDrop and legalDrops speak of what lies there now
  });
});

describe('held-card grace after a Nertz call', () => {
  // Seat 0 is ready to call. Seat 1 has a 2 of hearts that fits the pile in slot 0 (and nothing else). Seat 2 has a
  // 9 of diamonds with nowhere to go. Seat 3 has a 2 of hearts as well, and a 3 of clubs that fits its last work pile.
  const blocked = (owner: number) => [cs('S9', owner), cs('C9', owner), cs('SJ', owner), cs('CJ', owner)];
  const s = deepFreeze(
    game(
      [
        player(0, { stock: cs('D2 D3'), work: [cs('S9'), [], [], []] }),
        player(1, { nertz: cs('C5 H2', 1), work: blocked(1), stock: cs('D2', 1) }),
        player(2, { nertz: cs('D9', 2), work: blocked(2) }),
        player(3, { nertz: cs('H2', 3), waste: cs('C3', 3), work: [...blocked(3).slice(0, 3), cs('D4', 3)] }),
      ],
      [pile('HA', 0)],
    ),
  );
  const holding = (g: GameState) => g.players.map((p) => p.holding);

  it('nobody holding: the round is over immediately', () => {
    const over = ok(applyIntent(s, 0, NERTZ));
    expect([over.nertzCalledBy, over.grace, isOver(over)]).toEqual([0, [], true]);
  });

  it('the caller is never in grace: calling puts down whatever they held', () => {
    const over = run(s, [0, hold('0:S9')], [0, NERTZ]);
    expect([over.grace, holding(over), isOver(over)]).toEqual([[], [null, null, null, null], true]);
  });

  it('a holder with a legal destination gets one move with that card; it lands, counts, and ends the round', () => {
    const called = run(s, [1, hold('1:H2')], [0, NERTZ]);
    expect(called.nertzCalledBy).toBe(0);
    expect(called.grace).toEqual([1]);
    expect(isOver(called)).toBe(false);
    expect(holding(called)).toEqual([null, '1:H2', null, null]);
    expect(viewFor(called, 3).grace).toEqual([1]); // everyone can see who is still playing
    expect(canDrop(called, 1, '1:H2', slot(0))).toBe(true);
    const over = ok(applyIntent(called, 1, move('1:H2', slot(0))));
    expect([over.grace, isOver(over), holding(over)]).toEqual([[], true, [null, null, null, null]]);
    expect(ids(over.slots[0]!)).toEqual(['0:HA', '1:H2']);
    expect(scoreRound(over).map((x) => x.delta)).toEqual([1, 1 - 2, -2, -2]); // the grace move scored and shortened the nertz pile
    rejected(applyIntent(over, 1, move('1:C5', work(0))));
  });

  it('exactly one move, with the held card only, to a legal spot; everything else is refused and keeps them in grace', () => {
    const called = run(s, [3, hold('3:H2')], [0, NERTZ]);
    expect(called.grace).toEqual([3]);
    expect(legalDrops(called, 3, '3:C3')).toEqual([work(3)]); // a perfectly good move, a moment ago
    for (const intent of [move('3:C3', slot(1)), move('3:C3', work(3)), { k: 'flip' }, { k: 'stuck', on: true }, NERTZ, hold('3:C3'), hold('3:H2'), { k: 'clear', slot: 0 }] as Intent[]) {
      rejected(applyIntent(called, 3, intent));
    }
    expect(canDrop(called, 3, '3:C3', work(3))).toBe(false);
    rejected(applyIntent(called, 3, move('3:H2', slot(1)))); // an illegal spot: refused (and `refused` then ends their grace)
    rejected(applyIntent(called, 3, move('3:H2', work(0))));
    const over = ok(applyIntent(called, 3, move('3:H2', slot(0))));
    expect(isOver(over)).toBe(true);
    rejected(applyIntent(over, 3, move('3:C3', work(3)))); // no second move
  });

  it('a grace move may also go to a work pile, taking the run above the held card with it', () => {
    const g = game([player(0), player(1, { work: [cs('S9 H8 C7', 1), cs('C9', 1), cs('D2', 1), cs('D3', 1)] })]);
    const called = run(g, [1, hold('1:H8')], [0, NERTZ]);
    expect(called.grace).toEqual([1]);
    rejected(applyIntent(called, 1, move('1:C7', work(0)))); // part of the lifted run, but not the card that was grabbed
    const over = ok(applyIntent(called, 1, move('1:H8', work(1), 2)));
    expect(ids(over.players[1]!.work[1]!)).toEqual(['1:C9', '1:H8', '1:C7']);
    expect(isOver(over)).toBe(true);
  });

  it('non-grace players are frozen immediately', () => {
    const called = run(s, [1, hold('1:H2')], [0, NERTZ]);
    for (const seat of [0, 2, 3, 9]) {
      for (const intent of [{ k: 'flip' }, NERTZ, { k: 'stuck', on: true }, RELEASE, hold('3:H2'), move('3:H2', slot(0)), move('0:S9', work(1)), { k: 'clear', slot: 0 }] as Intent[]) {
        rejected(applyIntent(called, seat, intent));
      }
    }
    expect(canDrop(called, 3, '3:H2', slot(0))).toBe(false);
    expect(resolveStuck(called, [0, 1, 2, 3])).toBe(called);
  });

  it('a holder whose card has nowhere legal to go is cut off at the call and the drag is cancelled', () => {
    expect(legalDrops(s, 2, '2:D9')).toEqual([]);
    const called = run(s, [2, hold('2:D9')], [1, hold('1:H2')], [0, NERTZ]);
    expect(called.grace).toEqual([1]);
    expect(holding(called)).toEqual([null, '1:H2', null, null]);
    rejected(applyIntent(called, 2, RELEASE));
    const alone = run(s, [2, hold('2:D9')], [0, NERTZ]);
    expect([alone.grace, holding(alone), isOver(alone)]).toEqual([[], [null, null, null, null], true]);
  });

  it('a target taken during grace by another grace player cuts off whoever now has nowhere to go', () => {
    const called = run(s, [1, hold('1:H2')], [3, hold('3:H2')], [0, NERTZ]);
    expect(called.grace).toEqual([1, 3]);
    const taken = ok(applyIntent(called, 3, move('3:H2', slot(0))));
    expect(ids(taken.slots[0]!)).toEqual(['0:HA', '3:H2']);
    expect([taken.grace, holding(taken), isOver(taken)]).toEqual([[], [null, null, null, null], true]);
    expect(ids(taken.players[1]!.nertz)).toEqual(['1:C5', '1:H2']); // seat 1's card went back where it came from
    rejected(applyIntent(taken, 1, move('1:H2', slot(0))));
    rejected(applyIntent(taken, 1, RELEASE));
  });

  it('...but leaves in grace a player whose card still has another home', () => {
    const roomy = { ...s, players: s.players.map((p) => (p.seat === 1 ? { ...p, work: [...p.work.slice(0, 3), []] } : p)) };
    const called = run(roomy, [1, hold('1:H2')], [3, hold('3:H2')], [0, NERTZ]);
    const taken = ok(applyIntent(called, 3, move('3:H2', slot(0))));
    expect([taken.grace, holding(taken), isOver(taken)]).toEqual([[1], [null, '1:H2', null, null], false]);
    rejected(applyIntent(taken, 1, move('1:H2', slot(0)))); // that spot is gone
    expect(isOver(ok(applyIntent(taken, 1, move('1:H2', work(3)))))).toBe(true);
  });

  it('releasing without a move also ends that player\'s grace', () => {
    const called = run(s, [1, hold('1:H2')], [3, hold('3:H2')], [0, NERTZ]);
    const one = ok(applyIntent(called, 1, RELEASE));
    expect([one.grace, holding(one)]).toEqual([[3], [null, null, null, '3:H2']]);
    expect(one.slots).toEqual(called.slots);
    rejected(applyIntent(one, 1, move('1:H2', slot(0)))); // they let go: frozen like everyone else
    const over = ok(applyIntent(one, 3, RELEASE));
    expect(isOver(over)).toBe(true);
    expect(scoreRound(over)).toEqual(scoreRound(called));
  });

  it('expireGrace cuts off everyone still in grace and is otherwise the identity', () => {
    const called = run(s, [1, hold('1:H2')], [3, hold('3:H2')], [0, NERTZ]);
    const expired = expireGrace(called);
    expect([expired.grace, holding(expired), isOver(expired), expired.nertzCalledBy]).toEqual([[], [null, null, null, null], true, 0]);
    expect(expired.slots).toEqual(called.slots);
    expect(expireGrace(expired)).toBe(expired);
    expect(expireGrace(s)).toBe(s);
    const playing = ok(applyIntent(s, 1, hold('1:H2')));
    expect(expireGrace(playing)).toBe(playing); // holds outside grace are untouched
  });

  it('works the same on a redacted view, so the client can predict its grace move', () => {
    const called = run(s, [1, hold('1:H2')], [3, hold('3:H2')], [0, NERTZ]);
    const predicted = ok(applyIntent(viewFor(called, 1), 1, move('1:H2', slot(0))));
    const truth = ok(applyIntent(called, 1, move('1:H2', slot(0))));
    expect(predicted.grace).toEqual(truth.grace);
    expect(predicted.slots).toEqual(truth.slots);
    expect(isHidden(predicted.players[1]!.nertz[0]!)).toBe(true); // the uncovered nertz card stays unknown
    expect(ok(applyIntent(viewFor(s, 0), 0, NERTZ))).toEqual(viewFor(ok(applyIntent(s, 0, NERTZ)), 0));
    expect(ok(applyIntent(viewFor(ok(applyIntent(s, 1, hold('1:H2'))), 0), 0, NERTZ))).toEqual(viewFor(run(s, [1, hold('1:H2')], [0, NERTZ]), 0));
  });
});

// ---------------------------------------------------------------- views

describe('viewFor', () => {
  const full = deal([0, 1], mulberry32(3));
  const flipped = ok(applyIntent(full, 0, { k: 'flip' }));
  const view = viewFor(flipped, 0);

  it('hides every stock (your own too), everything under each nertz top and the face-down work cards, keeping ids and owners', () => {
    for (const [pi, p] of view.players.entries()) {
      const real = flipped.players[pi]!;
      expect(p.stock.every(isHidden)).toBe(true);
      expect(p.nertz.slice(0, -1).every(isHidden)).toBe(true);
      expect(p.nertz.at(-1)).toEqual(real.nertz.at(-1));
      for (const [i, w] of p.work.entries()) {
        expect(w.slice(0, -1).every(isHidden)).toBe(true);
        expect(w.at(-1)).toEqual(real.work[i]!.at(-1));
        expect(ids(w)).toEqual(ids(real.work[i]!));
      }
      expect(p.down).toEqual(real.down);
      expect(p.waste).toEqual(real.waste);
      expect(ids(p.stock)).toEqual(ids(real.stock));
      expect(ids(p.nertz)).toEqual(ids(real.nertz));
      expect(p.stock.every((x) => x.owner === p.seat)).toBe(true);
    }
    expect(view.players[0]!.waste).toHaveLength(3);
  });

  it('leaks no face of a hidden card', () => {
    const hiddenIds = new Set(allCards(view).filter(isHidden).map((x) => x.id));
    expect(hiddenIds.size).toBe(2 * 12 + 2 * 6 + 26 + 29);
    for (const x of allCards(view).filter(isHidden)) expect(Object.keys(x).sort()).toEqual(['hidden', 'id', 'owner']);
    expect(JSON.stringify(view)).not.toMatch(/"rank":\d+,"hidden"|"hidden":true,"suit"/);
  });

  it('is idempotent, passes the invariant check, and does not mutate its input', () => {
    expect(viewFor(view, 1)).toEqual(view);
    expect(checkInvariants(view)).toBeNull();
    const frozen = deepFreeze(deal([0, 1], mulberry32(4)));
    expect(() => viewFor(frozen, 0)).not.toThrow();
  });

  it('keeps the whole middle and the grace state visible', () => {
    const g = game([player(0), player(1, { nertz: cs('H2', 1) })], [pile('HA', 0)], { tray: [pile('SK', 0)] });
    const called = run(g, [1, hold('1:H2')], [0, NERTZ]);
    const v = viewFor(called, 1);
    expect([v.slots, v.tray, v.grace, v.nertzCalledBy]).toEqual([called.slots, called.tray, [1], 0]);
  });

  it('lets the reducer run structurally on hidden cards but never judge them', () => {
    // flip on a view: hidden cards land in the waste, still hidden
    const predicted = ok(applyIntent(viewFor(full, 0), 0, { k: 'flip' }));
    expect(predicted.players[0]!.waste.every(isHidden)).toBe(true);
    expect(ids(predicted.players[0]!.waste)).toEqual(ids(flipped.players[0]!.waste));
    // a hidden waste top cannot be moved anywhere, not even to an empty pile
    const hiddenTop = predicted.players[0]!.waste.at(-1)!.id;
    const withGap = { ...predicted, players: predicted.players.map((p) => ({ ...p, work: [[], ...p.work.slice(1)] })) };
    rejected(applyIntent(withGap, 0, move(hiddenTop, work(0))));
    rejected(applyIntent(withGap, 0, move(hiddenTop, slot(0))));
    rejected(applyIntent(withGap, 0, hold(hiddenTop)));
    expect(grab(withGap, 0, hiddenTop)).toBeNull();
    expect(legalDrops(withGap, 0, hiddenTop)).toEqual([]);
    // playing the nertz top uncovers a hidden card, which is stuck until the server reveals it
    const v = viewFor(game([player(0, { nertz: cs('S9 H6'), work: [cs('S7'), [], [], []] })]), 0);
    const after = ok(applyIntent(v, 0, move('0:H6', work(0))));
    expect(isHidden(after.players[0]!.nertz[0]!)).toBe(true);
    rejected(applyIntent(after, 0, move('0:S9', work(1))));
  });
});

// ---------------------------------------------------------------- invariants

describe('checkInvariants', () => {
  const good = deal([0, 1], mulberry32(5));
  const withPlayer0 = (patch: (p: PlayerState) => Partial<PlayerState>): GameState => ({
    ...good,
    players: good.players.map((p, i) => (i === 0 ? { ...p, ...patch(p) } : p)),
  });

  it('accepts a fresh deal', () => expect(checkInvariants(good)).toBeNull());
  it('catches a missing card', () => expect(checkInvariants(withPlayer0((p) => ({ stock: p.stock.slice(1) })))).toMatch(/has 51 cards/));
  it('catches a duplicated card', () =>
    expect(checkInvariants(withPlayer0((p) => ({ waste: [p.stock[0]!], stock: p.stock })))).toMatch(/appears twice/));
  it('catches a duplicated face under a fresh id', () =>
    expect(checkInvariants(withPlayer0((p) => ({ stock: [{ ...(p.nertz[0] as Card), id: 'x' }, ...p.stock.slice(1)] })))).toMatch(/duplicate face/));
  it('catches a broken work run', () => {
    const bad = withPlayer0((p) => ({ work: [p.work.flat(), [], [], []], down: [0, 0, 0, 0] }));
    expect(checkInvariants(bad)).toMatch(/alternating run/);
  });
  it('catches a work pile with no face-up top', () =>
    expect(checkInvariants(withPlayer0((p) => ({ down: [1, ...p.down.slice(1)] })))).toMatch(/no face-up card/));
  it('catches a nertz call with cards left', () => expect(checkInvariants({ ...good, nertzCalledBy: 0 })).toMatch(/nertz called/));
  it('catches a wrong number of work piles', () => expect(checkInvariants(withPlayer0((p) => ({ work: p.work.slice(1) })))).toMatch(/work piles/));
  it("catches a card in someone else's pile", () => {
    const [a, b] = good.players as [PlayerState, PlayerState];
    const swapped = { ...good, players: [{ ...a, waste: [b.stock[0]!] }, { ...b, stock: b.stock.slice(1) }] };
    expect(checkInvariants(swapped)).toMatch(/owned by seat 1/);
  });
  it('catches a malformed centre pile, a wrong slot count and an unfinished tray pile', () => {
    const p = good.players[0]!;
    const card = p.work[0]![0] as Card;
    const without = withPlayer0(() => ({ work: [[], ...p.work.slice(1)] }));
    const inSlot = { ...without, slots: [[card], ...good.slots.slice(1)] };
    if (card.rank === 1) expect(checkInvariants(inSlot)).toBeNull();
    else expect(checkInvariants(inSlot)).toMatch(/ace-up/);
    expect(checkInvariants({ ...good, slots: good.slots.slice(1) })).toMatch(/centre slots/);
    const ace = [...p.nertz, ...p.stock].find((x) => (x as Card).rank === 1) as Card;
    const moved = withPlayer0((q) => ({ nertz: q.nertz.filter((x) => x !== ace), stock: q.stock.filter((x) => x !== ace) }));
    expect(checkInvariants({ ...moved, slots: [[ace], ...good.slots.slice(1)] })).toBeNull();
    expect(checkInvariants({ ...moved, tray: [[ace]] })).toMatch(/tray/);
  });
  it('catches inconsistent grace', () => {
    expect(checkInvariants({ ...good, grace: [0] })).toMatch(/grace without/);
    const emptied = withPlayer0((p) => ({ nertz: [], stock: [...p.stock, ...p.nertz] }));
    expect(checkInvariants({ ...emptied, nertzCalledBy: 0, grace: [1] })).toMatch(/in grace without/);
    const frozenHolder = { ...emptied, nertzCalledBy: 0, players: emptied.players.map((p, i) => (i === 1 ? { ...p, holding: p.nertz.at(-1)!.id } : p)) };
    expect(checkInvariants(frozenHolder)).toMatch(/frozen player/);
    expect(checkInvariants({ ...frozenHolder, grace: [1] })).toMatch(/in grace without/); // that card has nowhere to go
  });
});

// ---------------------------------------------------------------- garbage

describe('robustness', () => {
  const state = deepFreeze(deal([0, 1], mulberry32(11)));
  const someId = state.players[0]!.nertz.at(-1)!.id;
  const garbage: unknown[] = [
    undefined, null, 0, 1, -1, NaN, Infinity, '', 'flip', true, [], [1, 2], {}, () => 1, Symbol('x'), 10n,
    { k: null }, { k: 'fly' }, { k: 'move' }, { k: 'move', cardId: someId }, { k: 'move', cardId: someId, to: { k: 'work', i: 0 } },
    ...[0, 14, -1, 1.5, '1', null].map((count) => ({ k: 'move', cardId: someId, count, to: { k: 'work', i: 0 } })), { k: 'move', cardId: someId, count: 1, to: null },
    { k: 'move', cardId: someId, count: 1, to: 'work' }, { k: 'move', cardId: someId, count: 1, to: {} }, { k: 'move', cardId: someId, count: 1, to: { k: 'work' } },
    { k: 'move', cardId: someId, count: 1, to: { k: 'work', i: 1.5 } }, { k: 'move', cardId: someId, count: 1, to: { k: 'work', i: -1 } },
    { k: 'move', cardId: someId, count: 1, to: { k: 'work', i: 4 } }, { k: 'move', cardId: someId, count: 1, to: { k: 'work', i: NaN } },
    { k: 'move', cardId: someId, count: 1, to: { k: 'work', i: '0' } }, { k: 'move', cardId: someId, count: 1, to: { k: 'work', i: 2 ** 40 } },
    { k: 'move', cardId: someId, count: 1, to: { k: 'slot' } }, { k: 'move', cardId: someId, count: 1, to: { k: 'slot', i: 24 } },
    { k: 'move', cardId: someId, count: 1, to: { k: 'slot', i: -1 } }, { k: 'move', cardId: someId, count: 1, to: { k: 'slot', i: '0' } },
    { k: 'move', cardId: someId, count: 1, to: { k: 'slot', i: 0.5 } }, { k: 'move', cardId: someId, count: 1, to: { k: 'foundation', id: 'x' } },
    { k: 'move', cardId: someId, count: 1, to: { k: 'newFoundation' } }, { k: 'hold' }, { k: 'hold', cardId: 7 }, { k: 'hold', cardId: '' },
    { k: 'hold', cardId: 'x'.repeat(10_000) }, { k: 'hold', cardId: '__proto__' }, { k: 'clear' }, { k: 'clear', slot: -1 },
    { k: 'clear', slot: 24 }, { k: 'clear', slot: '1' }, { k: 'clear', slot: 1.5 }, { k: 'clear', slot: 0 }, { k: 'release' },
    { k: 'move', cardId: 5, to: { k: 'work', i: 0 } }, { k: 'move', cardId: null, to: { k: 'work', i: 0 } },
    { k: 'move', cardId: ['a'], to: { k: 'work', i: 0 } }, { k: 'move', cardId: 'x'.repeat(10_000), to: { k: 'work', i: 0 } },
    { k: 'move', cardId: '__proto__', to: { k: 'slot', i: 0 } }, { k: 'move', cardId: 'constructor', to: { k: 'work', i: 0 } },
    { k: 'stuck' }, { k: 'stuck', on: 'yes' }, { k: 'stuck', on: 1 }, { k: ['flip'] }, { k: { toString: () => 'flip' } },
    JSON.parse('{"__proto__": {"k": "flip"}}'), Object.create({ k: 'flip' }), new Date(), new Map([['k', 'flip']]),
  ];

  it('rejects malformed intents without throwing', () => {
    for (const g of garbage) {
      let r!: Result;
      expect(() => (r = applyIntent(state, 0, g as Intent))).not.toThrow();
      // The two prototype-carried {k:'flip'} objects are well-formed enough to count as a flip; everything else is refused.
      if (r.ok) expect(checkInvariants(r.state)).toBeNull();
      else expect(typeof r.reason).toBe('string');
    }
    expect(garbage.filter((g) => applyIntent(state, 0, g as Intent).ok).length).toBeLessThanOrEqual(2);
  });

  it('rejects garbage seats without throwing', () => {
    for (const seat of [-1, 2, 0.5, NaN, Infinity, '0', null, undefined, {}, []]) {
      for (const intent of [{ k: 'flip' }, NERTZ, { k: 'stuck', on: true }, move(someId, work(0)), hold(someId), RELEASE, { k: 'clear', slot: 0 }] as Intent[]) {
        let r!: Result;
        expect(() => (r = applyIntent(state, seat as number, intent))).not.toThrow();
        expect(r.ok).toBe(false);
      }
      expect(() => canDrop(state, seat as number, someId, work(0))).not.toThrow();
      expect(() => grab(state, seat as number, someId)).not.toThrow();
      expect(legalDrops(state, seat as number, someId)).toEqual([]);
    }
  });

  it('survives randomly generated junk', () => {
    const rng = mulberry32(99);
    const atoms: unknown[] = [null, undefined, 0, 1, 3, -1, 1.5, NaN, '', 'k', 'move', 'flip', 'work', 'slot', 'hold', 'release', 'clear', 'nertz', someId, true, false, [], {}];
    const keys = ['k', 'cardId', 'to', 'i', 'slot', 'on', 'x'];
    const junk = (depth: number): unknown => {
      if (depth > 2 || rng() < 0.4) return atoms[Math.floor(rng() * atoms.length)];
      const o: Record<string, unknown> = {};
      for (const key of keys) if (rng() < 0.5) o[key] = junk(depth + 1);
      return o;
    };
    for (let n = 0; n < 5000; n++) {
      const g = junk(0);
      let r!: Result;
      expect(() => (r = applyIntent(state, n % 3, g as Intent))).not.toThrow();
      if (r.ok) expect(checkInvariants(r.state)).toBeNull();
    }
  });
});

// ---------------------------------------------------------------- random play

/** Every (card, target) pair `seat` may play right now. */
function legalMoves(s: GameState, seat: number): Intent[] {
  const p = s.players.find((q) => q.seat === seat)!;
  const cards = [p.nertz.at(-1), p.waste.at(-1), ...p.work.flat()].filter((x) => x !== undefined);
  return cards.flatMap((card) => legalDrops(s, seat, card.id).filter((to) => canDrop(s, seat, card.id, to)).map((to) => move(card.id, to, grab(s, seat, card.id)!.cards.length)));
}

/** A mix of sensible and hostile intents. Only looks at what is visible in `s`, so it works on views as well. */
function randomIntent(s: GameState, seat: number, rng: Rng): Intent {
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)]!;
  const me = s.players.find((q) => q.seat === seat)!;
  const roll = rng();
  if (me.holding !== null && roll < 0.4) {
    // Someone mid-drag often finishes it: on a legal spot, back where it was, or (rarely) somewhere silly.
    const drops = legalDrops(s, seat, me.holding);
    if (drops.length && roll < 0.25) return move(me.holding, pick(drops), grab(s, seat, me.holding)!.cards.length);
    return roll < 0.35 ? RELEASE : move(me.holding, slot(Math.floor(rng() * s.slots.length)));
  }
  if (roll < 0.25) return { k: 'flip' };
  if (roll < 0.29) return { k: 'stuck', on: rng() < 0.7 };
  if (roll < 0.34) return NERTZ;
  if (roll < 0.38) return RELEASE;
  if (roll < 0.42) {
    const full = s.slots.flatMap((pile, i) => (isComplete(pile) ? [i] : []));
    return { k: 'clear', slot: full.length && rng() < 0.9 ? pick(full) : Math.floor(rng() * 24) };
  }
  if (roll < 0.6) {
    const mine = [me.nertz.at(-1), me.waste.at(-1), ...me.work.flat()].filter((x) => x !== undefined);
    const playable = mine.filter((x) => legalDrops(s, seat, x.id).length > 0);
    if (mine.length) return hold(pick(playable.length && rng() < 0.8 ? playable : mine).id);
  }
  if (roll < 0.86) {
    const legal = legalMoves(s, seat);
    if (legal.length) return pick(legal);
  }
  const everything = allCards(s);
  const mine = everything.filter((x) => x.owner === seat);
  const card = rng() < 0.8 && mine.length ? pick(mine) : pick(everything);
  if (rng() < 0.15) return hold(card.id);
  const targets: PileRef[] = [slot(23), ...s.slots.map((_, i) => slot(i)), ...[0, 1, 2, 3].map(work)];
  return move(card.id, pick(targets), 1 + Math.floor(rng() * 3));
}

/** A deal with only `n` cards in each nertz pile (the rest go under the stock), so that Nertz calls actually happen in random play. */
function shortDeal(seats: readonly number[], rng: Rng, n = 2): GameState {
  const g = deal(seats, rng);
  return { ...g, players: g.players.map((p) => ({ ...p, nertz: p.nertz.slice(-n), stock: [...p.nertz.slice(0, -n), ...p.stock] })) };
}

describe('random play keeps every invariant', () => {
  for (const [seed, seatCount, short] of [[1, 2, false], [2, 3, false], [3, 4, true], [4, 6, true], [5, 2, true]] as const) {
    it(`seed ${seed}, ${seatCount} seats, 4000 intents${short ? ', short nertz piles' : ''}`, () => {
      const rng = mulberry32(seed);
      const seats = Array.from({ length: seatCount }, (_, i) => i * 2); // non-contiguous seats on purpose
      const fresh = () => deepFreeze(short ? shortDeal(seats, rng) : deal(seats, rng));
      let state = fresh();
      const seen = { accepted: 0, rotations: 0, rounds: 0, graces: 0, graceMoves: 0, cleared: 0, centre: 0, reveals: 0 };
      for (let step = 0; step < 4000; step++) {
        const seat = seats[Math.floor(rng() * seats.length)]!;
        const intent = randomIntent(state, seat, rng);
        const before = state;
        const r = applyIntent(state, seat, intent); // throws if it mutates the frozen state
        if (r.ok) {
          seen.accepted++;
          const resolved = resolveStuck(r.state, seats);
          if (resolved !== r.state) seen.rotations++;
          state = deepFreeze(resolved);
          const problem = checkInvariants(state) ?? checkInvariants(viewFor(state, seat));
          if (problem) throw new Error(`step ${step}, seat ${seat}, ${JSON.stringify(intent)}: ${problem}`);
          expect(allCards(state)).toHaveLength(52 * seatCount);
          expect(state.slots).toHaveLength(4 * seatCount);
          if (before.nertzCalledBy === null && state.grace.length > 0) seen.graces++;
          if (before.nertzCalledBy !== null) {
            // In grace: only someone who was in it can have acted, they are out of it now, and nobody was added.
            expect(before.grace).toContain(seat);
            expect(state.grace).not.toContain(seat);
            expect(state.grace.every((g) => before.grace.includes(g))).toBe(true);
            if (intent.k === 'move') seen.graceMoves++;
          }
          if (intent.k === 'clear') {
            seen.cleared++;
            expect(completedBy(before.slots[intent.slot]!)).toBe(seat);
            expect(state.tray.at(-1)).toEqual(before.slots[intent.slot]);
            expect(state.slots[intent.slot]).toEqual([]);
          }
          const downs = (g: GameState) => g.players.reduce((n, p) => n + p.down.reduce((a, b) => a + b, 0), 0);
          if (downs(state) < downs(before)) seen.reveals++;
        }
        // The server's timer, played by the dice: grace does not last for ever.
        if (state.nertzCalledBy !== null && rng() < 0.1) state = deepFreeze(expireGrace(state));
        if (isOver(state)) {
          expect(checkInvariants(state)).toBeNull();
          expect(state.players.every((p) => p.holding === null)).toBe(true);
          expect(scoreRound(state).reduce((n, x) => n + x.played, 0)).toBe([...state.slots, ...state.tray].flat().length);
          for (const intent of [{ k: 'flip' }, RELEASE, NERTZ] as Intent[]) rejected(applyIntent(state, seat, intent));
          seen.centre += state.slots.flat().length + state.tray.flat().length;
          seen.rounds++;
          state = fresh();
        }
      }
      seen.centre += state.slots.flat().length;
      expect(seen.accepted).toBeGreaterThan(1500);
      expect(seen.centre + seen.rotations).toBeGreaterThan(0);
      expect(seen.reveals).toBeGreaterThan(0);
      if (short) {
        expect(seen.rounds).toBeGreaterThan(0);
        if (seatCount > 2) expect(seen.graces).toBeGreaterThan(0);
      }
    });
  }

  it('long games reach kings, clears and slot reuse without breaking anything', () => {
    // Greedy play to the middle by four seats, never calling Nertz, clearing finished piles as they appear.
    const rng = mulberry32(77);
    const seats = [0, 1, 2, 3];
    let state = deal(seats, rng);
    let cleared = 0;
    let reused = 0;
    const freed = new Set<number>();
    for (let step = 0; step < 60_000 && cleared < 3; step++) {
      const seat = seats[step % 4]!;
      const done = state.slots.findIndex((pile) => completedBy(pile) === seat);
      const legal = legalMoves(state, seat);
      const toMiddle = legal.filter((m) => m.k === 'move' && m.to.k === 'slot');
      const fromNertz = legal.filter((m) => m.k === 'move' && grab(state, seat, m.cardId)!.from.k !== 'work');
      const intent: Intent =
        done >= 0 ? { k: 'clear', slot: done } : (toMiddle[0] ?? (rng() < 0.5 ? fromNertz[0] : undefined) ?? (rng() < 0.1 ? legal[0] : undefined) ?? { k: 'flip' });
      const me = state.players[seat]!;
      const r = applyIntent(state, seat, me.stock.length + me.waste.length === 0 ? { k: 'stuck', on: true } : intent);
      if (!r.ok) continue;
      if (intent.k === 'clear') (cleared++, freed.add(intent.slot));
      if (intent.k === 'move' && intent.to.k === 'slot' && freed.has(intent.to.i) && r.state.slots[intent.to.i]!.length === 1) reused++;
      state = resolveStuck(r.state, seats);
      expect(checkInvariants(state)).toBeNull();
    }
    expect(state.tray.length).toBe(cleared);
    expect(scoreRound(state).reduce((n, x) => n + x.played, 0)).toBe(state.slots.flat().length + 13 * cleared);
    expect(cleared).toBe(3);
    expect(reused).toBeGreaterThan(0); // an Ace went into a slot a finished pile had been cleared from
  });
});

describe('greedy bots can finish a round', () => {
  /** Middle first, then nertz to work, then turning over a face-down work card, then waste to work, otherwise flip. Declares stuck after a fruitless lap of the stock. */
  function botIntent(s: GameState, seat: number, idle: number): Intent {
    const p = s.players.find((q) => q.seat === seat)!;
    if (p.nertz.length === 0) return NERTZ;
    const legal = legalMoves(s, seat).filter((m) => m.k === 'move');
    const from = (m: Intent) => (m.k === 'move' ? grab(s, seat, m.cardId)!.from.k : 'work');
    const to = (m: Intent) => (m.k === 'move' ? m.to.k : 'work');
    /** Lifts the whole face-up part of a work pile that still has face-down cards under it. */
    const uncovers = (m: Intent): boolean => {
      const g = m.k === 'move' ? grab(s, seat, m.cardId)! : null;
      return g?.from.k === 'work' && p.down[g.from.i]! > 0 && p.work[g.from.i]!.length - g.cards.length === p.down[g.from.i];
    };
    const best =
      legal.find((m) => to(m) !== 'work') ??
      legal.find((m) => from(m) === 'nertz') ??
      legal.find(uncovers) ??
      legal.find((m) => from(m) === 'waste');
    if (best) return best;
    if (p.stock.length + p.waste.length === 0 || (idle > 40 && !p.stuck)) return { k: 'stuck', on: true };
    return { k: 'flip' };
  }

  it('plays whole rounds to a nertz call with consistent scores', () => {
    let finished = 0;
    for (let seed = 1; seed <= 12; seed++) {
      const rng = mulberry32(seed * 101);
      const seats = [0, 1, 2, 3];
      let state = deal(seats, rng);
      const idle = new Map(seats.map((s) => [s, 0]));
      for (let step = 0; step < 20_000 && state.nertzCalledBy === null; step++) {
        const seat = seats[Math.floor(rng() * seats.length)]!;
        const intent = botIntent(state, seat, idle.get(seat)!);
        const r = applyIntent(state, seat, intent);
        if (!r.ok) throw new Error(`bot move rejected at step ${step}: ${JSON.stringify(intent)} (${r.reason})`);
        idle.set(seat, intent.k === 'move' ? 0 : idle.get(seat)! + 1);
        state = resolveStuck(r.state, seats);
        if (state !== r.state) seats.forEach((s) => idle.set(s, 0));
        expect(checkInvariants(state)).toBeNull();
      }
      if (state.nertzCalledBy === null) continue;
      finished++;
      expect(isOver(state)).toBe(true); // nobody was holding anything
      const scores = scoreRound(state);
      const caller = scores.find((x) => x.seat === state.nertzCalledBy)!;
      expect(caller.nertzLeft).toBe(0);
      expect(caller.delta).toBe(caller.played);
      for (const x of scores) expect(x.delta).toBe(x.played - 2 * x.nertzLeft);
      expect(scores.reduce((n, x) => n + x.played, 0)).toBe(state.slots.flat().length);
    }
    expect(finished).toBeGreaterThanOrEqual(6);
  }, 30_000);
});

// ---------------------------------------------------------------- prediction

/**
 * `predicted` is what a client computed by running the reducer on its view;
 * `truth` is the real server state after the same intents. They must agree on
 * structure and ids everywhere, and wherever the client shows a face it must
 * be the true face. The client may know less than the fresh view (a card the
 * server just revealed) or more (waste cards it saw before recycling them).
 */
function expectPredictionMatches(predicted: GameState, truth: GameState) {
  expect(predicted.nertzCalledBy).toBe(truth.nertzCalledBy);
  expect(predicted.grace).toEqual(truth.grace);
  expect(predicted.slots).toEqual(truth.slots);
  expect(predicted.tray).toEqual(truth.tray);
  expect(predicted.players).toHaveLength(truth.players.length);
  for (const [i, real] of truth.players.entries()) {
    const pred = predicted.players[i]!;
    expect(pred.seat).toBe(real.seat);
    expect(pred.stuck).toBe(real.stuck);
    expect(pred.holding).toBe(real.holding);
    expect(pred.down).toEqual(real.down);
    const piles = (p: PlayerState) => [p.nertz, p.stock, p.waste, ...p.work];
    const realPiles = piles(real);
    for (const [j, pile] of piles(pred).entries()) {
      expect(ids(pile)).toEqual(ids(realPiles[j]!));
      for (const [k, card] of pile.entries()) if (!isHidden(card)) expect(card).toEqual(realPiles[j]![k]);
    }
  }
}

/** Cards face-up in a fresh view but still hidden in the prediction: the "newly revealed" ones. */
const unrevealed = (predicted: GameState, freshView: GameState): number => {
  const shown = new Set(allCards(freshView).filter((x) => !isHidden(x)).map((x) => x.id));
  return allCards(predicted).filter((x) => isHidden(x) && shown.has(x.id)).length;
};

describe('client prediction on a redacted view agrees with the server', () => {
  it('single intents, grace included: same verdict, same visible result, at most the newly revealed cards unknown', () => {
    let graceIntents = 0;
    for (const seed of [21, 22, 23]) {
      const rng = mulberry32(seed);
      const seats = [0, 1, 2];
      let state = shortDeal(seats, rng);
      for (let step = 0; step < 3000; step++) {
        const seat = seats[Math.floor(rng() * seats.length)]!;
        const view = deepFreeze(viewFor(state, seat));
        const intent = randomIntent(view, seat, rng);
        const onView = applyIntent(view, seat, intent);
        const onTruth = applyIntent(state, seat, intent);
        expect(onView.ok, `step ${step} ${JSON.stringify(intent)}`).toBe(onTruth.ok);
        if (onView.ok && onTruth.ok) {
          if (state.nertzCalledBy !== null) graceIntents++;
          expectPredictionMatches(onView.state, onTruth.state);
          const revealed = unrevealed(onView.state, viewFor(onTruth.state, seat));
          expect(revealed).toBeLessThanOrEqual(intent.k === 'flip' ? 3 : 1);
          if (intent.k !== 'move' && intent.k !== 'flip') expect(onView.state).toEqual(viewFor(onTruth.state, seat));
          state = resolveStuck(onTruth.state, seats);
        }
        if (state.nertzCalledBy !== null && rng() < 0.1) state = expireGrace(state);
        if (isOver(state)) state = shortDeal(seats, rng);
      }
    }
    expect(graceIntents).toBeGreaterThan(0);
  });

  it('chains of unacknowledged intents: whatever the client accepts, the server accepts identically', () => {
    for (const seed of [31, 32, 33]) {
      const rng = mulberry32(seed);
      const seats = [0, 1];
      let state = deal(seats, rng);
      let diverged = 0;
      for (let round = 0; round < 600; round++) {
        const seat = seats[Math.floor(rng() * seats.length)]!;
        let predicted = viewFor(state, seat);
        const length = 1 + Math.floor(rng() * 6);
        for (let n = 0; n < length; n++) {
          const intent = randomIntent(predicted, seat, rng);
          const onView = applyIntent(predicted, seat, intent);
          const onTruth = applyIntent(state, seat, intent);
          if (onTruth.ok) state = onTruth.state;
          if (onView.ok) {
            // The client never predicts something the server then refuses (absent other players' moves).
            expect(onTruth.ok, `round ${round} ${JSON.stringify(intent)}`).toBe(true);
            predicted = onView.state;
            expectPredictionMatches(predicted, state);
            expect(checkInvariants(predicted)).toBeNull(); // including a just-uncovered work card whose face is not known yet
          } else if (onTruth.ok) {
            // Only possible when the move involved a card the client could not see yet; it resyncs from the snapshot.
            diverged++;
            break;
          }
        }
        if (state.nertzCalledBy !== null) state = deal(seats, rng);
      }
      expect(diverged).toBeLessThan(200);
    }
  });

  it('a lost race simply drops the pending intent when replayed over the newer snapshot', () => {
    const s = game([player(0, { nertz: cs('S9 H2') }), player(1, { nertz: cs('D9 H2', 1) })], [pile('HA', 0), pile('HA', 1)]);
    const pending = move('1:H2', slot(0));
    // seat 1 predicts its own move locally
    const predicted = ok(applyIntent(viewFor(s, 1), 1, pending));
    expect(predicted.slots[0]).toHaveLength(2);
    // but the server processed seat 0 first; seat 1's intent is rejected there...
    const server = ok(applyIntent(s, 0, move('0:H2', slot(0))));
    rejected(applyIntent(server, 1, pending));
    // ...and replaying it over the new snapshot fails the same way, so the card just goes home (not to the other ace)
    rejected(applyIntent(viewFor(server, 1), 1, pending));
    expect(ids(viewFor(server, 1).players[1]!.nertz)).toEqual(['1:D9', '1:H2']);
    expect(viewFor(server, 1).slots[1]).toHaveLength(1);
  });
});
