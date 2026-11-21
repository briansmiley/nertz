import { describe, expect, it } from 'vitest';
import { cardSize, clash, onTable, pileGap, TABLE } from './table';
import {
  applyIntent,
  calledBy,
  canDrop,
  checkInvariants,
  CLEAR_FIRST,
  completedBy,
  deal as dealRound,
  expireGrace,
  feltFree,
  finishDeal,
  grab,
  inGrace,
  isComplete,
  isHidden,
  isLive,
  isOver,
  legalDrops,
  mustClear,
  openPlay,
  refused,
  canProgress,
  dragsOn,
  RESHUFFLES_BEFORE_VOTE,
  endVote,
  resolveEndVote,
  resolveStuck,
  scoreRound,
  seatedPeople,
  snipedBy,
  startCountdown,
  viewFor,
  wentOut,
  yetToHear,
  type Result,
  type Rng,
} from './engine';
import { allCards, card as c, cards as cs, downs, felt, hold, inPlay, FUZZ_MS, legalMoves, MIXES, move, pile, randomIntent, roomOf, seeded, slot, table, untilReached, work, type Hand } from './testkit';
import type { AnyCard, Card, GameState, Intent, PileRef, PlayerState, PlayerView, Suit } from './types';

// ---------------------------------------------------------------- helpers

/** Every card lying in the centre slots. */
const inSlots = (s: GameState): Card[] => s.slots.flatMap((p) => p?.cards ?? []);
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

const FLIP: Intent = { k: 'flip' };
/** `n` cards off `seat`'s stock, one action each (three make a group). */
const flips = (s: GameState, seat: number, n = 3): GameState => run(s, ...Array.from({ length: n }, (): [number, Intent] => [seat, FLIP]));
/** The ids of `seat`'s stock but its top `n`: on a table built by hand, the rest of the deck beneath the stock it names. */
const under = (s: GameState, seat: number, n: number) => {
  const stock = s.players[seat]!.stock;
  return ids(stock.slice(0, stock.length - n));
};

function deepFreeze<T>(v: T): T {
  if (typeof v === 'object' && v !== null && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const x of Object.values(v)) deepFreeze(x);
  }
  return v;
}

// ---------------------------------------------------------------- the deal as a phase

describe('dealing', () => {
  const fresh = deepFreeze(dealRound([0, 1, 2], seeded(21)));
  const everyIntent = (s: GameState, seat: number): Intent[] => {
    const p = s.players.find((q) => q.seat === seat)!;
    const tops = [p.nertz.at(-1)!, ...p.work.map((w) => w.cards.at(-1)!)];
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
    expect(fresh.status.at).toBe('dealing');
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
      expect(view.status.at).toBe('dealing');
      expect(allCards(view)).toHaveLength(3 * 52);
      expect(allCards(view).every(isHidden)).toBe(true);
      expect(JSON.stringify(view)).not.toMatch(/suit|rank/);
      expect(allCards(view).map((x) => [x.id, x.owner])).toEqual(allCards(fresh).map((x) => [x.id, x.owner]));
      expect(view.players.map((p) => [p.nertz.length, p.work.map((w) => w.cards.length), downs(p), p.stock.length])).toEqual(
        fresh.players.map((p) => [p.nertz.length, p.work.map((w) => w.cards.length), downs(p), p.stock.length]),
      );
      expect(checkInvariants(view)).toBeNull();
      // The reducer refuses on the view exactly as on the full state, so a client predicts nothing during the deal.
      for (const intent of everyIntent(view, 0)) rejected(applyIntent(view, 0, intent));
    }
  });

  const ready = deepFreeze(finishDeal(fresh));
  const counting = deepFreeze(startCountdown(ready));
  const open = deepFreeze(openPlay(counting));

  it('the opening is one state machine: dealing, ready, countdown, play; each step only from the stage before, never touching a card', () => {
    expect([fresh, ready, counting, open].map((s) => s.status.at)).toEqual(['dealing', 'ready', 'countdown', 'play']);
    for (const s of [ready, counting, open]) expect({ ...s, status: fresh.status }).toEqual(fresh);
    const steps = [finishDeal, startCountdown, openPlay];
    [fresh, ready, counting, open].forEach((s, at) => {
      steps.forEach((step, i) => {
        if (i !== at) expect(step(s)).toBe(s); // not its turn: the same object
      });
      expect(checkInvariants(s)).toBeNull();
    });
  });

  for (const [name, waiting, reason] of [['ready', ready, 'Waiting for the dealer to start'], ['countdown', counting, 'Wait for it']] as const) {
    it(`${name}: the work tops are face-up for everyone, every nertz top is still face-down, ids stable`, () => {
      for (const seat of [0, 1, 2, 7]) {
        const view = viewFor(waiting, seat);
        expect(view.status.at).toBe(name);
        expect(ids(allCards(view))).toEqual(ids(allCards(fresh)));
        view.players.forEach((p, i) => {
          expect(p.nertz.every(isHidden)).toBe(true); // nobody sees a nertz card, not even their own
          expect(p.stock.every(isHidden)).toBe(true);
          expect(p.work.map((w) => w.cards.at(-1))).toEqual(waiting.players[i]!.work.map((w) => w.cards.at(-1))); // the four tops, true faces
          expect(p.work.flatMap((w) => w.cards).filter((x) => !isHidden(x))).toHaveLength(4);
        });
        const nertzIds = waiting.players.flatMap((p) => p.nertz.map((x) => x.id));
        for (const id of nertzIds) expect(JSON.stringify(view)).not.toMatch(new RegExp(`"id":"${id}"[^}]*(suit|rank)`));
        expect(checkInvariants(view)).toBeNull();
        expect(viewFor(view, seat)).toEqual(view);
      }
    });

    it(`${name}: every intent from every seat is refused and changes nothing, on the state and on the view`, () => {
      for (const seat of [0, 1, 2]) {
        const view = viewFor(waiting, seat);
        for (const intent of everyIntent(waiting, seat)) {
          expect(applyIntent(waiting, seat, intent)).toEqual({ ok: false, reason });
          expect(applyIntent(view, seat, intent)).toEqual({ ok: false, reason }); // so a client predicts nothing
          expect(refused(waiting, seat, intent)).toBe(waiting);
          expect(canDrop(view, seat, intent.k === 'move' ? intent.cardId : 'x', work(0))).toBe(false);
        }
      }
      expect(resolveStuck(waiting, [0, 1, 2])).toBe(waiting);
      expect(isOver(waiting)).toBe(false);
    });
  }

  it('play: the nertz tops turn over, same ids, for every seat at once, and the table is open', () => {
    for (const seat of [0, 1, 2]) {
      // The same ids, now with the face-up cards showing: the nertz top and the four work tops of every player.
      const view = viewFor(open, seat);
      expect(ids(allCards(view))).toEqual(ids(allCards(viewFor(fresh, seat))));
      // (And for its own hand, the faces its next move could turn up: the card under the nertz top, three off the stock, a buried card per work pile that has one.)
      for (const p of view.players) expect([...p.nertz, ...p.work.flatMap((w) => w.cards), ...p.stock].filter((x) => !isHidden(x))).toHaveLength(p.seat === seat ? 5 + 1 + 3 + p.work.filter((w) => w.down > 0).length : 5);
      view.players.forEach((p, i) => expect(p.nertz.at(-1)).toEqual(open.players[i]!.nertz.at(-1)));
      ok(applyIntent(open, seat, { k: 'flip' }));
      ok(applyIntent(view, seat, hold(view.players.find((p) => p.seat === seat)!.nertz.at(-1)!.id)));
    }
  });

  it('checkInvariants rejects an opening during which something was played', () => {
    const played = ok(applyIntent(open, 0, { k: 'flip' }));
    for (const stage of ['dealing', 'ready', 'countdown'] as const) expect(checkInvariants({ ...played, status: { at: stage } })).toMatch(/before the round was open/);
  });
});

// ---------------------------------------------------------------- deal

describe('deal', () => {
  const state = inPlay([0, 1, 2], seeded(1));

  it('gives every seat 13 nertz, work piles (at three players) with 0, 0, 1 and 2 cards face-down under one face-up, 32 stock and an empty waste', () => {
    expect(state.players.map((p) => p.seat)).toEqual([0, 1, 2]);
    for (const p of state.players) {
      expect(p.nertz).toHaveLength(13);
      expect(p.work.map((w) => w.cards.length)).toEqual([1, 1, 2, 3]);
      expect(downs(p)).toEqual([0, 0, 1, 2]);
      expect(p.work.flatMap((w) => w.cards)).toHaveLength(7);
      expect(p.stock).toHaveLength(32);
      expect(p.waste).toHaveLength(0);
      expect(p.stuck).toBe(false);
      expect(p.holding).toBeNull();
      const faces = new Set([...p.nertz, ...p.stock, ...p.work.flatMap((w) => w.cards)].map((x) => (isHidden(x) ? '?' : `${x.suit}${x.rank}`)));
      expect(faces.size).toBe(52);
    }
    expect(state.slots).toEqual(Array.from({ length: 12 }, () => null)); // 4 slots per player
    expect(inPlay([4, 9], seeded(1)).slots).toHaveLength(8);
    expect(state.tray).toEqual([]);
    expect(calledBy(state)).toBeNull();
    expect(inGrace(state)).toEqual([]);
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
    expect(inPlay([0, 1], seeded(7))).toEqual(inPlay([0, 1], seeded(7)));
    expect(inPlay([0, 1], seeded(7))).not.toEqual(inPlay([0, 1], seeded(8)));
    const [a, b] = inPlay([0, 1], seeded(7)).players;
    expect(a!.nertz.map((x) => (x as Card).rank)).not.toEqual(b!.nertz.map((x) => (x as Card).rank));
  });

  it('survives a degenerate rng', () => {
    expect(checkInvariants(inPlay([0, 1], () => 0.999999999))).toBeNull();
    expect(checkInvariants(inPlay([3, 5], () => 1))).toBeNull();
  });
});

// ---------------------------------------------------------------- work pile moves

describe('work pile moves', () => {
  it('nertz top goes onto a work pile one rank up of the other colour and uncovers the next card', () => {
    const s = table([{ nertz: 'C9 H6', work: ['S7', 'D7', 'H7', []] }]);
    const next = ok(applyIntent(s, 0, move('0:H6', work(0))));
    expect(ids(next.players[0]!.nertz)).toEqual(['0:C9']);
    expect(ids(next.players[0]!.work[0]!.cards)).toEqual(['0:S7', '0:H6']);
    rejected(applyIntent(s, 0, move('0:H6', work(1)))); // same colour
    rejected(applyIntent(s, 0, move('0:H6', work(2)))); // same suit
    ok(applyIntent(s, 0, move('0:H6', work(3)))); // empty pile takes anything
  });

  it('rejects wrong ranks and buried nertz cards', () => {
    const s = table([{ nertz: 'C9 H6', work: ['S8', 'S6', 'S5', 'D10'] }]);
    for (const i of [0, 1, 2, 3]) rejected(applyIntent(s, 0, move('0:H6', work(i))));
    rejected(applyIntent(s, 0, move('0:C9', work(3)))); // legal fit, but not the top of the nertz pile
  });

  it('waste top can be played, buried waste and stock cards cannot', () => {
    const s = table([{ waste: 'H4 C3', stock: 'C2', work: ['D4', 'S5', 'D3', []] }]);
    const next = ok(applyIntent(s, 0, move('0:C3', work(0))));
    expect(ids(next.players[0]!.waste)).toEqual(['0:H4']);
    rejected(applyIntent(s, 0, move('0:H4', work(1))));
    rejected(applyIntent(s, 0, move('0:C2', work(2))));
  });

  it('moves a run (any suffix) between work piles, keeping its order', () => {
    const s = table([{ work: ['S9 H8 C7 D6', 'C9', 'H7', []] }]);
    const a = ok(applyIntent(s, 0, move('0:H8', work(1), 3)));
    expect(ids(a.players[0]!.work[0]!.cards)).toEqual(['0:S9']);
    expect(ids(a.players[0]!.work[1]!.cards)).toEqual(['0:C9', '0:H8', '0:C7', '0:D6']);
    const b = ok(applyIntent(s, 0, move('0:C7', work(3), 2)));
    expect(ids(b.players[0]!.work[0]!.cards)).toEqual(['0:S9', '0:H8']);
    expect(ids(b.players[0]!.work[3]!.cards)).toEqual(['0:C7', '0:D6']);
    rejected(applyIntent(s, 0, move('0:C7', work(1), 2))); // 7 on 9
    rejected(applyIntent(s, 0, move('0:D6', work(2)))); // red on red
    rejected(applyIntent(s, 0, move('0:H8', work(0), 3))); // onto itself
    expect(grab(s, 0, '0:C7')).toEqual({ from: { k: 'work', i: 0 }, cards: cs('C7 D6') });
  });

  it('refuses the pointless move of a whole pile onto an empty pile', () => {
    const s = table([{ work: ['S9 H8', [], 'H10', []] }]);
    rejected(applyIntent(s, 0, move('0:S9', work(1), 2)));
    expect(canDrop(s, 0, '0:S9', work(1))).toBe(false);
    ok(applyIntent(s, 0, move('0:H8', work(1))));
    ok(applyIntent(s, 0, move('0:S9', work(2), 2)));
  });

  it("never lets a seat move another seat's cards, or cards onto another seat's piles", () => {
    const s = table([{ work: ['S9', [], [], []] }, { nertz: 'H8', work: ['C9', [], [], []] }]);
    rejected(applyIntent(s, 0, move('1:H8', work(0))));
    expect(grab(s, 0, '1:H8')).toBeNull();
    // seat 1 playing to work(0) lands on seat 1's own pile, not seat 0's
    const next = ok(applyIntent(s, 1, move('1:H8', work(0))));
    expect(ids(next.players[1]!.work[0]!.cards)).toEqual(['1:C9', '1:H8']);
    expect(next.players[0]).toBe(s.players[0]);
    rejected(applyIntent(s, 7, move('1:H8', work(0)))); // seat not in the round
  });

  it('rejects unknown cards and out-of-range piles', () => {
    const s = table([{ nertz: 'H6' }]);
    rejected(applyIntent(s, 0, move('nope', work(0))));
    rejected(applyIntent(s, 0, move('0:H6', work(4))));
    rejected(applyIntent(s, 0, move('0:H6', work(-1))));
  });
});

// ---------------------------------------------------------------- face-down work cards

