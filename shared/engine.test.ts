import { describe, expect, it } from 'vitest';
import {
  applyIntent,
  bestFoundation,
  canDrop,
  checkInvariants,
  deal,
  grab,
  isComplete,
  isHidden,
  resolveStuck,
  scoreRound,
  viewFor,
  type Result,
  type Rng,
} from './engine';
import type { AnyCard, Card, Foundation, GameState, Intent, PileRef, PlayerState, Suit } from './types';

// ---------------------------------------------------------------- helpers

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
  stock: [],
  waste: [],
  stuck: false,
  ...parts,
});

/** A foundation built from its ace up to `topFace`, all cards owned by `owner`. */
function foundation(topFace: string, owner = 0): Foundation {
  const suit = topFace[0] as Suit;
  const n = RANKS.indexOf(topFace.slice(1)) + 1;
  const cards = RANKS.slice(0, n).map((r) => c(suit + r, owner));
  return { id: cards[0]!.id, suit, cards };
}

const game = (players: PlayerState[], foundations: Foundation[] = []): GameState => ({ players, foundations, nertzCalledBy: null });
const move = (cardId: string, to: PileRef): Intent => ({ k: 'move', cardId, to });
const work = (i: number): PileRef => ({ k: 'work', i });
const NEW: PileRef = { k: 'newFoundation' };
const ids = (pile: AnyCard[]) => pile.map((x) => x.id);

function ok(r: Result): GameState {
  if (!r.ok) throw new Error(`expected ok, got: ${r.reason}`);
  return r.state;
}
const rejected = (r: Result) => expect(r.ok).toBe(false);

function deepFreeze<T>(v: T): T {
  if (typeof v === 'object' && v !== null && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const x of Object.values(v)) deepFreeze(x);
  }
  return v;
}

const allCards = (s: GameState): AnyCard[] => [
  ...s.players.flatMap((p) => [...p.nertz, ...p.stock, ...p.waste, ...p.work.flat()]),
  ...s.foundations.flatMap((f) => f.cards),
];

// ---------------------------------------------------------------- deal