describe('face-down work cards', () => {
  // Pile 0: D4 and C9 face-down under a face-up H6. Pile 1: a face-up S7. Pile 2: K-Q face-up over one face-down card.
  const s = table([{ nertz: 'D8', work: [{ down: 'D4 C9', up: 'H6' }, 'S7', { down: 'C2', up: 'SK HQ' }, []] }]);

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
    expect(ids(a.players[0]!.work[0]!.cards)).toEqual(['0:D4', '0:C9']);
    expect(downs(a.players[0]!)).toEqual([1, 0, 1, 0]); // C9 is now the face-up top
    expect(grab(a, 0, '0:C9')).not.toBeNull();
    expect(grab(a, 0, '0:D4')).toBeNull();
    const b = ok(applyIntent(a, 0, move('0:D8', work(0)))); // and it can be built on
    expect(ids(b.players[0]!.work[0]!.cards)).toEqual(['0:D4', '0:C9', '0:D8']);
    expect(downs(b.players[0]!)).toEqual([1, 0, 1, 0]); // adding cards turns nothing over
    const d = run(b, [0, move('0:C9', work(3), 2)]);
    expect(ids(d.players[0]!.work[0]!.cards)).toEqual(['0:D4']);
    expect(downs(d.players[0]!)).toEqual([0, 0, 1, 0]);
    expect(viewFor(d, 0).players[0]!.work[0]!.cards).toEqual(cs('D4')); // face-up for everyone now
  });

  it('moving the whole face-up run to an empty pile is allowed when it uncovers a card, and works to the middle too', () => {
    const a = ok(applyIntent(s, 0, move('0:SK', work(3), 2)));
    expect(ids(a.players[0]!.work[2]!.cards)).toEqual(['0:C2']);
    expect(downs(a.players[0]!)).toEqual([2, 0, 0, 0]);
    const lone = table([{ work: [{ down: 'C9', up: 'HA' }, [], [], []] }]);
    const b = ok(applyIntent(lone, 0, move('0:HA', felt(0, 0))));
    expect(downs(b.players[0]!)).toEqual([0, 0, 0, 0]);
    expect(ids(b.players[0]!.work[0]!.cards)).toEqual(['0:C9']);
  });

  it('a pile with nothing left accepts any card or run', () => {
    // Pile 0 is emptied completely: its face-up H6 leaves, the C9 under it turns over and leaves too.
    const start = table([{ nertz: 'D8', work: [{ down: 'C9', up: 'H6' }, 'SK HQ CJ', 'S7', 'D10'] }]);
    const e = run(start, [0, move('0:H6', work(2))], [0, move('0:C9', work(3))]);
    expect(e.players[0]!.work[0]!.cards).toEqual([]);
    expect(downs(e.players[0]!)).toEqual([0, 0, 0, 0]);
    expect(ids(ok(applyIntent(e, 0, move('0:D8', work(0)))).players[0]!.work[0]!.cards)).toEqual(['0:D8']);
    expect(ids(ok(applyIntent(e, 0, move('0:HQ', work(0), 2))).players[0]!.work[0]!.cards)).toEqual(['0:HQ', '0:CJ']);
  });

  it('are redacted for everyone but their owner, who is shown only the one its next move off the pile turns up; ids are stable', () => {
    const theirs = viewFor(s, 1).players[0]!;
    expect(theirs.work[0]!.cards).toEqual([{ id: '0:D4', owner: 0, hidden: true }, { id: '0:C9', owner: 0, hidden: true }, c('H6')]);
    expect(theirs.work[2]!.cards).toEqual([{ id: '0:C2', owner: 0, hidden: true }, c('SK'), c('HQ')]);
    const mine = viewFor(s, 0).players[0]!;
    expect(mine.work[0]!.cards).toEqual([{ id: '0:D4', owner: 0, hidden: true }, c('C9'), c('H6')]);
    expect(mine.work[2]!.cards).toEqual([c('C2'), c('SK'), c('HQ')]);
    for (const v of [theirs, mine]) expect(downs(v)).toEqual(downs(s.players[0]!)); // still face-down, known or not
    for (const id of ['0:C9', '0:C2']) {
      expect(grab(viewFor(s, 0), 0, id)).toBeNull();
      rejected(applyIntent(viewFor(s, 0), 0, hold(id)));
    }
    // Prediction on the owner's view: the pile shrinks, `down` drops, and the card turned up has its face at once...
    const predicted = ok(applyIntent(viewFor(s, 0), 0, move('0:H6', work(1))));
    expect(downs(predicted.players[0]!)).toEqual([1, 0, 1, 0]);
    expect(predicted.players[0]!.work[0]!.cards).toEqual([{ id: '0:D4', owner: 0, hidden: true }, c('C9')]);
    // ...so it plays on at once, as the server will have it.
    ok(applyIntent(predicted, 0, hold('0:C9')));
    ok(applyIntent(predicted, 0, move('0:D8', work(0))));
    // The server's next snapshot agrees, and shows the owner the card now under it.
    const truth = viewFor(ok(applyIntent(s, 0, move('0:H6', work(1)))), 0);
    expect(truth.players[0]!.work[0]!.cards).toEqual([c('D4'), c('C9')]);
    expect(downs(truth.players[0]!)).toEqual(downs(predicted.players[0]!));
  });
});

// ---------------------------------------------------------------- centre slots

describe('centre slots', () => {
  it('an ace put down on the felt takes the first unused slot', () => {
    const s = table([{ nertz: 'S5 HA' }, {}]);
    expect(s.slots).toHaveLength(8);
    const next = ok(applyIntent(s, 0, move('0:HA', felt(0, 0))));
    expect(next.slots.map((p) => p && ids(p.cards))).toEqual([['0:HA'], null, null, null, null, null, null, null]);
    expect(ids(next.players[0]!.nertz)).toEqual(['0:S5']);
    rejected(applyIntent(s, 1, move('0:HA', felt(0, 0)))); // not seat 1's card
    rejected(applyIntent(s, 0, move('0:HA', slot(8)))); // 2 players: slots 0..7 only
    rejected(applyIntent(s, 0, move('0:HA', slot(23))));
    rejected(applyIntent(s, 0, move('0:S5', felt(0, 0)))); // buried
  });

  it('only an ace starts a pile, and an ace never goes on a pile', () => {
    const s = table([{ nertz: 'H2', waste: 'HA', work: ['SA', [], [], []] }, {}], { slots: [pile('HA', 1), pile('S3', 1)] });
    rejected(applyIntent(s, 0, move('0:H2', felt(-2, 0)))); // a 2 on bare felt
    rejected(applyIntent(s, 0, move('0:HA', slot(0)))); // an ace on an ace
    rejected(applyIntent(s, 0, move('0:SA', slot(1)))); // an ace on a pile of its suit
    ok(applyIntent(s, 0, move('0:HA', felt(-2, 0))));
    ok(applyIntent(s, 0, move('0:H2', slot(0))));
  });

  it('builds up by suit from nertz, waste and work tops, across owners, only on the exact pile', () => {
    const s = table([{ nertz: 'H2', waste: 'S9 H3', work: ['S5 H4', [], [], []] }, { nertz: 'H2' }], { slots: [pile('SA', 1), pile('HA', 1)] });
    let next = run(s, [0, move('0:H2', slot(1))], [0, move('0:H3', slot(1))], [0, move('0:H4', slot(1))]);
    expect(ids(next.slots[1]!.cards)).toEqual(['1:HA', '0:H2', '0:H3', '0:H4']);
    rejected(applyIntent(next, 1, move('1:H2', slot(1)))); // too late
    rejected(applyIntent(s, 0, move('0:H3', slot(1)))); // skips a rank
    rejected(applyIntent(s, 0, move('0:H2', slot(0)))); // wrong suit
    rejected(applyIntent(s, 0, move('0:S5', slot(0)))); // not the top of its work pile
    next = ok(applyIntent(s, 0, move('0:H2', slot(1))));
    expect(next.players[1]).toBe(s.players[1]);
  });

  it('only single cards go to the middle', () => {
    const s = table([{ work: ['H3 S2', [], [], []] }, {}], { slots: [pile('H2', 1), pile('SA', 1)] });
    rejected(applyIntent(s, 0, move('0:H3', slot(0))));
    expect(canDrop(s, 0, '0:H3', slot(0))).toBe(false);
    ok(applyIntent(s, 0, move('0:S2', slot(1))));
  });

  describe('no fallback: the loser of a race gets its card back', () => {
    it('to a pile: rejected and nothing moves, even though another pile would take the card', () => {
      const s = deepFreeze(
        table([{ nertz: 'H2' }, { nertz: 'S9 H2' }, { nertz: 'H2' }], { slots: [pile('HA', 0), pile('HA', 1)] }),
      );
      const afterFirst = ok(applyIntent(s, 0, move('0:H2', slot(0))));
      const lost = applyIntent(afterFirst, 1, move('1:H2', slot(0)));
      expect(lost).toEqual({ ok: false, reason: 'Does not fit there' });
      expect(canDrop(afterFirst, 1, '1:H2', slot(0))).toBe(false);
      expect(ids(afterFirst.players[1]!.nertz)).toEqual(['1:S9', '1:H2']); // still where it came from
      expect(afterFirst.slots.slice(0, 2).map((p) => ids(p!.cards))).toEqual([['0:HA', '0:H2'], ['1:HA']]); // the other ace was not touched
      // The same card is fine on the pile it actually fits, when aimed there.
      const inMiddle = (g: GameState, seat: number, id: string) => legalDrops(g, seat, id).filter((to) => to.k === 'slot');
      expect(inMiddle(afterFirst, 1, '1:H2')).toEqual([slot(1)]);
      const retry = ok(applyIntent(afterFirst, 1, move('1:H2', slot(1))));
      expect(ids(retry.slots[1]!.cards)).toEqual(['1:HA', '1:H2']);
      expect(inMiddle(retry, 2, '2:H2')).toEqual([]);
    });

    it('to bare felt: two aces race for one place, the first wins and the other returns', () => {
      const s = deepFreeze(table([{ nertz: 'HA' }, { nertz: 'S9 SA' }]));
      const afterFirst = ok(applyIntent(s, 0, move('0:HA', felt(0, 0))));
      rejected(applyIntent(afterFirst, 1, move('1:SA', felt(0, 0)))); // there is room elsewhere, but it was not aimed there
      expect(ids(afterFirst.players[1]!.nertz)).toEqual(['1:S9', '1:SA']);
      expect(afterFirst.slots.filter((p) => p !== null)).toHaveLength(1);
      const retry = ok(applyIntent(afterFirst, 1, move('1:SA', felt(1, 0))));
      expect(ids(retry.slots[1]!.cards)).toEqual(['1:SA']);
      // Same suit, different piles: two piles of one suit can coexist.
      const twin = table([{ nertz: 'HA' }, { nertz: 'HA' }]);
      expect(run(twin, [0, move('0:HA', felt(-1, 0))], [1, move('1:HA', felt(1, 0))]).slots.slice(0, 2).map((p) => ids(p!.cards))).toEqual([['0:HA'], ['1:HA']]);
    });
  });
});

// ---------------------------------------------------------------- completed piles and the tray

describe('completed piles', () => {
  const s = table([{ nertz: 'SK', waste: 'HA' }, { nertz: 'SK', waste: 'DA' }], { slots: [pile('SQ', 1)] });
  const done = ok(applyIntent(s, 0, move('0:SK', slot(0))));

  it('a king completes a pile, which stays in its slot and takes nothing more', () => {
    expect(isComplete(s.slots[0]!.cards)).toBe(false);
    expect(completedBy(s.slots[0]!)).toBeNull();
    expect(isComplete(done.slots[0]!.cards)).toBe(true);
    expect(done.slots[0]!.cards).toHaveLength(13);
    expect(completedBy(done.slots[0]!)).toBe(0); // the seat that placed the King
    rejected(applyIntent(done, 1, move('1:SK', slot(0))));
    rejected(applyIntent(done, 1, move('1:DA', felt(0, 0)))); // the felt is not free yet
    expect(legalDrops(done, 1, '1:SK').filter((to) => to.k === 'slot')).toEqual([]);
  });

  it("only the King's player can clear it to the tray; the slot and its felt are then free again", () => {
    rejected(applyIntent(done, 1, { k: 'clear', slot: 0 })); // most of the pile is seat 1's, but seat 0 placed the King
    rejected(applyIntent(done, 0, { k: 'clear', slot: 1 })); // empty slot
    rejected(applyIntent(done, 0, { k: 'clear', slot: 23 }));
    rejected(applyIntent(s, 1, { k: 'clear', slot: 0 })); // not complete
    rejected(applyIntent(s, 0, { k: 'clear', slot: 0 }));
    const cleared = ok(applyIntent(done, 0, { k: 'clear', slot: 0 }));
    expect(cleared.slots[0]).toBeNull();
    expect(cleared.slots).toHaveLength(8);
    expect(cleared.tray).toEqual([done.slots[0]!.cards]);
    expect(cleared.tray[0]!.at(-1)).toEqual(c('SK'));
    rejected(applyIntent(cleared, 0, { k: 'clear', slot: 0 })); // nothing there any more
    const reused = ok(applyIntent(cleared, 1, move('1:DA', felt(0, 0))));
    expect(ids(reused.slots[0]!.cards)).toEqual(['1:DA']);
    expect(reused.tray).toHaveLength(1);
  });

  it('clearing counts as doing something (clears the stuck flag) and tray piles keep scoring', () => {
    const flagged = { ...done, players: done.players.map((p) => ({ ...p, stuck: true })) };
    const stuck = ok(applyIntent(flagged, 0, { k: 'clear', slot: 0 }));
    expect(stuck.players.map((p) => p.stuck)).toEqual([false, true]);
    expect(scoreRound(done)).toEqual(scoreRound(stuck));
    expect(scoreRound(stuck)).toEqual([
      { seat: 0, played: 1, nertzLeft: 0, delta: 1 },
      { seat: 1, played: 12, nertzLeft: 1, delta: 10 },
    ]);
  });
});

describe('clear first: a finished pile must go to the tray before its player does anything else', () => {
  // Each seat can do a bit of everything: a nertz card and a waste card that fit a work pile, an ace for the middle, a stock to flip.
  const hand: Hand = { nertz: 'C9 SK', work: ['H5', 'C4', 'DA', []], stock: 'H2 H3 H4', waste: 'D3' };
  const s = table([hand, hand], { slots: [[], [], pile('SQ', 1)] });
  const done = ok(applyIntent(s, 0, move('0:SK', slot(2))));
  /** Everything but clearing a finished pile; `fine` marks what is accepted on an ordinary table. */
  const others = (seat: number): { intent: Intent; fine: boolean }[] => [
    { intent: { k: 'flip' }, fine: true },
    { intent: { k: 'stuck', on: true }, fine: true },
    { intent: { k: 'stuck', on: false }, fine: true },
    { intent: NERTZ, fine: false },
    { intent: RELEASE, fine: false },
    { intent: hold(`${seat}:C4`), fine: true },
    { intent: hold(`${seat}:D3`), fine: true },
    { intent: move(`${seat}:C4`, work(0)), fine: true },
    { intent: move(`${seat}:D3`, work(1)), fine: true },
    { intent: move(`${seat}:DA`, felt(-1.5, 0)), fine: true },
    { intent: { k: 'clear', slot: 0 }, fine: false }, // not a finished pile
  ];
  const emptyNertz = (g: GameState, seat: number): GameState => ({ ...g, players: g.players.map((p) => (p.seat === seat ? { ...p, stock: [...p.stock, ...p.nertz], nertz: [] } : p)) });

  it('mustClear is true for exactly the seat that placed the King, from the King until the pile is in the tray', () => {
    expect([mustClear(s, 0), mustClear(s, 1)]).toEqual([false, false]);
    expect([mustClear(done, 0), mustClear(done, 1)]).toEqual([true, false]);
    expect(done.players[0]!.holding).toBeNull();
    const cleared = ok(applyIntent(done, 0, { k: 'clear', slot: 2 }));
    expect([mustClear(cleared, 0), mustClear(cleared, 1)]).toEqual([false, false]);
  });

  it('refuses every other kind of intent from that seat, with the reason, changing nothing; on the view too', () => {
    const view = viewFor(done, 0);
    for (const { intent, fine } of others(0)) {
      const r = applyIntent(done, 0, intent);
      expect(r.ok, JSON.stringify(intent)).toBe(false);
      if (intent.k !== 'clear') expect(r).toEqual({ ok: false, reason: CLEAR_FIRST });
      expect(applyIntent(view, 0, intent).ok).toBe(false);
      expect(refused(done, 0, intent)).toBe(done);
      // ...and all of it is fine again once the pile is in the tray.
      if (fine) ok(applyIntent(run(done, [0, { k: 'clear', slot: 2 }]), 0, intent));
    }
    expect(canDrop(done, 0, '0:C4', work(0))).toBe(false);
    expect(legalDrops(done, 0, '0:C4')).toEqual([work(0)]); // the cards have not changed, only what the seat may do
    // Calling Nertz too: with an empty nertz pile the pile still comes first.
    const out = emptyNertz(done, 0);
    expect(applyIntent(out, 0, NERTZ)).toEqual({ ok: false, reason: CLEAR_FIRST });
    ok(applyIntent(run(out, [0, { k: 'clear', slot: 2 }]), 0, NERTZ));
  });

  it('nobody else is held up, and the slot stays taken until the pile is cleared', () => {
    for (const { intent, fine } of others(1)) if (fine) ok(applyIntent(done, 1, intent));
    rejected(applyIntent(done, 1, move('1:DA', slot(2))));
    rejected(applyIntent(done, 1, { k: 'clear', slot: 2 }));
    const later = run(done, [1, { k: 'flip' }], [1, move('1:DA', felt(-1.5, 0))], [0, { k: 'clear', slot: 2 }]);
    expect(mustClear(later, 0)).toBe(false);
    for (const intent of [{ k: 'flip' }, hold('0:C4'), move('0:D3', work(1)), move('0:DA', felt(1.5, 0))] as Intent[]) ok(applyIntent(later, 0, intent));
  });

  it('two finished piles: both must go, in either order', () => {
    const two = table([{ nertz: 'C9' }, { nertz: 'C9' }], { slots: [pile('HK'), [], pile('DK')] });
    const one = ok(applyIntent(two, 0, { k: 'clear', slot: 2 }));
    expect(applyIntent(one, 0, { k: 'flip' })).toEqual({ ok: false, reason: CLEAR_FIRST });
    ok(applyIntent(run(one, [0, { k: 'clear', slot: 0 }]), 0, { k: 'flip' }));
  });

  it('if somebody else calls Nertz first the round ends as usual and the uncleared pile scores where it lies', () => {
    const out = emptyNertz(done, 1);
    const called = ok(applyIntent(out, 1, NERTZ));
    expect(isOver(called)).toBe(true);
    expect(mustClear(called, 0)).toBe(false); // nothing is asked of anyone any more
    expect(applyIntent(called, 0, { k: 'clear', slot: 2 })).toEqual({ ok: false, reason: 'The round is over' });
    expect(called.slots[2]!.cards).toHaveLength(13);
    const cleared = run(out, [0, { k: 'clear', slot: 2 }], [1, NERTZ]);
    expect(scoreRound(called)).toEqual(scoreRound(cleared));
    expect(scoreRound(called)).toEqual([
      { seat: 0, played: 1, nertzLeft: 1, delta: -1 },
      { seat: 1, played: 12, nertzLeft: 0, delta: 12 },
    ]);
  });

  it('never meets the grace window: the King empties the hand and nothing can be picked up until the pile is gone', () => {
    const holding = run(s, [0, hold('0:C4')], [0, move('0:SK', slot(2))]);
    expect(holding.players[0]!.holding).toBeNull();
    rejected(applyIntent(holding, 0, hold('0:C4')));
    // A King played as the one grace move ends that seat's round like any other grace move.
    const grace = run(emptyNertz(s, 1), [0, hold('0:SK')], [1, NERTZ]);
    expect(inGrace(grace)).toEqual([0]);
    expect(isOver(ok(applyIntent(grace, 0, move('0:SK', slot(2)))))).toBe(true);
    // Nor before a call has reached its window: what it could not pick up a moment ago, it cannot now.
    const unheard = ok(applyIntent(emptyNertz(done, 1), 1, { k: 'nertz', unheard: [0] }));
    expect(applyIntent(unheard, 0, hold('0:C4'))).toEqual({ ok: false, reason: CLEAR_FIRST });
    // checkInvariants knows it too: seat 0's spades are a finished pile, and the waste card it would hold is not to be held.
    const waiting = table([{ waste: 'HA' }, {}], { slots: [pile('SK')] });
    expect(checkInvariants(waiting)).toBeNull();
    expect(checkInvariants({ ...waiting, players: waiting.players.map((p) => (p.seat === 0 ? { ...p, holding: '0:HA' } : p)) })).toMatch(/finished pile still to clear/);
  });
});

// ---------------------------------------------------------------- stock

describe('dealing off the stock and recycling', () => {
  const s = table([{ stock: 'S7 S6 S5 S4 S3 S2 SA' }, {}]); // SA is the top
  const me = (g: GameState) => g.players[0]!;

  it('takes one card per action, face-down onto the waste; the third turns the group up, its last card on top', () => {
    const a = flips(s, 0, 1);
    expect([ids(me(a).waste), me(a).dealt, me(a).stock.length]).toEqual([['0:SA'], 1, 51]);
    const b = flips(a, 0, 1);
    expect([ids(me(b).waste), me(b).dealt, me(b).stock.length]).toEqual([['0:SA', '0:S2'], 2, 50]);
    const d = flips(b, 0, 1);
    expect([ids(me(d).waste), me(d).dealt, me(d).stock.length]).toEqual([['0:SA', '0:S2', '0:S3'], 0, 49]);
    expect(grab(d, 0, '0:S3')).toEqual({ from: { k: 'waste' }, cards: [c('S3')] });
    // The next group lands on the first: the cards beneath stay face-up, but only a face-up top is in play.
    const e = flips(d, 0, 2);
    expect([ids(me(e).waste), me(e).dealt]).toEqual([['0:SA', '0:S2', '0:S3', '0:S4', '0:S5'], 2]);
    expect(ids(me(flips(e, 0, 1)).waste).at(-1)).toBe('0:S6');
    for (const g of [a, b, d, e]) expect(checkInvariants(g)).toBeNull();
  });

  it('turns a short group up as soon as the stock runs out', () => {
    const bottom = me(s).stock[0]!.id;
    const oneLeft = flips(s, 0, 51);
    expect([me(oneLeft).dealt, me(oneLeft).stock.length]).toEqual([0, 1]);
    const last = flips(oneLeft, 0, 1); // a group of one
    expect([me(last).dealt, me(last).stock.length, ids(me(last).waste).at(-1)]).toEqual([0, 0, bottom]);
    expect(viewFor(last, 1).players[0]!.waste.some(isHidden)).toBe(false);
    expect(grab(last, 0, bottom)).not.toBeNull();
    const fifty = table([{ nertz: 'SA S2' }]);
    expect(me(flips(fifty, 0, 49)).dealt).toBe(1);
    const two = flips(fifty, 0, 50); // a group of two
    expect([me(two).dealt, me(two).stock.length]).toEqual([0, 0]);
    expect(checkInvariants(two)).toBeNull();
  });

  it('shows nobody but its owner a card of a half-dealt group; ids are stable and the faces come when it turns up', () => {
    const under = flips(s, 0, 3);
    for (const n of [1, 2]) {
      const mid = flips(under, 0, n);
      for (const seat of [0, 1]) {
        const waste = viewFor(mid, seat).players[0]!.waste;
        expect(ids(waste)).toEqual(ids(me(mid).waste));
        expect(waste.slice(0, 3)).toEqual(me(under).waste); // the group beneath stays as it was
        // (Its owner was sent them to turn the group up the moment it is whole: still out of play, see below.)
        expect(waste.slice(3)).toEqual(seat === 0 ? me(mid).waste.slice(3) : me(mid).waste.slice(3).map((x) => ({ id: x.id, owner: 0, hidden: true })));
        expect(checkInvariants(viewFor(mid, seat))).toBeNull();
      }
      expect(JSON.stringify(viewFor(mid, 1))).not.toContain(`"rank":${3 + n}`);
    }
    const up = flips(under, 0, 3);
    expect(viewFor(up, 1).players[0]!.waste).toEqual(me(up).waste);
  });

  it('keeps the waste out of play while a group is half-dealt; the other piles play on and the deal resumes', () => {
    const g = table([{ stock: 'S4 S3 S2 SA', waste: 'D2 H4', nertz: 'C9 H6', work: ['S7', 'C7', 'D8', []] }]);
    expect(legalDrops(g, 0, '0:H4')).toEqual([work(3)]);
    for (const n of [1, 2]) {
      const mid = flips(g, 0, n);
      const top = me(mid).waste.at(-1)!.id;
      for (const id of [top, '0:H4', '0:D2']) {
        expect(grab(mid, 0, id)).toBeNull();
        expect(legalDrops(mid, 0, id)).toEqual([]);
        rejected(applyIntent(mid, 0, hold(id)));
        for (const to of [work(1), work(3), slot(0)]) rejected(applyIntent(mid, 0, move(id, to)));
      }
      // Nertz and work piles are as playable as ever, drags included, and none of it disturbs the group.
      const played = run(mid, [0, hold('0:H6')], [0, move('0:H6', work(0))], [0, move('0:C7', work(2))], [0, { k: 'stuck', on: true }]);
      expect([me(played).dealt, ids(me(played).waste)]).toEqual([n, ids(me(mid).waste)]);
      expect(checkInvariants(played)).toBeNull();
      // ...and the deal is taken up where it was left.
      const done = flips(played, 0, 3 - n);
      expect([me(done).dealt, ids(me(done).waste)]).toEqual([0, ['0:D2', '0:H4', '0:SA', '0:S2', '0:S3']]);
      expect(ok(applyIntent(done, 0, move('0:S3', work(3)))).players[0]!.waste).toHaveLength(4);
    }
  });

  it('recycles the waste into the stock in the original order: one action, on an empty stock only', () => {
    const out = flips(s, 0, 52);
    expect(me(out).stock).toEqual([]);
    const back = flips(out, 0, 1);
    expect([me(back).waste, me(back).dealt]).toEqual([[], 0]);
    expect(me(back).stock).toEqual(me(s).stock);
    // While any card is left in the stock a flip deals; it never turns the waste over, half-dealt group or not.
    for (let n = 1; n < 7; n++) expect(me(flips(s, 0, n)).waste).toHaveLength(n);
  });

  it('rejects a flip with nothing to flip, and does not clear the stuck flag', () => {
    const allInTray = table([{}], { tray: [pile('SK'), pile('HK'), pile('DK'), pile('CK')] });
    rejected(applyIntent(allInTray, 0, FLIP));
    const stuck = table([{ stock: 'S7', stuck: true }]);
    expect(ok(applyIntent(stuck, 0, FLIP)).players[0]!.stuck).toBe(true);
  });

  it('the invariant check knows a half-dealt group: 0 to 2 cards, on the waste, never on an empty stock, never before play opens', () => {
    const mid = flips(s, 0, 2);
    const withDealt = (g: GameState, dealt: number): GameState => ({ ...g, players: g.players.map((p, i) => (i === 0 ? { ...p, dealt } : p)) });
    expect(checkInvariants(mid)).toBeNull();
    for (const bad of [3, -1, 1.5, NaN]) expect(checkInvariants(withDealt(mid, bad))).toMatch(/half-dealt/);
    expect(checkInvariants(withDealt(flips(s, 0, 1), 2))).toMatch(/half-dealt/); // more than lie on the waste
    expect(checkInvariants(withDealt(flips(s, 0, 52), 1))).toMatch(/empty stock/);
    const fresh = dealRound([0, 1], seeded(5));
    expect(checkInvariants(fresh)).toBeNull();
    const early = { ...fresh, players: fresh.players.map((p, i) => (i === 0 ? { ...p, waste: p.stock.slice(-1), stock: p.stock.slice(0, -1), dealt: 1 } : p)) };
    expect(checkInvariants(early)).toMatch(/before the round was open/);
  });
});