describe('deal', () => {
  const state = deal([0, 1, 2], mulberry32(1));

  it('gives every seat 13 nertz, 4 single-card work piles, 35 stock and an empty waste', () => {
    expect(state.players.map((p) => p.seat)).toEqual([0, 1, 2]);
    for (const p of state.players) {
      expect(p.nertz).toHaveLength(13);
      expect(p.work.map((w) => w.length)).toEqual([1, 1, 1, 1]);
      expect(p.stock).toHaveLength(35);
      expect(p.waste).toHaveLength(0);
      expect(p.stuck).toBe(false);
      const faces = new Set([...p.nertz, ...p.stock, ...p.work.flat()].map((x) => (isHidden(x) ? '?' : `${x.suit}${x.rank}`)));
      expect(faces.size).toBe(52);
    }
    expect(state.foundations).toEqual([]);
    expect(state.nertzCalledBy).toBeNull();
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
    const a = ok(applyIntent(s, 0, move('0:H8', work(1))));
    expect(ids(a.players[0]!.work[0]!)).toEqual(['0:S9']);
    expect(ids(a.players[0]!.work[1]!)).toEqual(['0:C9', '0:H8', '0:C7', '0:D6']);
    const b = ok(applyIntent(s, 0, move('0:C7', work(3))));
    expect(ids(b.players[0]!.work[0]!)).toEqual(['0:S9', '0:H8']);
    expect(ids(b.players[0]!.work[3]!)).toEqual(['0:C7', '0:D6']);
    rejected(applyIntent(s, 0, move('0:C7', work(1)))); // 7 on 9
    rejected(applyIntent(s, 0, move('0:D6', work(2)))); // red on red
    rejected(applyIntent(s, 0, move('0:H8', work(0)))); // onto itself
    expect(grab(s, 0, '0:C7')).toEqual({ from: { k: 'work', i: 0 }, cards: cs('C7 D6') });
  });

  it('refuses the pointless move of a whole pile onto an empty pile', () => {
    const s = game([player(0, { work: [cs('S9 H8'), [], cs('H10'), []] })]);
    rejected(applyIntent(s, 0, move('0:S9', work(1))));
    expect(canDrop(s, 0, '0:S9', work(1))).toBe(false);
    ok(applyIntent(s, 0, move('0:H8', work(1))));
    ok(applyIntent(s, 0, move('0:S9', work(2))));
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

// ---------------------------------------------------------------- foundations

describe('foundations', () => {
  it('an ace starts a new foundation whose id is the ace id', () => {
    const s = game([player(0, { nertz: cs('S5 HA') })]);
    const next = ok(applyIntent(s, 0, move('0:HA', NEW)));
    expect(next.foundations).toEqual([{ id: '0:HA', suit: 'H', cards: [c('HA')] }]);
    expect(ids(next.players[0]!.nertz)).toEqual(['0:S5']);
    rejected(applyIntent(s, 1, move('0:HA', NEW)));
  });

  it('builds up by suit from nertz, waste and work tops, across owners', () => {
    const s = game(
      [player(0, { nertz: cs('H2'), waste: cs('S9 H3'), work: [cs('S5 H4'), [], [], []] }), player(1, { nertz: cs('H2', 1) })],
      [foundation('HA', 1)],
    );
    const f: PileRef = { k: 'foundation', id: '1:HA' };
    let next = ok(applyIntent(s, 0, move('0:H2', f)));
    next = ok(applyIntent(next, 0, move('0:H3', f)));
    next = ok(applyIntent(next, 0, move('0:H4', f)));
    expect(ids(next.foundations[0]!.cards)).toEqual(['1:HA', '0:H2', '0:H3', '0:H4']);
    rejected(applyIntent(next, 1, move('1:H2', f))); // too late
    rejected(applyIntent(s, 0, move('0:H3', f))); // skips a rank
    rejected(applyIntent(s, 0, move('0:S5', f))); // not the top of its work pile, and wrong suit
  });

  it('only single cards go to a foundation', () => {
    const s = game([player(0, { work: [cs('H3 S2'), [], [], []] })], [foundation('H2', 1), foundation('SA', 1)]);
    rejected(applyIntent(s, 0, move('0:H3', { k: 'foundation', id: '1:HA' })));
    expect(canDrop(s, 0, '0:H3', { k: 'foundation', id: '1:HA' })).toBe(false);
    ok(applyIntent(s, 0, move('0:S2', { k: 'foundation', id: '1:SA' })));
  });

  it('a king completes a foundation, which then takes nothing more', () => {
    const s = game([player(0, { nertz: cs('SK') }), player(1, { nertz: cs('SK', 1) })], [foundation('SQ', 1)]);
    expect(isComplete(s.foundations[0]!)).toBe(false);
    const next = ok(applyIntent(s, 0, move('0:SK', { k: 'foundation', id: '1:SA' })));
    expect(isComplete(next.foundations[0]!)).toBe(true);
    expect(next.foundations[0]!.cards).toHaveLength(13);
    rejected(applyIntent(next, 1, move('1:SK', { k: 'foundation', id: '1:SA' })));
    expect(bestFoundation(next, '1:SK')).toBeNull();
  });

  describe('fallback when the targeted pile was taken', () => {
    // Two heart foundations at the ace; both players hold a 2 of hearts and aim at the same pile.
    const s = game(
      [player(0, { nertz: cs('H2') }), player(1, { nertz: cs('H2', 1) }), player(2, { nertz: cs('H2', 2) })],
      [foundation('HA', 0), foundation('HA', 1)],
    );
    const target: PileRef = { k: 'foundation', id: '0:HA' };

    it('plays on another foundation that accepts the card', () => {
      const afterFirst = ok(applyIntent(s, 0, move('0:H2', target)));
      expect(canDrop(afterFirst, 1, '1:H2', target)).toBe(false); // strict helper says no...
      const afterSecond = ok(applyIntent(afterFirst, 1, move('1:H2', target))); // ...but the reducer reroutes
      expect(ids(afterSecond.foundations[0]!.cards)).toEqual(['0:HA', '0:H2']);
      expect(ids(afterSecond.foundations[1]!.cards)).toEqual(['1:HA', '1:H2']);
      expect(bestFoundation(afterFirst, '1:H2')).toEqual({ k: 'foundation', id: '1:HA' });
    });

    it('rejects only when no foundation accepts it', () => {
      const a = ok(applyIntent(s, 0, move('0:H2', target)));
      const b = ok(applyIntent(a, 1, move('1:H2', target)));
      const r = applyIntent(b, 2, move('2:H2', target));
      rejected(r);
      expect(bestFoundation(b, '2:H2')).toBeNull();
    });

    it('reroutes stale or nonsensical foundation targets', () => {
      // a foundation id that does not exist (any more)
      expect(ids(ok(applyIntent(s, 0, move('0:H2', { k: 'foundation', id: 'gone' }))).foundations[0]!.cards)).toEqual(['0:HA', '0:H2']);
      // a non-ace aimed at "new foundation"
      expect(ok(applyIntent(s, 0, move('0:H2', NEW))).foundations[0]!.cards).toHaveLength(2);
      // an ace aimed at an existing foundation starts its own
      const aces = game([player(0, { nertz: cs('HA') })], [foundation('HA', 1)]);
      const next = ok(applyIntent(aces, 0, move('0:HA', { k: 'foundation', id: '1:HA' })));
      expect(next.foundations.map((f) => f.id)).toEqual(['1:HA', '0:HA']);
      expect(bestFoundation(aces, '0:HA')).toEqual(NEW);
    });
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
    rejected(applyIntent(a, 0, move('0:H6', NEW))); // a refused move changes nothing
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

  it('is a no-op once the round is over', () => {
    const over = { ...stuck(stuck(stuck(base, 0), 1), 2), nertzCalledBy: 1 };
    expect(resolveStuck(over, [0, 1, 2])).toBe(over);
  });
});

// ---------------------------------------------------------------- nertz + scoring

describe('calling nertz and scoring', () => {
  const s = game(
    [player(0, { nertz: cs('HA'), work: [cs('S9'), [], [], []] }), player(1, { nertz: cs('C5 C6 C7', 1), stock: cs('D2', 1) })],
    [{ ...foundation('S3', 1), cards: [c('SA', 1), c('S2', 0), c('S3', 1)] }],
  );

  it('is refused while the nertz pile has cards', () => {
    rejected(applyIntent(s, 0, { k: 'nertz' }));
    rejected(applyIntent(s, 1, { k: 'nertz' }));
    rejected(applyIntent(s, 5, { k: 'nertz' }));
  });

  it('is an explicit action that ends the round and freezes the table', () => {
    const emptied = ok(applyIntent(s, 0, move('0:HA', NEW)));
    expect(emptied.nertzCalledBy).toBeNull(); // emptying the pile does not end the round by itself
    const over = ok(applyIntent(emptied, 0, { k: 'nertz' }));
    expect(over.nertzCalledBy).toBe(0);
    for (const intent of [{ k: 'flip' }, { k: 'nertz' }, { k: 'stuck', on: true }, move('1:C7', work(0))] as Intent[]) {
      rejected(applyIntent(over, 1, intent));
    }
    expect(canDrop(over, 1, '1:C7', work(0))).toBe(false);
    expect(scoreRound(over)).toEqual([
      { seat: 0, foundation: 2, nertzLeft: 0, delta: 2 },
      { seat: 1, foundation: 2, nertzLeft: 3, delta: -4 },
    ]);
  });
});

// ---------------------------------------------------------------- views

describe('viewFor', () => {
  const full = deal([0, 1], mulberry32(3));
  const flipped = ok(applyIntent(full, 0, { k: 'flip' }));
  const view = viewFor(flipped, 0);

  it('hides every stock (your own too) and everything under each nertz top, keeping ids and owners', () => {
    for (const [pi, p] of view.players.entries()) {
      const real = flipped.players[pi]!;
      expect(p.stock.every(isHidden)).toBe(true);
      expect(p.nertz.slice(0, -1).every(isHidden)).toBe(true);
      expect(p.nertz.at(-1)).toEqual(real.nertz.at(-1));
      expect(p.work).toEqual(real.work);
      expect(p.waste).toEqual(real.waste);
      expect(ids(p.stock)).toEqual(ids(real.stock));
      expect(ids(p.nertz)).toEqual(ids(real.nertz));
      expect(p.stock.every((x) => x.owner === p.seat)).toBe(true);
    }
    expect(view.players[0]!.waste).toHaveLength(3);
  });

  it('leaks no face of a hidden card', () => {
    const hiddenIds = new Set(allCards(view).filter(isHidden).map((x) => x.id));
    expect(hiddenIds.size).toBe(2 * 12 + 32 + 35);
    for (const x of allCards(view).filter(isHidden)) expect(Object.keys(x).sort()).toEqual(['hidden', 'id', 'owner']);
    expect(JSON.stringify(view)).not.toMatch(/"rank":\d+,"hidden"|"hidden":true,"suit"/);
  });

  it('is idempotent, passes the invariant check, and does not mutate its input', () => {
    expect(viewFor(view, 1)).toEqual(view);
    expect(checkInvariants(view)).toBeNull();
    const frozen = deepFreeze(deal([0, 1], mulberry32(4)));
    expect(() => viewFor(frozen, 0)).not.toThrow();
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
    rejected(applyIntent(withGap, 0, move(hiddenTop, NEW)));
    expect(grab(withGap, 0, hiddenTop)).toBeNull();
    expect(bestFoundation(withGap, hiddenTop)).toBeNull();
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
  it('catches a broken work run', () =>
    expect(checkInvariants(withPlayer0((p) => ({ work: [[...p.work[0]!, ...p.work[1]!, ...p.work[2]!], [], [], p.work[3]!] })))).toMatch(
      /alternating run/,
    ));
  it('catches a nertz call with cards left', () => expect(checkInvariants({ ...good, nertzCalledBy: 0 })).toMatch(/nertz called/));
  it('catches a wrong number of work piles', () => expect(checkInvariants(withPlayer0((p) => ({ work: p.work.slice(1) })))).toMatch(/work piles/));
  it("catches a card in someone else's pile", () => {
    const [a, b] = good.players as [PlayerState, PlayerState];
    const swapped = { ...good, players: [{ ...a, waste: [b.stock[0]!] }, { ...b, stock: b.stock.slice(1) }] };
    expect(checkInvariants(swapped)).toMatch(/owned by seat 1/);
  });
  it('catches a malformed foundation', () => {
    const p = good.players[0]!;
    const card = p.work[0]![0] as Card;
    const state = { ...withPlayer0(() => ({ work: [[], ...p.work.slice(1)] })), foundations: [{ id: card.id, suit: card.suit, cards: [card] }] };
    expect(checkInvariants(state)).toMatch(card.rank === 1 ? /^$/ : /ace-up/);
  });
});

// ---------------------------------------------------------------- garbage

describe('robustness', () => {
  const state = deepFreeze(deal([0, 1], mulberry32(11)));
  const someId = state.players[0]!.nertz.at(-1)!.id;
  const garbage: unknown[] = [
    undefined, null, 0, 1, -1, NaN, Infinity, '', 'flip', true, [], [1, 2], {}, () => 1, Symbol('x'), 10n,
    { k: null }, { k: 'fly' }, { k: 'move' }, { k: 'move', cardId: someId }, { k: 'move', cardId: someId, to: null },
    { k: 'move', cardId: someId, to: 'work' }, { k: 'move', cardId: someId, to: {} }, { k: 'move', cardId: someId, to: { k: 'work' } },
    { k: 'move', cardId: someId, to: { k: 'work', i: 1.5 } }, { k: 'move', cardId: someId, to: { k: 'work', i: -1 } },
    { k: 'move', cardId: someId, to: { k: 'work', i: 4 } }, { k: 'move', cardId: someId, to: { k: 'work', i: NaN } },
    { k: 'move', cardId: someId, to: { k: 'work', i: '0' } }, { k: 'move', cardId: someId, to: { k: 'work', i: 2 ** 40 } },
    { k: 'move', cardId: someId, to: { k: 'foundation' } }, { k: 'move', cardId: someId, to: { k: 'foundation', id: 7 } },
    { k: 'move', cardId: someId, to: { k: 'foundation', id: '' } }, { k: 'move', cardId: someId, to: { k: 'foundation', id: {} } },
    { k: 'move', cardId: 5, to: { k: 'work', i: 0 } }, { k: 'move', cardId: null, to: { k: 'work', i: 0 } },
    { k: 'move', cardId: ['a'], to: { k: 'work', i: 0 } }, { k: 'move', cardId: 'x'.repeat(10_000), to: { k: 'work', i: 0 } },
    { k: 'move', cardId: '__proto__', to: { k: 'foundation', id: '__proto__' } }, { k: 'move', cardId: 'constructor', to: { k: 'newFoundation' } },
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
      for (const intent of [{ k: 'flip' }, { k: 'nertz' }, { k: 'stuck', on: true }, move(someId, work(0))] as Intent[]) {
        let r!: Result;
        expect(() => (r = applyIntent(state, seat as number, intent))).not.toThrow();
        expect(r.ok).toBe(false);
      }
      expect(() => canDrop(state, seat as number, someId, work(0))).not.toThrow();
      expect(() => grab(state, seat as number, someId)).not.toThrow();
    }
  });

  it('survives randomly generated junk', () => {
    const rng = mulberry32(99);
    const atoms: unknown[] = [null, undefined, 0, 1, 3, -1, 1.5, NaN, '', 'k', 'move', 'flip', 'work', 'foundation', 'newFoundation', someId, true, false, [], {}];
    const keys = ['k', 'cardId', 'to', 'i', 'id', 'on', 'x'];
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

/** Every (card, target) pair the strict helper says `seat` may play. */
function legalMoves(s: GameState, seat: number): Intent[] {
  const p = s.players.find((q) => q.seat === seat)!;
  const cards = [p.nertz.at(-1), p.waste.at(-1), ...p.work.flat()].filter((x) => x !== undefined);
  const targets: PileRef[] = [NEW, ...s.foundations.map((f): PileRef => ({ k: 'foundation', id: f.id })), ...[0, 1, 2, 3].map(work)];
  return cards.flatMap((card) => targets.filter((to) => canDrop(s, seat, card.id, to)).map((to) => move(card.id, to)));
}

/** A mix of sensible and hostile intents. Only looks at what is visible in `s`, so it works on views as well. */
function randomIntent(s: GameState, seat: number, rng: Rng): Intent {
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)]!;
  const roll = rng();
  if (roll < 0.3) return { k: 'flip' };
  if (roll < 0.34) return { k: 'stuck', on: rng() < 0.7 };
  if (roll < 0.37) return { k: 'nertz' };
  if (roll < 0.75) {
    const legal = legalMoves(s, seat);
    if (legal.length) return pick(legal);
  }
  const everything = allCards(s);
  const mine = everything.filter((x) => x.owner === seat);
  const card = rng() < 0.8 && mine.length ? pick(mine) : pick(everything);
  const targets: PileRef[] = [NEW, { k: 'foundation', id: 'bogus' }, ...s.foundations.map((f): PileRef => ({ k: 'foundation', id: f.id })), ...[0, 1, 2, 3].map(work)];
  return move(card.id, pick(targets));
}

describe('random play keeps every invariant', () => {
  for (const [seed, seatCount] of [[1, 2], [2, 3], [3, 4], [4, 6], [5, 2]] as const) {
    it(`seed ${seed}, ${seatCount} seats, 4000 intents`, () => {
      const rng = mulberry32(seed);
      const seats = Array.from({ length: seatCount }, (_, i) => i * 2); // non-contiguous seats on purpose
      let state = deepFreeze(deal(seats, rng));
      let accepted = 0;
      let rotations = 0;
      for (let step = 0; step < 4000; step++) {
        const seat = seats[Math.floor(rng() * seats.length)]!;
        const intent = randomIntent(state, seat, rng);
        const r = applyIntent(state, seat, intent); // throws if it mutates the frozen state
        if (r.ok) {
          accepted++;
          const resolved = resolveStuck(r.state, seats);
          if (resolved !== r.state) rotations++;
          state = deepFreeze(resolved);
          const problem = checkInvariants(state) ?? checkInvariants(viewFor(state, seat));
          if (problem) throw new Error(`step ${step}, seat ${seat}, ${JSON.stringify(intent)}: ${problem}`);
          expect(allCards(state)).toHaveLength(52 * seatCount);
        }
        if (state.nertzCalledBy !== null) {
          expect(scoreRound(state).reduce((n, x) => n + x.foundation, 0)).toBe(state.foundations.reduce((n, f) => n + f.cards.length, 0));
          state = deepFreeze(deal(seats, rng));
        }
      }
      expect(accepted).toBeGreaterThan(1500);
      expect(state.foundations.length + rotations).toBeGreaterThan(0);
    });
  }
});

describe('greedy bots can finish a round', () => {
  /** Foundations first, then nertz to work, then waste to work, otherwise flip. Declares stuck after a fruitless lap of the stock. */
  function botIntent(s: GameState, seat: number, idle: number): Intent {
    const p = s.players.find((q) => q.seat === seat)!;
    if (p.nertz.length === 0) return { k: 'nertz' };
    const legal = legalMoves(s, seat).filter((m) => m.k === 'move');
    const from = (m: Intent) => (m.k === 'move' ? grab(s, seat, m.cardId)!.from.k : 'work');
    const to = (m: Intent) => (m.k === 'move' ? m.to.k : 'work');
    const best =
      legal.find((m) => to(m) !== 'work') ??
      legal.find((m) => from(m) === 'nertz') ??
      legal.find((m) => from(m) === 'waste');
    if (best) return best;
    if (idle > 40 && !p.stuck) return { k: 'stuck', on: true };
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
      const scores = scoreRound(state);
      const caller = scores.find((x) => x.seat === state.nertzCalledBy)!;
      expect(caller.nertzLeft).toBe(0);
      expect(caller.delta).toBe(caller.foundation);
      for (const x of scores) expect(x.delta).toBe(x.foundation - 2 * x.nertzLeft);
      expect(scores.reduce((n, x) => n + x.foundation, 0)).toBe(state.foundations.reduce((n, f) => n + f.cards.length, 0));
    }
    expect(finished).toBeGreaterThanOrEqual(6);
  });
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
  expect(predicted.foundations).toEqual(truth.foundations);
  expect(predicted.players).toHaveLength(truth.players.length);
  for (const [i, real] of truth.players.entries()) {
    const pred = predicted.players[i]!;
    expect(pred.seat).toBe(real.seat);
    expect(pred.stuck).toBe(real.stuck);
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
  it('single intents: same verdict, same visible result, at most the newly revealed cards unknown', () => {
    for (const seed of [21, 22, 23]) {
      const rng = mulberry32(seed);
      const seats = [0, 1, 2];
      let state = deal(seats, rng);
      for (let step = 0; step < 3000; step++) {
        const seat = seats[Math.floor(rng() * seats.length)]!;
        const view = deepFreeze(viewFor(state, seat));
        const intent = randomIntent(view, seat, rng);
        const onView = applyIntent(view, seat, intent);
        const onTruth = applyIntent(state, seat, intent);
        expect(onView.ok, `step ${step} ${JSON.stringify(intent)}`).toBe(onTruth.ok);
        if (!onView.ok || !onTruth.ok) continue;
        expectPredictionMatches(onView.state, onTruth.state);
        const revealed = unrevealed(onView.state, viewFor(onTruth.state, seat));
        expect(revealed).toBeLessThanOrEqual(intent.k === 'flip' ? 3 : 1);
        if (intent.k === 'stuck' || intent.k === 'nertz') expect(onView.state).toEqual(viewFor(onTruth.state, seat));
        state = onTruth.state.nertzCalledBy === null ? resolveStuck(onTruth.state, seats) : deal(seats, rng);
      }
    }
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
    const s = game([player(0, { nertz: cs('S9 H2') }), player(1, { nertz: cs('D9 H2', 1) })], [foundation('HA', 0)]);
    const target: PileRef = { k: 'foundation', id: '0:HA' };
    const pending = move('1:H2', target);
    // seat 1 predicts its own move locally
    const predicted = ok(applyIntent(viewFor(s, 1), 1, pending));
    expect(predicted.foundations[0]!.cards).toHaveLength(2);
    // but the server processed seat 0 first; seat 1's intent is rejected there...
    const server = ok(applyIntent(s, 0, move('0:H2', target)));
    rejected(applyIntent(server, 1, pending));
    // ...and replaying it over the new snapshot fails the same way, so the card just goes home
    rejected(applyIntent(viewFor(server, 1), 1, pending));
    expect(ids(viewFor(server, 1).players[1]!.nertz)).toEqual(['1:D9', '1:H2']);
  });
});