describe('everyone stuck: a table where nothing can move ends the round', () => {
  // Every work pile taken by a black card, so nothing black lands on one; no Ace anywhere, so nothing goes to the middle
  // except onto the hearts pile (A to 4) when there is one. The rest of each deck lies face-down under the first work pile.
  const blocked = ['C9', 'C7', 'S5', 'S3'];
  const both = (s: GameState) => run(s, [0, { k: 'stuck', on: true }], [1, { k: 'stuck', on: true }]);

  it('ends the round when nobody can move anything, at any shift of any stock', () => {
    const s = table([
      { work: blocked, stock: 'SJ S9 S7 C5 CJ CQ', nertz: 'C2', rest: 0 },
      { work: blocked, stock: 'SQ SK', nertz: 'S2', rest: 0 },
    ]);
    expect([0, 1].map((seat) => canProgress(s, seat))).toEqual([false, false]);
    const r = resolveStuck(both(s), [0, 1]);
    expect(r.status).toEqual({ at: 'over', end: { by: 'jam' } });
    expect(r.players.every((p) => !p.stuck)).toBe(true);
    expect(ids(r.players[0]!.stock)).toEqual(ids(s.players[0]!.stock)); // nothing is moved: it is scored as it lies
    expect(resolveStuck(r, [0, 1])).toBe(r);
  });

  it('a hand nobody plays any more (its player is up from it) does not keep the table from jamming', () => {
    const s = table([
      { work: blocked, stock: 'SJ S9 S7 C5 CJ CQ', nertz: 'C2', rest: 0 },
      { work: blocked, stock: 'SQ SK', nertz: 'S2', rest: 0 },
      { work: blocked, stock: 'SQ SK', nertz: 'H1', rest: 0 }, // an Ace on top: a move, for whoever played it
    ]);
    expect([0, 1, 2].map((seat) => canProgress(s, seat))).toEqual([false, false, true]);
    expect(resolveStuck(both(s), [0, 1]).status.at).toBe('play'); // played, if away: the stocks are turned over
    expect(resolveStuck(both(s), [0, 1], [0, 1]).status).toEqual({ at: 'over', end: { by: 'jam' } });
  });

  it('a jammed round is over like any other: a card in hand goes back, and nobody is held to clearing a pile', () => {
    // Seat 1 finished the diamonds, and went away before carrying them to the tray; seat 0 has a card in hand.
    const s = table(
      [
        { work: blocked, stock: 'SJ S9 S7 C5 CJ CQ', nertz: 'C2', rest: 0 },
        { work: blocked, stock: 'SQ SK', nertz: 'S2', rest: 0 },
      ],
      { slots: [[...pile('DQ', 0), c('DK', 1)]] },
    );
    const stuck = run(s, [0, hold('0:C2')], [0, { k: 'stuck', on: true }]);
    expect([stuck.players.map((p) => p.holding), mustClear(stuck, 1)]).toEqual([['0:C2', null], true]);
    const r = resolveStuck(stuck, [0]);
    expect(r.status).toEqual({ at: 'over', end: { by: 'jam' } });
    expect([r.players.map((p) => p.holding), mustClear(r, 1)]).toEqual([[null, null], false]);
    expect(checkInvariants(r)).toBeNull();
    rejected(applyIntent(r, 1, { k: 'clear', slot: 0 }));
  });

  it('counts a card from a work pile to the middle, and a run moved off a card that then goes there', () => {
    const toMiddle = table([{ work: ['H5', 'C9', 'S5', 'S3'], rest: 0 }], { slots: [pile('H4')] });
    expect(canProgress(toMiddle, 0)).toBe(true);
    // A run that could only move from one pile onto another, turning nothing up and emptying nothing, does not count.
    const pointless = table([{ work: ['C9 H8', 'S9', 'S5', 'S3'], rest: 0 }]);
    expect(canProgress(pointless, 0)).toBe(false);
    // ...but one that uncovers a card for the middle does: S4 off H5 onto D5, and H5 goes on the hearts.
    const freeing = table([{ work: ['H5 S4', 'D5', 'S5', 'S3'], rest: 0 }], { slots: [pile('H4')] });
    expect(canProgress(freeing, 0)).toBe(true);
  });

  // What counts is where a move leads: to a card in the middle or one off the nertz pile, however many moves on.
  // (In these hands the cards not named, the Aces among them, lie face-down under the first work pile.)
  const hearts = { slots: [pile('H4')] };
  const sayStuck = (s: GameState) => run(s, ...s.players.map((p): [number, Intent] => [p.seat, { k: 'stuck', on: true }]));
  const everyone = (s: GameState) => s.players.map((p) => p.seat);

  it('a card turned up counts for what it is: one that leads nowhere does not keep the round going', () => {
    // H8 goes on C9 and turns up the card under it. The 9 of spades has nowhere to go...
    expect(canProgress(table([{ work: [{ down: 'S9', up: 'H8' }, 'C9', 'S5', 'S3'], rest: 0 }]), 0)).toBe(false);
    // ...the 5 of hearts goes to the middle, and the Ace of clubs anywhere.
    expect(canProgress(table([{ work: [{ down: 'H5', up: 'H8' }, 'C9', 'S5', 'S3'], rest: 0 }], hearts), 0)).toBe(true);
    expect(canProgress(table([{ work: [{ down: 'CA', up: 'H8' }, 'C9', 'S5', 'S3'], rest: 0 }]), 0)).toBe(true);
    // Two down: S9 turned up goes on D10, and the Ace under it is turned up. Without the red 10 it is not.
    expect(canProgress(table([{ work: [{ down: 'CA S9', up: 'H8' }, 'C9', 'D10', 'S3'], rest: 0 }]), 0)).toBe(true);
    expect(canProgress(table([{ work: [{ down: 'CA S9', up: 'H8' }, 'C9', 'C10', 'S3'], rest: 0 }]), 0)).toBe(false);
  });

  it('a stock card that fits a work pile counts only if that leads somewhere', () => {
    const hand = (more: Partial<Hand>): Hand => ({ work: ['D10', 'C6', 'S5', 'S3'], stock: 'C9', rest: 0, ...more });
    // C9 goes on D10, and that is all: every card stays where it is ever after.
    const nowhere = table([hand({ nertz: 'C2' })]);
    expect(legalMoves(flips(nowhere, 0, 1), 0)).toEqual([move('0:C9', work(0))]);
    expect(canProgress(nowhere, 0)).toBe(false);
    // With a red 8 on the nertz pile it is the way out: C9 on D10, then H8 on C9.
    expect(canProgress(table([hand({ nertz: 'H8' })]), 0)).toBe(true);
    // Or the way to a card for the middle, H5 under S4: D5 from the stock on S6, S4 on D5, H5 to the hearts.
    expect(canProgress(table([hand({ work: ['D10', 'S6', 'H5 S4', 'S3'], stock: 'D5' })], hearts), 0)).toBe(true);
    expect(canProgress(table([hand({ work: ['D10', 'S8', 'H5 S4', 'S3'], stock: 'D5' })], hearts), 0)).toBe(false); // (no black 6 for D5 to go on)
  });

  it('an empty pile to be had is somewhere for the nertz top to go', () => {
    // H8 goes on C9, whole: its pile is empty, and the nertz top goes there. (The cards not named lie under the last pile.)
    expect(canProgress(table([{ work: ['H8', 'C9', 'S5', 'S3'], nertz: 'C2', rest: 3 }]), 0)).toBe(true);
    expect(canProgress(table([{ work: ['H8', 'S10', 'S5', 'S3'], nertz: 'C2', rest: 3 }]), 0)).toBe(false);
  });

  it('three at a table, each with a card to move that leads nowhere: it used to be reshuffled for ever, and is a jam', () => {
    // Everyone has a stock card that fits a work pile (C9 on D10, D8 on C9 after it), and nothing else, ever. Such a
    // move was once enough to call the table alive, so pressing stuck only turned the stocks over, time after time.
    const dead: Hand = { work: ['D10', 'C6', 'S5', 'S3'], stock: 'C9 D8', nertz: 'C2', rest: 0 };
    const s = table([dead, dead, dead]);
    for (const seat of [0, 1, 2]) {
      expect(legalMoves(run(s, [seat, FLIP], [seat, FLIP]), seat)).toEqual([move(`${seat}:C9`, work(0))]);
      expect(canProgress(s, seat)).toBe(false);
    }
    const r = resolveStuck(sayStuck(s), everyone(s));
    expect(r.status).toEqual({ at: 'over', end: { by: 'jam' } });
    expect(r.reshuffles).toBe(0);
    // Played out as far as it goes, it is the same dead table.
    const played = run(s, [0, FLIP], [0, FLIP], [0, move('0:C9', work(0))], [0, move('0:D8', work(0))]);
    expect(legalMoves(played, 0)).toEqual([]);
    expect(resolveStuck(sayStuck(played), everyone(s)).status).toEqual({ at: 'over', end: { by: 'jam' } });
  });

  it('three at a table, one of them with a way on (three moves off): no jam, the stocks are turned over', () => {
    const dead: Hand = { work: ['D10', 'C6', 'S5', 'S3'], stock: 'C9 D8', nertz: 'C2', rest: 0 };
    const s = table([dead, dead, { ...dead, nertz: 'S7' }]); // C9 on D10, D8 on C9, and the 7 of spades comes off the nertz pile
    expect([0, 1, 2].map((seat) => canProgress(s, seat))).toEqual([false, false, true]);
    const r = resolveStuck(sayStuck(s), everyone(s));
    expect(r.status).toEqual({ at: 'play' });
    expect(r.reshuffles).toBe(1);
    const on = run(s, [2, FLIP], [2, FLIP], [2, move('2:C9', work(0))], [2, move('2:D8', work(0))], [2, move('2:S7', work(0))]);
    expect(on.players[2]!.nertz).toHaveLength(0);
  });

  it('never calls a hand dead that can get somewhere: checked against every line of play, on random hands', () => {
    // Every line of play of a hand on its own (stock cards onto work piles, runs between them, any stock card to hand),
    // until a card can go to the middle or off the nertz pile. Null: too many to try.
    const getsSomewhere = (start: GameState): boolean | null => {
      const key = (g: GameState) => JSON.stringify([g.players[0]!.work.map((w) => [w.down, ids(w.cards)]), ids([...g.players[0]!.stock, ...g.players[0]!.waste]).sort()]);
      const seen = new Set([key(start)]);
      const todo = [start];
      for (let g = todo.pop(); g; g = todo.pop()) {
        const p = g.players[0]!;
        const nertzTop = p.nertz.at(-1);
        if (nertzTop && legalDrops(g, 0, nertzTop.id).length > 0) return true;
        const loose = [...p.stock, ...p.waste];
        const lifts: [GameState, AnyCard][] = [
          ...loose.map((card): [GameState, AnyCard] => [{ ...g, players: [{ ...p, stock: loose.filter((x) => x !== card), waste: [card] }] }, card]),
          ...p.work.flatMap((w) => w.cards.slice(w.down).map((card): [GameState, AnyCard] => [g, card])),
        ];
        for (const [from, card] of lifts) {
          for (const to of legalDrops(from, 0, card.id)) {
            if (to.k !== 'work') return true;
            const next = ok(applyIntent(from, 0, move(card.id, to, grab(from, 0, card.id)!.cards.length)));
            if (seen.has(key(next))) continue;
            if (seen.size >= 3000) return null;
            seen.add(key(next));
            todo.push(next);
          }
        }
      }
      return false;
    };
    // A hand late in a round: each suit in the middle up to somewhere, what is left of the deck in a few short runs
    // (some on face-down cards), a short nertz pile and the stock. The next card of each suit, which the middle would
    // take, is mostly buried: face-down under a work pile, or in the nertz pile.
    const hand = (rng: Rng): GameState => {
      const pick = (n: number) => Math.floor(rng() * n);
      const upTo = (['S', 'H', 'D', 'C'] as const).map((suit) => `${suit}${3 + pick(9)}`);
      const left = upTo.flatMap((top) => pile(`${top[0]}13`).slice(c(top).rank));
      const take = (fits: (x: Card) => boolean = () => true): Card[] => {
        const fitting = left.filter(fits);
        return fitting.length ? left.splice(left.indexOf(fitting[pick(fitting.length)]!), 1) : [];
      };
      const some = (n: number) => Array.from({ length: n }, () => take()).flat();
      const red = (x: Card) => x.suit === 'H' || x.suit === 'D';
      const face = (x: Card) => `${x.suit}${x.rank}`;
      const wanted = upTo.map((top) => ({ card: take((x) => x.suit === top[0] && x.rank === c(top).rank + 1), at: pick(6) }));
      const buried = (at: number) => wanted.flatMap((w) => (w.at === at ? w.card : []));
      left.push(...buried(5)); // (not buried)
      const workPile = (_: unknown, i: number) => {
        if (rng() < 0.12 && !buried(i).length) return [];
        const down = [...buried(i), ...some(pick(2))];
        const up = take();
        for (let onto = up.at(-1); onto && rng() < 0.5; onto = up.at(-1)) {
          const next = take((x) => x.rank === onto.rank - 1 && red(x) !== red(onto));
          if (!next.length) break;
          up.push(...next);
        }
        return up.length ? { down: down.map(face), up: up.map(face) } : down.slice(0, 1).map(face);
      };
      const work = [0, 1, 2, 3].map(workPile);
      const nertz = [...buried(4), ...some(pick(3))].map(face);
      const waste = some(pick(4)).map(face);
      return table([{ work, nertz, waste }], { slots: upTo.map((top) => pile(top)) });
    };
    const rng = seeded(69);
    const seen = { alive: 0, dead: 0, spared: 0, untried: 0 };
    for (let i = 0; i < 1000; i++) {
      const s = hand(rng);
      const really = getsSomewhere(s);
      const said = canProgress(s, 0);
      if (really === null) seen.untried++;
      else if (really) {
        seen.alive++;
        expect(said, JSON.stringify(s.players[0])).toBe(true); // never a jam with a way on
      } else if (said) seen.spared++; // a dead hand taken for a live one: the round only goes on
      else seen.dead++;
    }
    // (Of every twenty dead hands, about one is spared.)
    expect(seen.alive).toBeGreaterThan(500);
    expect(seen.dead).toBeGreaterThan(50);
    expect(seen.spared).toBeLessThan(seen.dead / 4);
  }, FUZZ_MS);
});

describe('the reshuffles of a round are counted', () => {
  const s = table([{ stock: 'S9 S8 SA' }, { stock: 'S9 S8' }, { stock: 'S9 S8' }]);
  const allStuck = (g: GameState) => resolveStuck(run(g, [0, { k: 'stuck', on: true }], [1, { k: 'stuck', on: true }], [2, { k: 'stuck', on: true }]), [0, 1, 2]);

  it('none in a fresh deal; one more each time the whole table is stuck; and everyone sees how many', () => {
    expect(dealRound([0, 1, 2], seeded(3)).reshuffles).toBe(0);
    expect(s.reshuffles).toBe(0);
    const once = allStuck(s);
    expect([once.reshuffles, allStuck(once).reshuffles]).toEqual([1, 2]);
    expect(viewFor(allStuck(once), 1).reshuffles).toBe(2);
    expect(checkInvariants({ ...s, reshuffles: -1 })).toMatch(/reshuffles/);
    // Someone stuck alone turns nothing over.
    expect(run(once, [0, { k: 'stuck', on: true }]).reshuffles).toBe(1);
  });

  it('after three the round drags on: while it is live', () => {
    const after = (n: number) => Array.from({ length: n }).reduce<GameState>((g) => allStuck(g), s);
    expect([0, 1, 2, 3, 4].map((n) => dragsOn(after(n)))).toEqual([false, false, false, true, true]);
    expect(RESHUFFLES_BEFORE_VOTE).toBe(3);
    expect(dragsOn(resolveEndVote(run(after(3), [0, { k: 'end', on: true }]), [0]))).toBe(false); // over
  });
});

describe('voting to end the round', () => {
  const s = table([{ stock: 'S9 S8' }, { stock: 'S9 S8' }, { stock: 'S9 S8' }]);

  it('ends it once every person voting has voted (a bot does not count), and a vote can be taken back', () => {
    const one = run(s, [0, { k: 'end', on: true }]);
    expect(one.players[0]!.ending).toBe(true);
    expect(resolveEndVote(one, [0, 1])).toBe(one); // seat 1 has not voted
    const back = run(one, [0, { k: 'end', on: false }]);
    expect(back.players[0]!.ending).toBeUndefined();
    const both = run(one, [1, { k: 'end', on: true }]);
    expect(resolveEndVote(both, [0, 1]).status).toEqual({ at: 'over', end: { by: 'vote' } }); // seat 2 (a bot, say) is not asked
    expect(resolveEndVote(both, [])).toBe(both);
    const called: GameState = { ...both, status: { at: 'over', end: { by: 'nertz', seat: 0, out: [0] } } };
    expect(resolveEndVote(called, [0, 1])).toBe(called);
  });

  it('has a say only for those dealt in: someone back after the deal is not counted, by the slip or by the resolver', () => {
    const two = table([{ stock: 'S9 S8' }, { stock: 'S9 S8' }]);
    const view = roomOf(two, 0);
    const back = { ...view, players: [...view.players, { ...view.players[1]!, id: 2, seat: 2, name: 'p2' }] }; // seat 2, here again, no cards
    expect(seatedPeople(back.players)).toEqual([0, 1, 2]);
    expect(endVote(two, seatedPeople(back.players))).toEqual({ voters: 2, voted: 0 });
    const both = run(two, [0, { k: 'end', on: true }], [1, { k: 'end', on: true }]);
    expect(endVote(both, seatedPeople(back.players))).toEqual({ voters: 2, voted: 2 });
    expect(resolveEndVote(both, seatedPeople(back.players)).status).toEqual({ at: 'over', end: { by: 'vote' } });
  });

  it('a round ended by vote is over like any other: a card in hand goes back, nobody is held to clearing a pile, and nothing more is taken', () => {
    // Seat 1 finished the spades and has not carried them to the tray: it may still vote. Seat 0 votes with a card in hand.
    const t = table([{ work: ['H6'] }, { stock: 'D9' }], { slots: [[...pile('SQ', 0), c('SK', 1)]] });
    const voted = run(t, [0, hold('0:H6')], [0, { k: 'end', on: true }], [1, { k: 'end', on: true }]);
    expect([voted.players.map((p) => p.holding), mustClear(voted, 1)]).toEqual([['0:H6', null], true]);
    const over = resolveEndVote(voted, [0, 1]);
    expect([isOver(over), isLive(over), calledBy(over), inGrace(over)]).toEqual([true, false, null, []]);
    expect([over.players.map((p) => p.holding), mustClear(over, 1)]).toEqual([[null, null], false]);
    expect(checkInvariants(over)).toBeNull();
    for (const intent of [RELEASE, move('0:H6', work(1)), { k: 'flip' }, { k: 'end', on: false }, { k: 'clear', slot: 0 }] as Intent[]) {
      for (const seat of [0, 1]) expect(applyIntent(over, seat, intent)).toEqual({ ok: false, reason: 'The round is over' });
    }
    expect(resolveEndVote(over, [0, 1])).toBe(over);
  });

  it('the slip says the round is over exactly when the resolver ends it, at any table', () => {
    const lineup: (Partial<PlayerView> | null)[][] = [
      [{}, {}, {}],
      [{}, { connected: false }, {}],
      [{}, { bot: 'fast' }, { bot: 'slow' }],
      [{ bot: 'fast' }, { bot: 'slow' }, { bot: 'fast' }],
      [{}, { seat: null }, { connected: false }], // seat 1 has stood up: watching
      [{}, {}, {}, {}], // seat 3 is here and seated but was not dealt in
      [{}, { connected: false }, { bot: 'fast' }, {}],
    ];
    for (const at of lineup) {
      const view = roomOf(s, 0);
      // An entry past the dealt players is someone seated after the deal: here, no cards.
      const players = at.map((o, i) => ({ ...(view.players[i] ?? { ...view.players[0]!, id: i, seat: i, name: `p${i}` }), ...o }));
      // The server's people: those at the table who are here and are not bots.
      const people = players.filter((p) => p.seat !== null && p.connected && !p.bot).map((p) => p.seat!);
      for (const voting of [[], [0], [0, 1], [0, 1, 2]]) {
        const state = run(s, ...voting.map((seat): [number, Intent] => [seat, { k: 'end', on: true }]));
        const { voters, voted } = endVote(state, seatedPeople(players));
        expect(voters).toBeLessThanOrEqual(state.players.length); // nobody without cards has a say
        expect(voters > 0 && voted === voters).toBe(isOver(resolveEndVote(state, people)));
      }
    }
  });
});

describe('a half-dealt group, the stuck rotation and the Nertz call', () => {
  // Seat 0 has turned one group up (SA S2 S3) and dealt two cards of the next (S4 S5); seat 1 is one card into its first.
  const start = table([{ stock: 'S7 S6 S5 S4 S3 S2 SA', nertz: 'H6' }, { stock: 'D9 D8 D7', nertz: 'C6' }]);
  const base = flips(flips(start, 0, 5), 1, 1);

  it('the rotation takes the half-dealt cards back with the rest of the waste, in the original order', () => {
    expect(base.players.map((p) => p.dealt)).toEqual([2, 1]);
    const r = resolveStuck(run(base, [0, { k: 'stuck', on: true }], [1, { k: 'stuck', on: true }]), [0, 1]);
    expect(r.players.map((p) => [p.dealt, p.waste.length, p.stuck])).toEqual([[0, 0, false], [0, 0, false]]);
    expect(ids(r.players[0]!.stock)).toEqual(['0:SA', ...under(start, 0, 7), '0:S7', '0:S6', '0:S5', '0:S4', '0:S3', '0:S2']); // the old top went to the bottom
    expect(ids(r.players[1]!.stock)).toEqual(['1:D7', ...under(start, 1, 3), '1:D9', '1:D8']);
    expect(checkInvariants(r)).toBeNull();
    // The next group starts from scratch.
    expect(flips(r, 0, 1).players[0]!.dealt).toBe(1);
    expect(ids(flips(r, 0, 3).players[0]!.waste)).toEqual(['0:S2', '0:S3', '0:S4']);
  });

  it("Nertz can be called with a group half-dealt, and freezes everyone else's where it lies", () => {
    const empty = { ...base, players: base.players.map((p, i) => (i === 0 ? { ...p, nertz: [], stock: [...p.nertz, ...p.stock] } : p)) };
    const called = ok(applyIntent(empty, 0, NERTZ));
    expect(isOver(called)).toBe(true);
    expect(called.players.map((p) => p.dealt)).toEqual([2, 1]); // nothing is turned up or taken back
    expect(checkInvariants(called)).toBeNull();
    for (const seat of [0, 1]) rejected(applyIntent(called, seat, FLIP));
    expect(resolveStuck(called, [0, 1])).toBe(called);
    expect(scoreRound(called).map((x) => x.delta)).toEqual([0, -2]);
    // The face-down cards stay face-down on the final table.
    expect(viewFor(called, 1).players[0]!.waste.slice(-2).every(isHidden)).toBe(true);
  });

  it('a half-dealt group never earns grace, but a card from another pile held meanwhile does', () => {
    const g = table([{ stock: 'S7 S6 S5 S4', waste: 'HA', nertz: 'D2' }, {}], { slots: [pile('DA', 1)] });
    const mid = flips(g, 0, 1);
    rejected(applyIntent(mid, 0, hold(mid.players[0]!.waste.at(-1)!.id)));
    const idle = ok(applyIntent(mid, 1, NERTZ));
    expect([inGrace(idle), isOver(idle)]).toEqual([[], true]);
    const holding = run(mid, [0, hold('0:D2')], [1, NERTZ]);
    expect(inGrace(holding)).toEqual([0]);
    rejected(applyIntent(holding, 0, FLIP)); // in grace only the held card may be played
    const landed = ok(applyIntent(holding, 0, move('0:D2', slot(0))));
    expect([isOver(landed), landed.players[0]!.dealt]).toEqual([true, 1]);
    expect(checkInvariants(landed)).toBeNull();
  });

  it('a held waste card is let go of by the first card dealt onto it', () => {
    const g = table([{ stock: 'S7 S6 S5 S4', waste: 'HA', work: ['S9', [], [], []] }]);
    const held = ok(applyIntent(g, 0, hold('0:HA')));
    const dealt = flips(held, 0, 1);
    expect([dealt.players[0]!.holding, dealt.players[0]!.dealt]).toEqual([null, 1]);
    expect(flips(ok(applyIntent(g, 0, hold('0:S9'))), 0, 1).players[0]!.holding).toBe('0:S9');
  });
});

// ---------------------------------------------------------------- stuck

describe('stuck', () => {
  const base = table([
    { stock: 'S5 S4', waste: 'SA S2 S3', nertz: 'H6', work: ['S7', [], [], []] },
    { stock: 'D9', work: ['S9'], rest: 0 }, // a one-card stock: nothing to rotate
    { waste: 'C2 C3', work: ['S9'], rest: 0 }, // no stock, only a waste
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
    // seat 0: original order was (top first) SA S2 S3 S4 S5, then the rest of the deck; the top goes to the bottom
    expect(ids(r.players[0]!.stock)).toEqual(['0:SA', ...under(base, 0, 2), '0:S5', '0:S4', '0:S3', '0:S2']);
    expect(ids(r.players[1]!.stock)).toEqual(['1:D9']);
    expect(ids(r.players[2]!.stock)).toEqual(['2:C2', '2:C3']);
    expect(r.players[0]!.nertz).toEqual(base.players[0]!.nertz);
    // the next group now shows different cards than the first one did
    expect(ids(flips(r, 0, 3).players[0]!.waste)).toEqual(['0:S2', '0:S3', '0:S4']);
  });

  it('is a no-op once Nertz has been called', () => {
    const over: GameState = { ...stuck(stuck(stuck(base, 0), 1), 2), status: { at: 'over', end: { by: 'nertz', seat: 1, out: [1] } } };
    expect(resolveStuck(over, [0, 1, 2])).toBe(over);
  });
});

// ---------------------------------------------------------------- nertz + scoring

describe('calling nertz and scoring', () => {
  const s = table([{ nertz: 'HA', work: ['S9', [], [], []] }, { nertz: 'C5 C6 C7', stock: 'D2' }], { slots: [[c('SA', 1), c('S2', 0), c('S3', 1)]] });

  it('is refused while the nertz pile has cards', () => {
    rejected(applyIntent(s, 0, NERTZ));
    rejected(applyIntent(s, 1, NERTZ));
    rejected(applyIntent(s, 5, NERTZ));
  });

  it('is an explicit action; with nobody holding a card the round is over at once and the table is frozen', () => {
    const emptied = ok(applyIntent(s, 0, move('0:HA', felt(-1.5, 0))));
    expect(calledBy(emptied)).toBeNull(); // emptying the pile does not end the round by itself
    expect(isOver(emptied)).toBe(false);
    const over = ok(applyIntent(emptied, 0, NERTZ));
    expect(calledBy(over)).toBe(0);
    expect(inGrace(over)).toEqual([]);
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

  it('gives Nertz to everyone whose nertz pile is empty when it is called, whether or not they called; it scores nothing', () => {
    const both = table([{ nertz: 'HA', work: ['S9', [], [], []] }, { stock: 'D2' }, { nertz: 'C5' }]);
    expect(wentOut(both)).toEqual([]); // not before a call
    const over = run(both, [0, move('0:HA', felt(-1.5, 0))], [1, NERTZ]);
    expect(over.status).toEqual({ at: 'over', end: { by: 'nertz', seat: 1, out: [0, 1] } });
    expect([calledBy(over), wentOut(over)]).toEqual([1, [0, 1]]);
    expect(scoreRound(over).map((x) => x.delta)).toEqual([1, 0, -2]); // the HA played; going out adds nothing
    expect(checkInvariants(over)).toBeNull();
    expect(checkInvariants({ ...over, status: { at: 'over', end: { by: 'nertz', seat: 1, out: [1] } } })).toMatch(/out is not/);
    // A round that ends without a call gives nobody Nertz.
    expect(wentOut({ ...over, status: { at: 'over', end: { by: 'vote' } } })).toEqual([]);
  });

  it('scores strictly cards in the middle (slots and tray) minus twice the nertz pile, with no bonus for going out', () => {
    const over = run(s, [0, move('0:HA', felt(-1.5, 0))], [0, NERTZ]);
    expect(scoreRound(over)).toEqual([
      { seat: 0, played: 2, nertzLeft: 0, delta: 2 }, // S2 and the HA: nothing extra for calling
      { seat: 1, played: 2, nertzLeft: 3, delta: -4 },
    ]);
    /** Ace to King of `suit`, each rank from the deck of `owner(rank)`. */
    const mixed = (suit: Suit, owner: (rank: number) => number): Card[] => Array.from({ length: 13 }, (_, r) => c(`${suit}${r + 1}`, owner(r + 1)));
    const withTray = table([{ nertz: 'C2 C3' }, {}, { nertz: 'C4', waste: 'C5 C6', work: ['C7', [], [], []] }], {
      slots: [pile('H4', 1), [], mixed('D', (r) => (r === 13 ? 2 : 0))],
      tray: [mixed('S', (r) => r % 2), pile('DK', 1)],
    });
    expect(scoreRound(withTray)).toEqual([
      { seat: 0, played: 12 + 6, nertzLeft: 2, delta: 14 },
      { seat: 1, played: 4 + 7 + 13, nertzLeft: 0, delta: 24 },
      { seat: 2, played: 1, nertzLeft: 1, delta: -1 }, // waste, work and stock cards cost nothing
    ]);
  });
});

// ---------------------------------------------------------------- holding

describe('holding a card', () => {
  const s = table([
    { nertz: 'C9 H6', waste: 'D2 S4', stock: 'C8 C7', work: [{ down: 'D4', up: 'S7' }, 'SK HQ', [], []] },
    { nertz: 'H8' },
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
    expect(checkInvariants({ ...inPlay([0, 1], seeded(1)), players: inPlay([0, 1], seeded(1)).players.map((p) => ({ ...p, holding: p.stock[0]!.id })) })).toMatch(/holding/);
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
  // Seat 0 has the Ace of spades on a red 2; seat 1 has an Ace of spades too. The middle of the felt is the only place either looks at.
  const s = table([
    { nertz: 'D9', work: ['H2 SA', 'C3', [], []] },
    { work: ['SA', 'D5', [], []] },
  ]);

  it('still ends the drag: the hand is empty afterwards, as after a release', () => {
    const raced = run(s, [0, hold('0:SA')], [1, move('1:SA', felt(0, 0))]);
    const drop = move('0:SA', felt(0, 0));
    rejected(applyIntent(raced, 0, drop));
    expect(raced.players[0]!.holding).toBe('0:SA');
    const after = refused(raced, 0, drop);
    expect(after.players[0]!.holding).toBeNull();
    expect(ids(after.players[0]!.work[0]!.cards)).toEqual(['0:H2', '0:SA']); // the card is where it came from
    // So a Nertz call right after finds nobody holding anything.
    expect(isOver(ok(applyIntent(after, 1, NERTZ)))).toBe(true);
    expect(isOver(ok(applyIntent(raced, 1, NERTZ)))).toBe(false); // what it was like without
  });

  it('changes nothing for anything but a move, or when nothing was held', () => {
    const held = run(s, [0, hold('0:SA')]);
    for (const intent of [{ k: 'flip' }, hold('1:SA'), { k: 'clear', slot: 0 }, NERTZ, RELEASE] as Intent[]) expect(refused(held, 0, intent)).toBe(held);
    expect(refused(s, 0, move('0:SA', felt(0, 0)))).toBe(s);
    expect(refused(s, 9, move('0:SA', felt(0, 0)))).toBe(s);
  });

  it('in grace it is that seat\'s one move: they are out, and the round ends if they were the last', () => {
    const called = run(s, [0, hold('0:SA')], [1, NERTZ]);
    expect(inGrace(called)).toEqual([0]);
    const drop = move('0:SA', work(1)); // an Ace on a 3
    rejected(applyIntent(called, 0, drop));
    const after = refused(called, 0, drop);
    expect([inGrace(after), after.players[0]!.holding, isOver(after)]).toEqual([[], null, true]);
    expect(refused(after, 0, drop)).toBe(after); // and that is final
  });

  it('a move names how many cards were lifted, and is refused if that is not what lies there', () => {
    rejected(applyIntent(s, 0, move('0:H2', work(1)))); // "one card", but the Ace is on it
    const both = ok(applyIntent(s, 0, move('0:H2', work(1), 2)));
    expect(ids(both.players[0]!.work[1]!.cards)).toEqual(['0:C3', '0:H2', '0:SA']);
    rejected(applyIntent(s, 0, move('0:SA', felt(0, 0), 2))); // "two cards", but it is the top one
    rejected(applyIntent(s, 0, move('0:D9', work(2), 2))); // the nertz pile only ever gives one
    expect(canDrop(s, 0, '0:H2', work(1))).toBe(true); // canDrop and legalDrops speak of what lies there now
  });
});

describe('a snipe', () => {
  // Seat 1 put its 2 of spades on seat 0's Ace, and then its 3; and its 2s of clubs and diamonds on its own Aces.
  // Seat 0 has a 2 and a 3 of spades and a 2 of clubs of its own showing, a 2 of diamonds under a run, and an Ace of
  // hearts beaten to the felt by seat 1's.
  const s = table([{ nertz: 'S3', waste: 'HA', work: ['S2', 'D2 CA', 'C2', []] }, { work: ['D9', [], [], []] }], {
    slots: [[c('SA'), c('S2', 1), c('S3', 1)], [c('CA', 1), c('C2', 1)], cs('HA', 1), [c('DA', 1), c('D2', 1)]],
  });

  it('is the very card one was about to put down, put there first by someone else since one took it up', () => {
    expect(snipedBy(s, 0, '0:S3', 0, null)).toEqual({ by: 1, card: '1:S3' }); // a move refused on arrival: it was sent, so the pile was waiting for it
    expect(snipedBy(s, 0, '0:S3', 0, '1:S2')).toEqual({ by: 1, card: '1:S3' }); // a drop the window refused: it saw the 2 on top
    expect(snipedBy(s, 0, '0:S3', 0, '0:SA')).toEqual({ by: 1, card: '1:S3' }); // taken up before the 2 came, even
    expect(snipedBy(s, 0, '0:C2', 1, '1:CA')).toEqual({ by: 1, card: '1:C2' });
  });

  it('is that card even when more have gone on it since', () => {
    expect(snipedBy(s, 0, '0:S2', 0, '0:SA')).toEqual({ by: 1, card: '1:S2' }); // it saw the Ace; the 2 and then the 3 came
    expect(snipedBy(s, 0, '0:S2', 0, null)).toEqual({ by: 1, card: '1:S2' });
  });

  it('is not a pile whose top was that card already, nor a card that never went there', () => {
    expect(snipedBy(s, 0, '0:S3', 0, '1:S3')).toBeNull(); // there all along: a card with nowhere to go
    expect(snipedBy(s, 0, '0:S2', 0, '1:S2')).toBeNull(); // the 2 was there already
    expect(snipedBy(s, 0, '0:C2', 0, '0:SA')).toBeNull(); // never went there
    expect(snipedBy(s, 0, '0:S3', 1, '1:CA')).toBeNull();
    expect(snipedBy(s, 0, '0:S3', 4, null)).toBeNull(); // no pile there
  });

  it('believes no top that was not on that very pile, and judges only a card of its own that could be taken up alone', () => {
    expect(snipedBy(s, 0, '0:S3', 0, '1:CA')).toBeNull(); // on another pile
    expect(snipedBy(s, 0, '0:S3', 0, 'nonsense')).toBeNull();
    expect(snipedBy(s, 0, '0:D2', 3, null)).toBeNull(); // under a run
    expect(snipedBy(s, 0, '1:S3', 0, null)).toBeNull(); // not theirs
    expect(snipedBy(s, 1, '1:D9', 0, null)).toBeNull();
  });

  it('is never an Ace: one beaten to a place has others to go to', () => {
    expect(snipedBy(s, 0, '0:HA', 2, null)).toBeNull();
  });
});

describe('held-card grace after a Nertz call', () => {
  // Seat 0 is ready to call. Seat 1 has a 2 of hearts that fits the pile in slot 0 (and nothing else). Seat 2 has a
  // 9 of diamonds with nowhere to go. Seat 3 has a 2 of hearts as well, and a 3 of clubs that fits its last work pile.
  const blocked = ['S9', 'C9', 'SJ', 'CJ'];
  const s = deepFreeze(
    table(
      [
        { stock: 'D2 D3', work: ['S9', [], [], []] },
        { nertz: 'C5 H2', work: blocked, stock: 'D2' },
        { nertz: 'D9', work: blocked },
        { nertz: 'H2', waste: 'C3', work: [...blocked.slice(0, 3), 'D4'] },
      ],
      { slots: [pile('HA', 0)] },
    ),
  );
  const holding = (g: GameState) => g.players.map((p) => p.holding);

  it('nobody holding: the round is over immediately', () => {
    const over = ok(applyIntent(s, 0, NERTZ));
    expect([calledBy(over), inGrace(over), isOver(over)]).toEqual([0, [], true]);
  });

  it('the caller is never in grace: calling puts down whatever they held', () => {
    const over = run(s, [0, hold('0:S9')], [0, NERTZ]);
    expect([inGrace(over), holding(over), isOver(over)]).toEqual([[], [null, null, null, null], true]);
  });

  it('a holder with a legal destination gets one move with that card; it lands, counts, and ends the round', () => {
    const called = run(s, [1, hold('1:H2')], [0, NERTZ]);
    expect(calledBy(called)).toBe(0);
    expect(inGrace(called)).toEqual([1]);
    expect(isOver(called)).toBe(false);
    expect(holding(called)).toEqual([null, '1:H2', null, null]);
    expect(inGrace(viewFor(called, 3))).toEqual([1]); // everyone can see who is still playing
    expect(canDrop(called, 1, '1:H2', slot(0))).toBe(true);
    const over = ok(applyIntent(called, 1, move('1:H2', slot(0))));
    expect([inGrace(over), isOver(over), holding(over)]).toEqual([[], true, [null, null, null, null]]);
    expect(ids(over.slots[0]!.cards)).toEqual(['0:HA', '1:H2']);
    expect(scoreRound(over).map((x) => x.delta)).toEqual([1, 1 - 2, -2, -2]); // the grace move scored and shortened the nertz pile
    rejected(applyIntent(over, 1, move('1:C5', work(0))));
  });

  it('exactly one move, with the held card only, to a legal spot; everything else is refused and keeps them in grace', () => {
    const called = run(s, [3, hold('3:H2')], [0, NERTZ]);
    expect(inGrace(called)).toEqual([3]);
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

  it('whoever empties their nertz pile with the move of grace got Nertz too; the caller is still who called', () => {
    const called = run(s, [3, hold('3:H2')], [0, NERTZ]);
    expect(wentOut(called)).toEqual([0]);
    const over = ok(applyIntent(called, 3, move('3:H2', slot(0))));
    expect(over.status).toEqual({ at: 'over', end: { by: 'nertz', seat: 0, out: [0, 3] } });
    expect([calledBy(over), wentOut(over)]).toEqual([0, [0, 3]]);
    expect(checkInvariants(over)).toBeNull();
  });

  it('a grace move may also go to a work pile, taking the run above the held card with it', () => {
    const g = table([{}, { work: ['S9 H8 C7', 'C9', 'D2', 'D3'] }]);
    const called = run(g, [1, hold('1:H8')], [0, NERTZ]);
    expect(inGrace(called)).toEqual([1]);
    rejected(applyIntent(called, 1, move('1:C7', work(0)))); // part of the lifted run, but not the card that was grabbed
    const over = ok(applyIntent(called, 1, move('1:H8', work(1), 2)));
    expect(ids(over.players[1]!.work[1]!.cards)).toEqual(['1:C9', '1:H8', '1:C7']);
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
    expect(inGrace(called)).toEqual([1]);
    expect(holding(called)).toEqual([null, '1:H2', null, null]);
    rejected(applyIntent(called, 2, RELEASE));
    const alone = run(s, [2, hold('2:D9')], [0, NERTZ]);
    expect([inGrace(alone), holding(alone), isOver(alone)]).toEqual([[], [null, null, null, null], true]);
  });

  it('a target taken during grace by another grace player cuts off whoever now has nowhere to go', () => {
    const called = run(s, [1, hold('1:H2')], [3, hold('3:H2')], [0, NERTZ]);
    expect(inGrace(called)).toEqual([1, 3]);
    const taken = ok(applyIntent(called, 3, move('3:H2', slot(0))));
    expect(ids(taken.slots[0]!.cards)).toEqual(['0:HA', '3:H2']);
    expect([inGrace(taken), holding(taken), isOver(taken)]).toEqual([[], [null, null, null, null], true]);
    expect(ids(taken.players[1]!.nertz)).toEqual(['1:C5', '1:H2']); // seat 1's card went back where it came from
    rejected(applyIntent(taken, 1, move('1:H2', slot(0))));
    rejected(applyIntent(taken, 1, RELEASE));
  });

  it('...but leaves in grace a player whose card still has another home', () => {
    const roomy = { ...s, players: s.players.map((p) => (p.seat === 1 ? { ...p, work: [...p.work.slice(0, 3), { cards: [], down: 0 }] } : p)) };
    const called = run(roomy, [1, hold('1:H2')], [3, hold('3:H2')], [0, NERTZ]);
    const taken = ok(applyIntent(called, 3, move('3:H2', slot(0))));
    expect([inGrace(taken), holding(taken), isOver(taken)]).toEqual([[1], [null, '1:H2', null, null], false]);
    rejected(applyIntent(taken, 1, move('1:H2', slot(0)))); // that spot is gone
    expect(isOver(ok(applyIntent(taken, 1, move('1:H2', work(3)))))).toBe(true);
  });

  it('releasing without a move also ends that player\'s grace', () => {
    const called = run(s, [1, hold('1:H2')], [3, hold('3:H2')], [0, NERTZ]);
    const one = ok(applyIntent(called, 1, RELEASE));
    expect([inGrace(one), holding(one)]).toEqual([[3], [null, null, null, '3:H2']]);
    expect(one.slots).toEqual(called.slots);
    rejected(applyIntent(one, 1, move('1:H2', slot(0)))); // they let go: frozen like everyone else
    const over = ok(applyIntent(one, 3, RELEASE));
    expect(isOver(over)).toBe(true);
    expect(scoreRound(over)).toEqual(scoreRound(called));
  });

  it('expireGrace cuts off everyone still in grace and is otherwise the identity', () => {
    const called = run(s, [1, hold('1:H2')], [3, hold('3:H2')], [0, NERTZ]);
    const expired = expireGrace(called);
    expect([inGrace(expired), holding(expired), isOver(expired), calledBy(expired)]).toEqual([[], [null, null, null, null], true, 0]);
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
    expect(inGrace(predicted)).toEqual(inGrace(truth));
    expect(predicted.slots).toEqual(truth.slots);
    expect(predicted.players[1]!.nertz.at(-1)).toEqual(truth.players[1]!.nertz.at(-1)); // its face was sent ahead (the client still holds it back until the server confirms: net.ts `unconfirmed`)
    // (Called with nobody holding a card, the round is over at once, and the faces sent early are taken back.)
    expect(viewFor(ok(applyIntent(viewFor(s, 0), 0, NERTZ)), 0)).toEqual(viewFor(ok(applyIntent(s, 0, NERTZ)), 0));
    expect(ok(applyIntent(viewFor(ok(applyIntent(s, 1, hold('1:H2'))), 0), 0, NERTZ))).toEqual(viewFor(run(s, [1, hold('1:H2')], [0, NERTZ]), 0));
  });

  // The call reaches each window a moment after it is made, and a card may be on its way up meanwhile.
  const HEARD: Intent = { k: 'heard' };
  const call = (unheard: number[]): Intent => ({ k: 'nertz', unheard });

  it('waits for the windows it has not reached: with nobody holding a card, it is over once the last of them has heard', () => {
    const called = ok(applyIntent(s, 0, call([1, 3])));
    expect([calledBy(called), inGrace(called), yetToHear(called), isOver(called)]).toEqual([0, [], [1, 3], false]);
    expect(checkInvariants(called)).toBeNull();
    const one = ok(applyIntent(called, 3, HEARD));
    expect([yetToHear(one), isOver(one)]).toEqual([[1], false]);
    rejected(applyIntent(one, 3, HEARD)); // once
    const over = ok(applyIntent(one, 1, HEARD));
    expect(over).toEqual(ok(applyIntent(s, 0, NERTZ))); // as if everyone had heard it at once
  });

  it('a card taken up before the call reached that window was in hand at the call: with somewhere to go, it has its one move', () => {
    const called = ok(applyIntent(s, 0, call([1, 2, 3])));
    const held = ok(applyIntent(called, 1, hold('1:H2'))); // sent before seat 1 had the call, though it reached the server after
    expect([inGrace(held), holding(held), isOver(held)]).toEqual([[1], [null, '1:H2', null, null], false]);
    const heard = run(held, [1, HEARD], [2, HEARD], [3, HEARD]);
    expect([inGrace(heard), yetToHear(heard), isOver(heard)]).toEqual([[1], [], false]);
    expect(checkInvariants(heard)).toBeNull();
    ok(applyIntent(held, 3, hold('3:H2'))); // seat 3 could have, until it heard
    rejected(applyIntent(heard, 3, hold('3:H2')));
    const over = ok(applyIntent(heard, 1, move('1:H2', slot(0))));
    expect(over).toEqual(run(s, [1, hold('1:H2')], [0, NERTZ], [1, move('1:H2', slot(0))])); // as if the hold had come first
    // A card taken up and put down before the call reached that window: the move counts all the same, and is the
    // seat's last (it hears the call with it).
    const played = run(called, [1, hold('1:H2')], [1, move('1:H2', slot(0))]);
    expect([yetToHear(played), ids(played.slots[0]!.cards)]).toEqual([[2, 3], ['0:HA', '1:H2']]);
    rejected(applyIntent(played, 1, hold('1:C5'))); // (its next nertz card: before the move it could have)
    rejected(applyIntent(played, 1, HEARD));
    expect(isOver(run(played, [2, HEARD], [3, HEARD]))).toBe(true);
    // So is a card put back, and a drop refused (it ends the drag as a release does).
    expect(yetToHear(run(called, [1, hold('1:H2')], [1, RELEASE]))).toEqual([2, 3]);
    expect(yetToHear(refused(held, 1, move('1:H2', slot(5))))).toEqual([2, 3]);
  });

  it('...but not a card with nowhere to go; and the windows it has not reached may only take a card up, or say they heard', () => {
    const called = ok(applyIntent(s, 0, call([2, 3])));
    const cut = ok(applyIntent(called, 2, hold('2:D9')));
    expect([inGrace(cut), holding(cut), yetToHear(cut)]).toEqual([[], [null, null, null, null], [2, 3]]);
    rejected(applyIntent(called, 1, hold('1:H2'))); // seat 1's window was not waited for: it has heard
    for (const intent of [{ k: 'flip' }, { k: 'stuck', on: true }, { k: 'end', on: true }, NERTZ, RELEASE, move('3:C3', work(3)), { k: 'clear', slot: 0 }] as Intent[]) {
      rejected(applyIntent(called, 3, intent));
    }
    rejected(applyIntent(called, 0, HEARD)); // the call is the caller's own
    rejected(applyIntent(s, 1, HEARD)); // nothing has been called
    expect(yetToHear(ok(applyIntent(s, 0, call([0, 3, 3, 7]))))).toEqual([3]); // only others at the table
    expect(isOver(expireGrace(called))).toBe(true); // the window shuts on them too
  });
});

// ---------------------------------------------------------------- views

describe('viewFor', () => {
  const full = inPlay([0, 1], seeded(3));
  const flipped = flips(full, 0, 3);
  /** Someone watching: no hand is theirs. */
  const WATCHER = -1;
  const view = viewFor(flipped, WATCHER);

  it('hides from a watcher every stock, everything under each nertz top and the face-down work cards, keeping ids and owners', () => {
    for (const [pi, p] of view.players.entries()) {
      const real = flipped.players[pi]!;
      expect(p.stock.every(isHidden)).toBe(true);
      expect(p.nertz.slice(0, -1).every(isHidden)).toBe(true);
      expect(p.nertz.at(-1)).toEqual(real.nertz.at(-1));
      for (const [i, { cards: w }] of p.work.entries()) {
        expect(w.slice(0, -1).every(isHidden)).toBe(true);
        expect(w.at(-1)).toEqual(real.work[i]!.cards.at(-1));
        expect(ids(w)).toEqual(ids(real.work[i]!.cards));
      }
      expect(downs(p)).toEqual(downs(real));
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

  it('shows a player, and nobody else, the faces its next move could turn up; never deeper than the card under its nertz top, nor before play opens', () => {
    const mine = viewFor(flipped, 0);
    const [own, real] = [mine.players[0]!, flipped.players[0]!];
    expect(own.stock.slice(-3)).toEqual(real.stock.slice(-3)); // the next group
    expect(own.stock.slice(0, -3).every(isHidden)).toBe(true);
    for (const [i, w] of own.work.entries()) {
      const down = real.work[i]!.down;
      expect(w.cards.slice(0, Math.max(0, down - 1)).every(isHidden)).toBe(true);
      if (down > 0) expect(w.cards[down - 1]).toEqual(real.work[i]!.cards[down - 1]);
    }
    expect(own.nertz.at(-2)).toEqual(real.nertz.at(-2)); // the card under the top
    expect(own.nertz.slice(0, -2).every(isHidden)).toBe(true);
    expect(mine.players[1]).toEqual(view.players[1]); // the other hand exactly as a watcher sees it
    expect(checkInvariants(mine)).toBeNull();
    // Before play opens: nothing.
    const ready = finishDeal(dealRound([0, 1], seeded(3)));
    expect(viewFor(ready, 0)).toEqual(viewFor(ready, WATCHER));
    // So a group dealt on the player's own view turns up with its faces, just as the server will have it.
    expect(flips(mine, 0, 3).players[0]!.waste).toEqual(flips(flipped, 0, 3).players[0]!.waste);
  });

  it('is idempotent, passes the invariant check, and does not mutate its input', () => {
    expect(viewFor(view, 1)).toEqual(view);
    expect(viewFor(viewFor(flipped, 0), 0)).toEqual(viewFor(flipped, 0));
    expect(checkInvariants(view)).toBeNull();
    const frozen = deepFreeze(inPlay([0, 1], seeded(4)));
    expect(() => viewFor(frozen, 0)).not.toThrow();
  });

  it('keeps the whole middle and the grace state visible', () => {
    const g = table([{}, { nertz: 'H2' }], { slots: [pile('HA', 0)], tray: [pile('SK', 0)] });
    const called = run(g, [1, hold('1:H2')], [0, NERTZ]);
    const v = viewFor(called, 1);
    expect([v.slots, v.tray, inGrace(v), calledBy(v)]).toEqual([called.slots, called.tray, [1], 0]);
  });

  it('lets the reducer run structurally on hidden cards but never judge them', () => {
    // dealing on a view: hidden cards land in the waste, and stay hidden when the group turns up (the faces come with the snapshot)
    const predicted = flips(viewFor(full, WATCHER), 0, 3);
    expect(predicted.players[0]!.dealt).toBe(0);
    expect(predicted.players[0]!.waste.every(isHidden)).toBe(true);
    expect(ids(predicted.players[0]!.waste)).toEqual(ids(flipped.players[0]!.waste));
    // a hidden waste top cannot be moved anywhere, not even to an empty pile
    const hiddenTop = predicted.players[0]!.waste.at(-1)!.id;
    const withGap = { ...predicted, players: predicted.players.map((p) => ({ ...p, work: [{ cards: [], down: 0 }, ...p.work.slice(1)] })) };
    rejected(applyIntent(withGap, 0, move(hiddenTop, work(0))));
    rejected(applyIntent(withGap, 0, move(hiddenTop, slot(0))));
    rejected(applyIntent(withGap, 0, hold(hiddenTop)));
    expect(grab(withGap, 0, hiddenTop)).toBeNull();
    expect(legalDrops(withGap, 0, hiddenTop)).toEqual([]);
    // playing the nertz top twice uncovers a hidden card (only the one under the top is sent ahead), which is stuck until the server reveals it
    const v = viewFor(table([{ nertz: 'D4 S9 H6', work: ['S7', 'H10', [], []] }]), 0);
    const once = ok(applyIntent(v, 0, move('0:H6', work(0))));
    expect(isHidden(once.players[0]!.nertz.at(-1)!)).toBe(false); // the card under the top was sent ahead: it turns up at once
    const twice = ok(applyIntent(once, 0, move('0:S9', work(1))));
    expect(isHidden(twice.players[0]!.nertz.at(-1)!)).toBe(true);
    rejected(applyIntent(twice, 0, move('0:D4', work(2))));
  });
});

// ---------------------------------------------------------------- invariants

describe('checkInvariants', () => {
  const good = inPlay([0, 1], seeded(5));
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
    const bad = withPlayer0((p) => ({ work: [{ cards: p.work.flatMap((w) => w.cards), down: 0 }, ...p.work.slice(1).map(() => ({ cards: [], down: 0 }))] }));
    expect(checkInvariants(bad)).toMatch(/alternating run/);
  });
  it('catches a work pile with no face-up top', () =>
    expect(checkInvariants(withPlayer0((p) => ({ work: [{ ...p.work[0]!, down: 1 }, ...p.work.slice(1)] })))).toMatch(/no face-up card/));
  it('catches a nertz call with cards left', () => expect(checkInvariants({ ...good, status: { at: 'over', end: { by: 'nertz', seat: 0, out: [0] } } })).toMatch(/nertz called/));
  it('catches a wrong number of work piles', () => expect(checkInvariants(withPlayer0((p) => ({ work: p.work.slice(1) })))).toMatch(/work piles/));
  it("catches a card in someone else's pile", () => {
    const [a, b] = good.players as [PlayerState, PlayerState];
    const swapped = { ...good, players: [{ ...a, waste: [b.stock[0]!] }, { ...b, stock: b.stock.slice(1) }] };
    expect(checkInvariants(swapped)).toMatch(/owned by seat 1/);
  });
  it('catches a malformed centre pile, a wrong slot count and an unfinished tray pile', () => {
    const p = good.players[0]!;
    const card = p.work[0]!.cards[0] as Card;
    const without = withPlayer0(() => ({ work: [{ cards: [], down: 0 }, ...p.work.slice(1)] }));
    const inSlot: GameState = { ...without, slots: [{ cards: [card], at: { x: 0, y: 0, r: 0 } }, ...good.slots.slice(1)] };
    if (card.rank === 1) expect(checkInvariants(inSlot)).toBeNull();
    else expect(checkInvariants(inSlot)).toMatch(/ace-up/);
    expect(checkInvariants({ ...good, slots: good.slots.slice(1) })).toMatch(/centre slots/);
    const ace = [...p.nertz, ...p.stock].find((x) => (x as Card).rank === 1) as Card;
    const moved = withPlayer0((q) => ({ nertz: q.nertz.filter((x) => x !== ace), stock: q.stock.filter((x) => x !== ace) }));
    expect(checkInvariants({ ...moved, slots: [{ cards: [ace], at: { x: 0, y: 0, r: 0 } }, ...good.slots.slice(1)] })).toBeNull();
    expect(checkInvariants({ ...moved, tray: [[ace]] })).toMatch(/tray/);
  });
  it('catches inconsistent grace', () => {
    const emptied = withPlayer0((p) => ({ nertz: [], stock: [...p.stock, ...p.nertz] }));
    expect(checkInvariants({ ...emptied, status: { at: 'grace', calledBy: 0, unheard: [] } })).toMatch(/grace with nobody/);
    const holder = { ...emptied, players: emptied.players.map((p, i) => (i === 1 ? { ...p, holding: p.nertz.at(-1)!.id } : p)) };
    expect(checkInvariants({ ...holder, status: { at: 'over', end: { by: 'nertz', seat: 0, out: [0] } } })).toMatch(/frozen player/);
    expect(checkInvariants({ ...holder, status: { at: 'grace', calledBy: 0, unheard: [] } })).toMatch(/in grace without/); // that card has nowhere to go
    expect(checkInvariants({ ...emptied, status: { at: 'grace', calledBy: 0, unheard: [1] } })).toBeNull(); // waiting to be heard
    for (const unheard of [[0], [1, 1], [5]]) expect(checkInvariants({ ...emptied, status: { at: 'grace', calledBy: 0, unheard } })).toMatch(/heard where it cannot/);
  });
});

// ---------------------------------------------------------------- garbage

describe('robustness', () => {
  const state = deepFreeze(inPlay([0, 1], seeded(11)));
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
    const rng = seeded(99);
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

// ---------------------------------------------------------------- starting a pile on the felt

describe('starting a pile on the felt', () => {
  const aces: Hand = { work: ['SA', 'HA', 'DA', 'C5'] };

  it('the table is dealt with no piles at all', () => {
    for (const n of [2, 3, 4, 5, 6]) {
      const dealt = dealRound(Array.from({ length: n }, (_, i) => i), seeded(n));
      expect(dealt.slots).toEqual(Array.from({ length: 4 * n }, () => null));
      expect(checkInvariants(dealt)).toBeNull();
    }
  });

  it('an Ace starts a pile at the very point it is put down, in the first unused slot', () => {
    const s = table([aces, aces]);
    const next = ok(applyIntent(s, 0, move('0:SA', felt(0.2, -0.3))));
    expect(ids(next.slots[0]!.cards)).toEqual(['0:SA']);
    expect(next.slots[0]!.at).toMatchObject({ x: 0.2, y: -0.3 });
    expect(Math.abs(next.slots[0]!.at.r)).toBeLessThanOrEqual(2.5);
    expect(next.slots.slice(1).every((p) => p === null)).toBe(true);
    // The next one takes the next slot, wherever it is put; the place is in every player's view.
    const then = ok(applyIntent(next, 1, move('1:HA', felt(-0.4, 0.2))));
    expect(ids(then.slots[1]!.cards)).toEqual(['1:HA']);
    expect(viewFor(then, 0).slots.slice(0, 2).map((p) => p!.at)).toEqual(then.slots.slice(0, 2).map((p) => p!.at));
    // Coordinates arrive rounded to a thousandth of the table, however they were sent.
    const fine = ok(applyIntent(s, 0, move('0:SA', felt(0.20004, -0.29996))));
    expect(fine.slots[0]!.at).toMatchObject({ x: 0.2, y: -0.3 });
  });

  it('every other card goes on the exact pile', () => {
    const s = table([{ work: ['S2', 'H2', 'DA', 'C5'] }, {}], { slots: [{ cards: pile('SA', 1), x: 0.1, y: 0.1 }] });
    rejected(applyIntent(s, 0, move('0:S2', felt(0.1, 0.1)))); // not by pointing at the felt under it
    rejected(applyIntent(s, 0, move('0:S2', felt(-0.5, 0)))); // and a two starts nothing
    rejected(applyIntent(s, 0, move('0:H2', slot(0))));
    const next = ok(applyIntent(s, 0, move('0:S2', slot(0))));
    expect(ids(next.slots[0]!.cards)).toEqual(['1:SA', '0:S2']);
    expect(next.slots.map((p) => p?.at)).toEqual(s.slots.map((p) => p?.at)); // the pile stays where it is
    expect(legalDrops(s, 0, '0:S2')).toEqual([slot(0)]);
  });

  it('starting a pile keeps to the opening and to clear-first like everything else: nothing lands before play, and a seat with a finished pile may only clear it', () => {
    const s = table([aces, aces]);
    for (const stage of ['dealing', 'ready', 'countdown'] as const) {
      // (Before play the nertz tops are hidden in a real round; the reducer refuses by stage before it looks at any card.)
      const closed: GameState = { ...s, status: { at: stage } };
      rejected(applyIntent(closed, 0, move('0:SA', felt(0, 0))));
      rejected(applyIntent(closed, 0, hold('0:SA')));
      expect(canDrop(closed, 0, '0:SA', felt(0, 0))).toBe(false);
    }
    // Seat 0 finished the hearts and has not carried them off: its Ace stays in its hand, on felt that is free for anyone else.
    const waiting = table([{ work: ['SA', 'C9', 'DA', 'C5'] }, aces], { slots: [{ cards: pile('HK'), x: 0.5, y: 0 }] });
    expect(mustClear(waiting, 0)).toBe(true);
    expect(feltFree(waiting, { x: -0.5, y: 0 })).toBe(true);
    expect(applyIntent(waiting, 0, move('0:SA', felt(-0.5, 0)))).toEqual({ ok: false, reason: CLEAR_FIRST });
    expect(applyIntent(waiting, 0, { k: 'flip' })).toEqual({ ok: false, reason: CLEAR_FIRST });
    expect(canDrop(waiting, 0, '0:SA', felt(-0.5, 0))).toBe(false);
    ok(applyIntent(waiting, 1, move('1:SA', felt(-0.5, 0)))); // nobody else is held up
    const cleared = ok(applyIntent(waiting, 0, { k: 'clear', slot: 0 }));
    expect(cleared.slots[0]).toBeNull(); // the felt it lay on is anybody's again
    ok(applyIntent(cleared, 0, move('0:SA', felt(0.5, 0))));
    expect(checkInvariants(cleared)).toBeNull();
  });

  it('refuses an Ace on an empty slot: there are none to aim at', () => {
    const s = table([aces, aces]);
    for (let i = 0; i < 8; i++) rejected(applyIntent(s, 0, move('0:SA', slot(i))));
  });

  it('refuses a pile off the felt or hanging over its edge, and junk coordinates', () => {
    const s = table([aces, aces]);
    const { w, h } = cardSize(2);
    ok(applyIntent(s, 0, move('0:SA', felt(0, 1 - h / 2 - 0.02))));
    rejected(applyIntent(s, 0, move('0:SA', felt(0, 1 - h / 2 + 0.02)))); // the card would hang over the edge
    ok(applyIntent(s, 0, move('0:SA', felt(-(TABLE.hw - w / 2 - 0.02), 0)))); // right out at the end of the felt
    rejected(applyIntent(s, 0, move('0:SA', felt(TABLE.hw - w / 2 + 0.02, 0))));
    rejected(applyIntent(s, 0, move('0:SA', felt(TABLE.hw - w / 2 - 0.02, 1 - h / 2 - 0.02)))); // a rounded-off corner of the felt
    rejected(applyIntent(s, 0, move('0:SA', felt(TABLE.hw, 1))));
    for (const bad of [NaN, Infinity, TABLE.hw + 0.5, -7, '0.1', null, undefined]) {
      rejected(applyIntent(s, 0, move('0:SA', { k: 'felt', x: bad, y: 0 } as unknown as PileRef)));
      rejected(applyIntent(s, 0, move('0:SA', { k: 'felt', x: 0, y: bad } as unknown as PileRef)));
    }
    rejected(applyIntent(s, 0, move('0:SA', { k: 'felt', x: 0, y: 1.5 })));
    rejected(applyIntent(s, 0, move('0:SA', { k: 'felt' } as unknown as PileRef)));
  });

  it('refuses a pile that would overlap another or leave less than the gap, and nothing else: right beside a pile is fine', () => {
    for (const n of [2, 4, 6]) {
      const { w, h } = cardSize(n);
      const gap = pileGap(n);
      const s = table([aces, ...Array.from({ length: n - 1 }, () => ({}))], { slots: [{ cards: pile('C3', 1), x: 0, y: 0 }] });
      rejected(applyIntent(s, 0, move('0:SA', felt(0, 0))));
      rejected(applyIntent(s, 0, move('0:SA', felt(w * 0.9, 0)))); // side by side, overlapping
      rejected(applyIntent(s, 0, move('0:SA', felt(w + gap * 0.5, 0)))); // clear, but closer than the gap
      rejected(applyIntent(s, 0, move('0:SA', felt(0, -h * 0.9))));
      rejected(applyIntent(s, 0, move('0:SA', felt(-(w + gap * 0.5), h + gap * 0.5)))); // corner to corner, too close both ways
      // The gap away, to either side, above or below: there is room. One pile keeps off no more than that.
      const beside = ok(applyIntent(s, 0, move('0:SA', felt(w + gap + 0.002, 0))));
      expect(ids(beside.slots[1]!.cards)).toEqual(['0:SA']);
      expect(checkInvariants(beside)).toBeNull();
      ok(applyIntent(s, 0, move('0:SA', felt(-(w + gap + 0.002), h * 0.5))));
      ok(applyIntent(s, 0, move('0:SA', felt(w * 0.5, h + gap + 0.002)))); // overlapping columns, but one above the other
      ok(applyIntent(s, 0, move('0:SA', felt(0, -(h + gap + 0.002)))));
      // It is the same for every player: the felt is not turned for anyone.
      for (let seat = 1; seat < n; seat++) {
        const theirs = table(Array.from({ length: n }, (_, i): Hand => (i === seat ? { work: ['SA'] } : {})), { slots: [{ cards: pile('C3'), x: 0, y: 0 }] });
        ok(applyIntent(theirs, seat, move(`${seat}:SA`, felt(w + gap + 0.002, 0))));
        rejected(applyIntent(theirs, seat, move(`${seat}:SA`, felt(w + gap * 0.5, 0))));
      }
    }
  });

  it('two Aces for the same patch of felt: the first lands, the second goes home; elsewhere there is room for both', () => {
    const s = table([aces, aces]);
    const first = ok(applyIntent(ok(applyIntent(s, 0, hold('0:SA'))), 0, move('0:SA', felt(0.1, 0))));
    const held = ok(applyIntent(first, 1, hold('1:HA')));
    const late = move('1:HA', felt(0.12, 0.05)); // aimed while the felt was still bare
    ok(applyIntent(ok(applyIntent(s, 1, hold('1:HA'))), 1, late)); // it would have landed a moment earlier
    const r = applyIntent(held, 1, late);
    rejected(r);
    const after = refused(held, 1, late);
    expect(after.players[1]!.holding).toBeNull(); // the drop is over: the card is back in its pile
    expect(ids(after.players[1]!.work[1]!.cards)).toEqual(['1:HA']);
    expect(after.slots.filter((pile) => pile !== null)).toHaveLength(1);
    expect(after.slots.map((pile) => pile?.at)).toEqual(first.slots.map((pile) => pile?.at));
    // The same Ace a little further off is fine, whoever was first.
    const both = ok(applyIntent(held, 1, move('1:HA', felt(-0.5, 0))));
    expect(both.slots.filter((pile) => pile !== null)).toHaveLength(2);
  });

  it('holds at most four piles per player: with every slot in use there is no room, however much felt is bare', () => {
    // Fill the table one Ace at a time through the rules: both players' four Aces.
    let s = table([{ work: ['SA', 'HA', 'DA', 'CA'] }, { work: ['SA', 'HA', 'DA', 'CA'], nertz: 'C5' }]);
    const spare = legalDrops(s, 0, '0:SA').find((to) => to.k === 'felt')!;
    expect(spare).toEqual(felt(0, 0)); // one place is always on offer while there is room: the clear one nearest the middle
    const faces = ['SA', 'HA', 'DA', 'CA'];
    for (let n = 0; n < 8; n++) {
      const seat = n < 4 ? 0 : 1;
      const cardId = `${seat}:${faces[n % 4]}`;
      const to = legalDrops(s, seat, cardId).find((x) => x.k === 'felt')!;
      expect(to, `pile ${n + 1}`).toBeDefined();
      s = ok(applyIntent(s, seat, move(cardId, to)));
    }
    expect(s.slots.every((pile) => pile?.cards.length === 1)).toBe(true);
    for (const at of [{ x: 0.9, y: 0 }, { x: -0.9, y: 0 }, { x: 0, y: 0 }]) expect(feltFree(s, at)).toBe(false);
  });

  it('a ninth Ace has nowhere to go while all eight piles lie, and somewhere again once one is cleared', () => {
    // Two decks have only eight Aces, so no real table gets here: the last of the eight piles is made up.
    const king = pile('SK');
    const { h } = cardSize(2);
    const spread = [[-0.5, 0], [0.5, 0], [-0.25, h * 1.2], [0.25, h * 1.2], [-0.25, -h * 1.2], [0.25, -h * 1.2], [1, 0]] as const;
    const ones = [c('DA'), c('CA'), c('SA', 1), c('HA', 1), c('DA', 1), c('CA', 1)].map((ace, i) => ({ cards: [ace], x: spread[i]![0], y: spread[i]![1] }));
    const seven = table([{ nertz: 'C9', work: ['HA'] }, { nertz: 'C9' }], { slots: [{ cards: king, x: 0, y: 0 }, ...ones] });
    const [x, y] = spread[6];
    const ninth: Card = { id: 'x', owner: 1, suit: 'D', rank: 1 };
    const s: GameState = { ...seven, slots: seven.slots.map((p, i) => (i === 7 ? { cards: [ninth], at: { x, y, r: 0 } } : p)) };
    expect(legalDrops(s, 0, '0:HA').filter((to) => to.k === 'felt')).toEqual([]);
    rejected(applyIntent(s, 0, move('0:HA', felt(-1.5, 0)))); // bare felt, but the round has its eight piles
    expect(feltFree(s, { x: -1.5, y: 0 })).toBe(false);
    const cleared = ok(applyIntent(s, 0, { k: 'clear', slot: 0 }));
    expect(cleared.slots[0]).toBeNull(); // the felt it lay on is free again
    expect(cleared.tray).toEqual([king]);
    const again = ok(applyIntent(cleared, 0, move('0:HA', felt(0, 0))));
    expect(ids(again.slots[0]!.cards)).toEqual(['0:HA']);
    expect(again.slots[0]!.at).toMatchObject({ x: 0, y: 0 });
  });

  it('held-card grace: an Ace in hand still has somewhere to go while there is room, and its one move may be to the felt', () => {
    const s = table([{ nertz: 'C9', work: ['SA'] }, { work: ['H5'] }]);
    const holding = ok(applyIntent(s, 0, hold('0:SA')));
    const called = ok(applyIntent(holding, 1, NERTZ));
    expect(inGrace(called)).toEqual([0]);
    const landed = ok(applyIntent(called, 0, move('0:SA', felt(0.3, 0.3))));
    expect(isOver(landed)).toBe(true);
    expect(scoreRound(landed).find((x) => x.seat === 0)!.played).toBe(1);
  });

  it('checkInvariants catches piles on top of each other, and one off the table', () => {
    const s = table([{}, {}], { slots: [{ cards: [c('SA')], x: 0, y: 0 }, { cards: [c('SA', 1)], x: 0.5, y: 0 }] });
    const secondAt = (x: number): GameState => ({ ...s, slots: s.slots.map((p, i) => (i === 1 ? { ...p!, at: { ...p!.at, x } } : p)) });
    expect(checkInvariants(secondAt(0.05))).toMatch(/overlapping/);
    expect(checkInvariants(secondAt(TABLE.hw - 0.05))).toMatch(/off the table/);
  });
});

// ---------------------------------------------------------------- random play

/** How many random intents a seed of each random run plays. */
const INTENTS = 1000;
/** How many chains of intents a seed of the prediction run plays. */
const CHAINS = 200;

/** A deal with only `n` cards in each nertz pile (the rest go under the stock), so that Nertz calls actually happen in random play. */
function shortDeal(seats: readonly number[], rng: Rng, n = 2): GameState {
  const g = inPlay(seats, rng);
  return { ...g, players: g.players.map((p) => ({ ...p, nertz: p.nertz.slice(-n), stock: [...p.nertz.slice(0, -n), ...p.stock] })) };
}

describe('random play keeps every invariant', () => {
  // Short deals call Nertz often enough for rounds to end and for grace windows to open; more than two seats have
  // face-down work cards to turn up. Each case runs seeds until it has seen all it is meant to.
  for (const [seatCount, short] of [[2, false], [3, false], [4, true], [6, true], [2, true]] as const) {
    const goals = ['started', 'centre', ...(seatCount > 2 ? ['reveal'] : []), ...(short ? ['round'] : []), ...(short && seatCount > 2 ? ['grace'] : [])];
    it(`${seatCount} seats, ${INTENTS} intents a seed${short ? ', short nertz piles' : ''}, until it has seen ${goals.join(', ')}`, () => {
      untilReached(goals, 12, (rng, reached) => {
        const seats = Array.from({ length: seatCount }, (_, i) => i * 2); // non-contiguous seats on purpose
        const fresh = () => deepFreeze(short ? shortDeal(seats, rng) : inPlay(seats, rng));
        let state = fresh();
        let accepted = 0;
        for (let step = 0; step < INTENTS; step++) {
          const seat = seats[Math.floor(rng() * seats.length)]!;
          const intent = randomIntent(state, seat, rng, MIXES.wild);
          const before = state;
          const r = applyIntent(state, seat, intent); // throws if it mutates the frozen state
          if (r.ok) {
            accepted++;
            const resolved = resolveStuck(r.state, seats);
            if (resolved !== r.state) reached('centre'); // (a rotation: the stock was moving)
            state = deepFreeze(resolved);
            const problem = checkInvariants(state) ?? checkInvariants(viewFor(state, seat));
            if (problem) throw new Error(`step ${step}, seat ${seat}, ${JSON.stringify(intent)}: ${problem}`);
            expect(allCards(state)).toHaveLength(52 * seatCount);
            expect(state.slots).toHaveLength(4 * seatCount);
            if (intent.k === 'move' && intent.to.k === 'felt') {
              // A pile was started on bare felt: exactly there, in a slot that was empty, clear of every pile that was lying.
              reached('started');
              const i = state.slots.findIndex((pile, j) => pile?.cards.length === 1 && before.slots[j] === null);
              const place = state.slots[i]!.at;
              expect(place.x).toBeCloseTo(intent.to.x, 3); // (to the thousandth of the table it is kept at)
              expect(place.y).toBeCloseTo(intent.to.y, 3);
              expect(onTable(place, seatCount)).toBe(true);
              for (const pile of before.slots) if (pile) expect(clash(pile.at, place, seatCount)).toBe(false);
            }
            if (calledBy(before) === null && inGrace(state).length > 0) reached('grace');
            if (calledBy(before) !== null) {
              // In grace: only someone who was in it can have acted, they are out of it now, and nobody was added.
              expect(inGrace(before)).toContain(seat);
              expect(inGrace(state)).not.toContain(seat);
              expect(inGrace(state).every((g) => inGrace(before).includes(g))).toBe(true);
            }
            if (intent.k === 'clear') {
              expect(completedBy(before.slots[intent.slot]!)).toBe(seat);
              expect(state.tray.at(-1)).toEqual(before.slots[intent.slot]!.cards);
              expect(state.slots[intent.slot]).toBeNull(); // the felt is anybody's again
            }
            if (inSlots(state).length > 0) reached('centre');
            const downs = (g: GameState) => g.players.reduce((n, p) => n + p.work.reduce((a, w) => a + w.down, 0), 0);
            if (downs(state) < downs(before)) reached('reveal');
          }
          // The server's timer, played by the dice: grace does not last for ever.
          if (calledBy(state) !== null && rng() < 0.1) state = deepFreeze(expireGrace(state));
          if (isOver(state)) {
            expect(checkInvariants(state)).toBeNull();
            expect(state.players.every((p) => p.holding === null)).toBe(true);
            expect(scoreRound(state).reduce((n, x) => n + x.played, 0)).toBe(inSlots(state).length + state.tray.flat().length);
            for (const intent of [{ k: 'flip' }, RELEASE, NERTZ] as Intent[]) rejected(applyIntent(state, seat, intent));
            reached('round');
            state = fresh();
          }
        }
        expect(accepted).toBeGreaterThan(INTENTS / 4);
      });
    }, FUZZ_MS);
  }

  it('long games reach kings, clears and slot reuse without breaking anything', () => {
    // Greedy play to the middle by four seats, never calling Nertz, clearing finished piles as they appear.
    const rng = seeded(77);
    const seats = [0, 1, 2, 3];
    let state = inPlay(seats, rng);
    let cleared = 0;
    let reused = 0;
    const freed = new Set<number>();
    for (let step = 0; step < 60_000 && (cleared < 3 || reused === 0); step++) {
      const seat = seats[step % 4]!;
      const done = state.slots.findIndex((pile) => completedBy(pile) === seat);
      const legal = legalMoves(state, seat);
      const toMiddle = legal.filter((m) => m.k === 'move' && m.to.k !== 'work');
      const fromNertz = legal.filter((m) => m.k === 'move' && grab(state, seat, m.cardId)!.from.k !== 'work');
      const intent: Intent =
        done >= 0 ? { k: 'clear', slot: done } : (toMiddle[0] ?? (rng() < 0.5 ? fromNertz[0] : undefined) ?? (rng() < 0.1 ? legal[0] : undefined) ?? { k: 'flip' });
      const me = state.players[seat]!;
      const r = applyIntent(state, seat, me.stock.length + me.waste.length === 0 ? { k: 'stuck', on: true } : intent);
      if (!r.ok) continue;
      if (intent.k === 'clear') (cleared++, freed.add(intent.slot));
      // An Ace takes the first slot nobody is using.
      const into = intent.k === 'move' && intent.to.k === 'felt' ? state.slots.indexOf(null) : -1;
      if (freed.has(into) && r.state.slots[into]?.cards.length === 1) reused++;
      state = resolveStuck(r.state, seats);
      expect(checkInvariants(state)).toBeNull();
    }
    expect(state.tray.length).toBe(cleared);
    expect(scoreRound(state).reduce((n, x) => n + x.played, 0)).toBe(inSlots(state).length + 13 * cleared);
    expect(cleared).toBeGreaterThanOrEqual(3);
    expect(reused).toBeGreaterThan(0); // an Ace went into a slot a finished pile had been cleared from
  }, FUZZ_MS);
});

describe('greedy bots can finish a round', () => {
  /** Middle first, then nertz to work, then turning over a face-down work card, then waste to work, otherwise flip. Declares stuck after a fruitless lap of the stock. */
  function botIntent(s: GameState, seat: number, idle: number): Intent {
    const p = s.players.find((q) => q.seat === seat)!;
    const done = s.slots.findIndex((pile) => completedBy(pile) === seat);
    if (done >= 0) return { k: 'clear', slot: done };
    if (p.nertz.length === 0) return NERTZ;
    const legal = legalMoves(s, seat).filter((m) => m.k === 'move');
    const from = (m: Intent) => (m.k === 'move' ? grab(s, seat, m.cardId)!.from.k : 'work');
    const to = (m: Intent) => (m.k === 'move' ? m.to.k : 'work');
    /** Lifts the whole face-up part of a work pile that still has face-down cards under it. */
    const uncovers = (m: Intent): boolean => {
      const g = m.k === 'move' ? grab(s, seat, m.cardId)! : null;
      return g?.from.k === 'work' && p.work[g.from.i]!.down > 0 && p.work[g.from.i]!.cards.length - g.cards.length === p.work[g.from.i]!.down;
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
    // Deals until four have been played out to a call: not every deal is.
    untilReached({ called: 4 }, 10, (rng, reached) => {
      const seats = [0, 1, 2, 3];
      let state = inPlay(seats, rng);
      const idle = new Map(seats.map((s) => [s, 0]));
      for (let step = 0; step < 4000 && isLive(state); step++) {
        const seat = seats[Math.floor(rng() * seats.length)]!;
        const intent = botIntent(state, seat, idle.get(seat)!);
        const r = applyIntent(state, seat, intent);
        if (!r.ok) throw new Error(`bot move rejected at step ${step}: ${JSON.stringify(intent)} (${r.reason})`);
        idle.set(seat, intent.k === 'move' ? 0 : idle.get(seat)! + 1);
        state = resolveStuck(r.state, seats);
        if (state !== r.state) seats.forEach((s) => idle.set(s, 0));
        expect(checkInvariants(state)).toBeNull();
      }
      if (calledBy(state) === null) return; // (jammed: a played-out deal takes a few hundred intents, rarely two thousand)
      reached('called');
      expect(isOver(state)).toBe(true); // nobody was holding anything
      const scores = scoreRound(state);
      const caller = scores.find((x) => x.seat === calledBy(state))!;
      expect(caller.nertzLeft).toBe(0);
      expect(caller.delta).toBe(caller.played);
      for (const x of scores) expect(x.delta).toBe(x.played - 2 * x.nertzLeft);
      expect(scores.reduce((n, x) => n + x.played, 0)).toBe(inSlots(state).length + state.tray.flat().length);
    });
  }, FUZZ_MS);
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
  expect(predicted.status).toEqual(truth.status);
  expect(inGrace(predicted)).toEqual(inGrace(truth));
  expect(predicted.slots).toEqual(truth.slots);
  expect(predicted.tray).toEqual(truth.tray);
  expect(predicted.players).toHaveLength(truth.players.length);
  for (const [i, real] of truth.players.entries()) {
    const pred = predicted.players[i]!;
    expect(pred.seat).toBe(real.seat);
    expect(pred.stuck).toBe(real.stuck);
    expect(pred.holding).toBe(real.holding);
    expect(downs(pred)).toEqual(downs(real));
    expect(pred.dealt).toBe(real.dealt);
    const piles = (p: PlayerState) => [p.nertz, p.stock, p.waste, ...p.work.map((w) => w.cards)];
    const realPiles = piles(real);
    for (const [j, pile] of piles(pred).entries()) {
      expect(ids(pile)).toEqual(ids(realPiles[j]!));
      for (const [k, card] of pile.entries()) if (!isHidden(card)) expect(card).toEqual(realPiles[j]![k]);
    }
  }
}

/** Cards lying face-up in a fresh view, their faces showing, but still hidden in the prediction: the "newly revealed" ones. */
const unrevealed = (predicted: GameState, freshView: GameState): number => {
  const lyingUp = [
    ...freshView.slots.flatMap((pile) => pile?.cards ?? []),
    ...freshView.tray.flat(),
    ...freshView.players.flatMap((p) => [...p.nertz.slice(-1), ...p.work.flatMap((w) => w.cards.slice(w.down)), ...p.waste.slice(0, p.waste.length - p.dealt)]),
  ];
  const shown = new Set(lyingUp.filter((x) => !isHidden(x)).map((x) => x.id));
  return allCards(predicted).filter((x) => isHidden(x) && shown.has(x.id)).length;
};

describe('client prediction on a redacted view agrees with the server', () => {
  it('single intents, grace included: same verdict, same visible result, at most the newly revealed cards unknown', () => {
    untilReached(['grace'], 12, (rng, reached) => {
      const seats = [0, 1, 2];
      let state = shortDeal(seats, rng);
      for (let step = 0; step < INTENTS; step++) {
        const seat = seats[Math.floor(rng() * seats.length)]!;
        const view = deepFreeze(viewFor(state, seat));
        const intent = randomIntent(view, seat, rng, MIXES.wild);
        const onView = applyIntent(view, seat, intent);
        const onTruth = applyIntent(state, seat, intent);
        expect(onView.ok, `step ${step} ${JSON.stringify(intent)}`).toBe(onTruth.ok);
        if (onView.ok && onTruth.ok) {
          if (calledBy(state) !== null) reached('grace');
          expectPredictionMatches(onView.state, onTruth.state);
          const revealed = unrevealed(onView.state, viewFor(onTruth.state, seat));
          // A flip and a move off a work pile turn up only cards the player was sent already: at most the card
          // under a nertz top is left to come with the snapshot.
          expect(revealed).toBeLessThanOrEqual(intent.k === 'move' ? 1 : 0);
          // (Except a call that ends the round at once: the faces sent early stay, face-down, until the snapshot takes them back.)
          if (intent.k !== 'move' && intent.k !== 'flip' && !isOver(onTruth.state)) expect(onView.state).toEqual(viewFor(onTruth.state, seat));
          state = resolveStuck(onTruth.state, seats);
        }
        if (calledBy(state) !== null && rng() < 0.1) state = expireGrace(state);
        if (isOver(state)) state = shortDeal(seats, rng);
      }
    });
  }, FUZZ_MS);

  it('chains of unacknowledged intents: whatever the client accepts, the server accepts identically', () => {
    // Seeds until a whole chain of several has been predicted, and a chain has run into a card the client could not see.
    untilReached(['whole chain', 'resync'], 60, /* (a resync needs two cards played off one pile in a chain now) */ (rng, reached) => {
      const seats = [0, 1];
      let state = inPlay(seats, rng);
      let diverged = 0;
      for (let round = 0; round < CHAINS; round++) {
        const seat = seats[Math.floor(rng() * seats.length)]!;
        let predicted = viewFor(state, seat);
        const length = 1 + Math.floor(rng() * 6);
        let predictedAll = 0;
        for (let n = 0; n < length; n++) {
          const intent = randomIntent(predicted, seat, rng, MIXES.wild);
          const onView = applyIntent(predicted, seat, intent);
          const onTruth = applyIntent(state, seat, intent);
          if (onTruth.ok) state = onTruth.state;
          if (onView.ok) {
            // The client never predicts something the server then refuses (absent other players' moves).
            expect(onTruth.ok, `round ${round} ${JSON.stringify(intent)}`).toBe(true);
            predicted = onView.state;
            if (++predictedAll === length && length >= 3) reached('whole chain');
            expectPredictionMatches(predicted, state);
            expect(checkInvariants(predicted)).toBeNull(); // including a just-uncovered work card whose face is not known yet
          } else if (onTruth.ok) {
            // Only possible when the move involved a card the client could not see yet; it resyncs from the snapshot.
            diverged++;
            reached('resync');
            break;
          }
        }
        if (calledBy(state) !== null) state = inPlay(seats, rng);
      }
      expect(diverged).toBeLessThan(CHAINS / 3);
    });
  }, FUZZ_MS);

  it('a lost race simply drops the pending intent when replayed over the newer snapshot', () => {
    const s = table([{ nertz: 'S9 H2' }, { nertz: 'D9 H2' }], { slots: [pile('HA', 0), pile('HA', 1)] });
    const pending = move('1:H2', slot(0));
    // seat 1 predicts its own move locally
    const predicted = ok(applyIntent(viewFor(s, 1), 1, pending));
    expect(predicted.slots[0]!.cards).toHaveLength(2);
    // but the server processed seat 0 first; seat 1's intent is rejected there...
    const server = ok(applyIntent(s, 0, move('0:H2', slot(0))));
    rejected(applyIntent(server, 1, pending));
    // ...and replaying it over the new snapshot fails the same way, so the card just goes home (not to the other ace)
    rejected(applyIntent(viewFor(server, 1), 1, pending));
    expect(ids(viewFor(server, 1).players[1]!.nertz)).toEqual(['1:D9', '1:H2']);
    expect(viewFor(server, 1).slots[1]!.cards).toHaveLength(1);
  });
});

