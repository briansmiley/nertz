// The table through the room: the host's choice of how the middle works, a
// race for the same patch of felt, the relay of card positions while a card is
// being dragged, and bots playing whole rounds on both kinds of table.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkInvariants, feltFree, viewFor, type Rng } from '../shared/engine';
import { DEAL_MS, START_MS, DRAG_BURST, DRAG_HZ, DRAG_RATE, type DragAt, type ServerMsg } from '../shared/protocol';
import { openPlace, seatDir, spots, type Spot, type TableMode } from '../shared/table';
import type { Card, GameState, Intent, PileRef } from '../shared/types';
import { chooseIntent, freshMemory } from './bot';
import { Room, type Conn } from './room';

function seeded(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type StateMsg = Extract<ServerMsg, { t: 'state' }>;
type DragMsg = Extract<ServerMsg, { t: 'drag' }>;

/** A connection that records what it was sent, as it would arrive over the wire. */
class FakeConn implements Conn {
  states: StateMsg[] = [];
  drags: DragMsg[] = [];
  send(msg: ServerMsg): void {
    const copy = JSON.parse(JSON.stringify(msg)) as ServerMsg;
    if (copy.t === 'state') this.states.push(copy);
    if (copy.t === 'drag') this.drags.push(copy);
  }
  close(): void {}
  get room() {
    return this.states.at(-1)!.room;
  }
}

/** A room that only flushes when the test says so, with `n` people in it. */
function roomWith(n: number, seed = 1): { room: Room; conns: FakeConn[] } {
  const room = new Room('TEST', { rng: seeded(seed), schedule: () => {} });
  const conns = Array.from({ length: n }, (_, i) => {
    const conn = new FakeConn();
    expect(room.join(conn, `P${i}`, `tok-000${i}`)).toBeNull();
    return conn;
  });
  return { room, conns };
}

/** Deals, sits through the deal, presses Start and sits through "1, 2, 3": play is open (fake timers must be on). */
function start(room: Room, dealer: Conn): void {
  room.handle(dealer, { t: 'start' });
  vi.advanceTimersByTime(DEAL_MS);
  room.handle(dealer, { t: 'go' });
  vi.advanceTimersByTime(START_MS);
  expect(room.game!.stage).toBe('play');
}

/** Every player gets an Ace from their stock face-up on their waste, ready to play. Returns the Aces' ids by seat. */
function acesUp(room: Room): string[] {
  const game = room.game!;
  const aces = game.players.map((p) => (p.stock as Card[]).find((c) => c.rank === 1)!);
  room.game = { ...game, players: game.players.map((p, i) => ({ ...p, stock: p.stock.filter((c) => c !== aces[i]), waste: [aces[i]!] })) };
  expect(checkInvariants(room.game)).toBeNull();
  return aces.map((c) => c.id);
}

const move = (cardId: string, to: PileRef): Intent => ({ k: 'move', cardId, count: 1, to });
const felt = (x: number, y: number): PileRef => ({ k: 'felt', x, y });
const at = (id: string, w = 0.5): { t: 'drag' } & DragAt => ({ t: 'drag', id, w, h: [1, 2], p: [0.1, 0.6] });

afterEach(() => void vi.useRealTimers());

describe('the host chooses how the middle works', () => {
  it('spots by default; "free" applies from the next deal, and a round keeps the table it was dealt', () => {
    vi.useFakeTimers();
    const { room, conns } = roomWith(2);
    const host = conns[0]!;
    start(room, host);
    expect(room.game!.table).toBe('spots');
    expect(room.game!.places).toEqual(spots(2));
    // Mid-round the setting stands still, like every table rule.
    room.handle(host, { t: 'settings', patch: { centre: 'free' } });
    expect(room.settings.centre).toBe('spots');

    const next = roomWith(3);
    room.close();
    const [h2, g2] = next.conns as [FakeConn, FakeConn, FakeConn];
    next.room.handle(g2, { t: 'settings', patch: { centre: 'free' } }); // not the host: ignored
    expect(next.room.settings.centre).toBe('spots');
    next.room.handle(h2, { t: 'settings', patch: { centre: 'free' } });
    next.room.flush();
    expect(g2.room.settings).toEqual({ fewerDown: true, stockDeal: 'drag', centre: 'free' });
    start(next.room, h2);
    next.room.flush();
    expect(next.room.game!.table).toBe('free');
    expect(g2.room.game!.table).toBe('free');
    expect(g2.room.game!.places).toEqual(Array.from({ length: 12 }, () => null));
    next.room.close();
  });

  it('on a free table two Aces for the same patch of felt are two messages: the first lands, the second goes home', () => {
    vi.useFakeTimers();
    const { room, conns } = roomWith(3);
    const [a, b, c] = conns as [FakeConn, FakeConn, FakeConn];
    room.handle(a, { t: 'settings', patch: { centre: 'free' } });
    start(room, a);
    const [aceA, aceB, aceC] = acesUp(room) as [string, string, string];
    room.handle(a, { t: 'intent', seq: 1, intent: { k: 'hold', cardId: aceA } });
    room.handle(b, { t: 'intent', seq: 1, intent: { k: 'hold', cardId: aceB } });
    // Both aimed at bare felt; B's message arrives first.
    room.handle(b, { t: 'intent', seq: 2, intent: move(aceB, felt(0.2, 0.1)) });
    room.handle(a, { t: 'intent', seq: 2, intent: move(aceA, felt(0.22, 0.12)) });
    room.flush();
    const game = room.game!;
    expect(game.slots.map((s) => s.map((x) => x.id))[0]).toEqual([aceB]);
    expect(game.slots.filter((s) => s.length > 0)).toHaveLength(1);
    expect(game.places[0]).toMatchObject({ x: 0.2, y: 0.1 });
    expect(game.players[0]!.waste.map((x) => x.id)).toEqual([aceA]); // back where it came from
    expect(game.players[0]!.holding).toBeNull(); // and out of the hand
    expect(a.states.at(-1)!.ack).toBe(2); // the refusal is an answer too
    // Everyone is shown the one pile, at the same point of the table.
    for (const conn of [a, b, c]) expect(conn.room.game!.places[0]).toMatchObject({ x: 0.2, y: 0.1 });
    // A is free to put it somewhere else, and C beside that.
    room.handle(a, { t: 'intent', seq: 3, intent: move(aceA, felt(-0.5, 0)) });
    room.handle(c, { t: 'intent', seq: 1, intent: move(aceC, felt(0, -0.6)) });
    expect(room.game!.slots.filter((s) => s.length > 0)).toHaveLength(3);
    expect(checkInvariants(room.game!)).toBeNull();
    room.close();
  });
});

describe('card positions while dragging', () => {
  function dragging(n = 3) {
    vi.useFakeTimers();
    const { room, conns } = roomWith(n);
    start(room, conns[0]!);
    const held = room.game!.players[0]!.nertz.at(-1)!.id;
    room.handle(conns[0]!, { t: 'intent', seq: 1, intent: { k: 'hold', cardId: held } });
    room.flush();
    return { room, conns, held };
  }

  it('are forwarded to everyone else with the seat stamped on, and to nobody else', () => {
    const { room, conns, held } = dragging();
    const [a, b, c] = conns as [FakeConn, FakeConn, FakeConn];
    room.handle(a, at(held, 0.25));
    expect(a.drags).toEqual([]); // never echoed
    expect(b.drags).toEqual([{ t: 'drag', seat: 0, id: held, w: 0.25, h: [1, 2], p: [0.1, 0.6] }]);
    expect(c.drags).toEqual(b.drags);
    // Someone whose connection is gone is sent nothing, and misses nothing: the next snapshot has the card where it is.
    room.disconnect(c);
    room.handle(a, at(held, 0.5));
    expect(b.drags).toHaveLength(2);
    expect(c.drags).toHaveLength(1);
    room.close();
  });

  it('are not part of the game: nothing is stored, no snapshot is sent, and none carries a position', () => {
    const { room, conns, held } = dragging();
    const [a, b] = conns as [FakeConn, FakeConn];
    const before = { game: room.game, rev: room.rev, sent: [a.states.length, b.states.length] };
    for (let i = 0; i < 5; i++) room.handle(a, at(held, i / 5));
    room.flush();
    expect(room.game).toBe(before.game);
    expect(room.rev).toBe(before.rev);
    expect([a.states.length, b.states.length]).toEqual(before.sent);
    // The card has not moved as far as the rules know: it is still on its pile, and held.
    expect(room.game!.players[0]!.nertz.at(-1)!.id).toBe(held);
    expect(room.game!.players[0]!.holding).toBe(held);
    room.handle(b, { t: 'intent', seq: 1, intent: { k: 'flip' } });
    room.flush();
    expect(JSON.stringify(b.states.at(-1))).not.toMatch(/"t":"drag"|"w":|"p":\[/); // (the table rule `stockDeal: 'drag'` is in there, and is not a position)
    room.close();
  });

  it('are forwarded only for the card the game says that player is holding', () => {
    const { room, conns, held } = dragging();
    const [a, b] = conns as [FakeConn, FakeConn];
    const other = room.game!.players[1]!.nertz.at(-1)!.id;
    room.handle(a, at(other)); // somebody else's card
    room.handle(a, at('nonsense'));
    room.handle(b, at(other)); // B has not picked anything up
    expect(a.drags.length + b.drags.length).toBe(0);
    room.handle(a, at(held));
    expect(b.drags).toHaveLength(1);
    // Put down again: later reports (late ones, or made up) go nowhere.
    room.handle(a, { t: 'intent', seq: 2, intent: { k: 'release' } });
    room.handle(a, at(held));
    expect(b.drags).toHaveLength(1);
    // A hold that was refused (a card that cannot be picked up) is not a hold.
    const buried = room.game!.players[0]!.nertz[0]!.id;
    room.handle(a, { t: 'intent', seq: 3, intent: { k: 'hold', cardId: buried } });
    room.handle(a, at(buried));
    expect(b.drags).toHaveLength(1);
    room.close();
  });

  it('stop when the dragging player disconnects: the card is out of their hand for everyone', () => {
    const { room, conns, held } = dragging();
    const [a, b] = conns as [FakeConn, FakeConn];
    room.handle(a, at(held));
    room.disconnect(a);
    room.flush();
    expect(b.room.game!.players[0]!.holding).toBeNull(); // the snapshot that sends the card home
    room.handle(a, at(held)); // a dead connection is not listened to
    const again = new FakeConn();
    room.join(again, 'P0', 'tok-0000');
    room.handle(again, at(held)); // and the new one is not holding anything
    expect(b.drags).toHaveLength(1);
    room.close();
  });

  it('nothing is forwarded in the lobby, during the deal, before play opens, or once the round is over', () => {
    vi.useFakeTimers();
    const { room, conns } = roomWith(2);
    const [a, b] = conns as [FakeConn, FakeConn];
    room.handle(a, at('x'));
    room.handle(a, { t: 'start' });
    const card = room.game!.players[0]!.nertz.at(-1)!.id;
    room.handle(a, { t: 'intent', seq: 1, intent: { k: 'hold', cardId: card } }); // refused: still dealing
    room.handle(a, at(card));
    expect(b.drags).toEqual([]);
    vi.advanceTimersByTime(DEAL_MS);
    // Dealt, waiting for the dealer, and through the count: still nothing can be picked up, so nothing is forwarded.
    room.handle(a, { t: 'intent', seq: 2, intent: { k: 'hold', cardId: card } });
    room.handle(a, at(card));
    room.handle(a, { t: 'go' });
    room.handle(a, { t: 'intent', seq: 3, intent: { k: 'hold', cardId: card } });
    room.handle(a, at(card));
    expect(room.game!.stage).toBe('countdown');
    expect(b.drags).toEqual([]);
    vi.advanceTimersByTime(START_MS);
    // B goes out and calls; A was not holding anything, so the round is over at once.
    const game = room.game!;
    room.game = { ...game, players: game.players.map((p) => (p.seat === 1 ? { ...p, nertz: [], stock: [...p.nertz, ...p.stock] } : p)) };
    room.handle(b, { t: 'intent', seq: 1, intent: { k: 'nertz' } });
    expect(room.phase).toBe('results');
    room.handle(a, at(card));
    expect(b.drags).toEqual([]);
    room.close();
  });

  it('are rate-limited per player: a client at the normal rate is never cut, a flood is', () => {
    const { room, conns, held } = dragging();
    const [a, b] = conns as [FakeConn, FakeConn];
    // The normal rate, for five seconds: every report gets through.
    const reports = DRAG_HZ * 5;
    for (let i = 0; i < reports; i++) {
      vi.advanceTimersByTime(1000 / DRAG_HZ);
      room.handle(a, at(held));
    }
    expect(b.drags).toHaveLength(reports);
    // A burst in one instant: only what the bucket holds.
    b.drags = [];
    vi.advanceTimersByTime(2000);
    for (let i = 0; i < 200; i++) room.handle(a, at(held));
    expect(b.drags).toHaveLength(DRAG_BURST);
    // A sustained flood of 200 a second for five seconds: DRAG_RATE a second get through.
    b.drags = [];
    for (let ms = 0; ms < 5000; ms += 5) {
      vi.advanceTimersByTime(5);
      room.handle(a, at(held));
    }
    expect(b.drags.length).toBeGreaterThan(DRAG_RATE * 5 - 5);
    expect(b.drags.length).toBeLessThanOrEqual(DRAG_RATE * 5 + DRAG_BURST);
    // The flood cost nobody else anything: B's own reports are counted separately.
    const mine = room.game!.players[1]!.nertz.at(-1)!.id;
    room.handle(b, { t: 'intent', seq: 1, intent: { k: 'hold', cardId: mine } });
    room.handle(b, at(mine));
    expect(a.drags).toHaveLength(1);
    room.close();
  });
});

describe('bots on a table without fixed places', () => {
  /** A free two-seat table where seat `seat` has an Ace on its waste. */
  function withAce(n: number, seat: number, seed = 3): { view: GameState; ace: string } {
    vi.useFakeTimers();
    const { room, conns } = roomWith(n, seed);
    room.handle(conns[0]!, { t: 'settings', patch: { centre: 'free' } });
    start(room, conns[0]!);
    const ace = acesUp(room)[seat]!;
    const view = viewFor(room.game!, seat);
    room.close();
    return { view, ace };
  }
  /** The same table with nothing for that seat to think about but its waste card: Kings everywhere else, which go nowhere. */
  const wasteOnly = (view: GameState, seat: number): GameState => {
    const king = (id: string): Card => ({ id, owner: seat, suit: 'S', rank: 13 });
    return { ...view, players: view.players.map((p) => (p.seat === seat ? { ...p, nertz: [king('n')], work: [[king('w0')], [king('w1')], [king('w2')], [king('w3')]], down: [0, 0, 0, 0] } : p)) };
  };

  it('starts its piles on its own side of the felt, somewhere legal, and differently each time', () => {
    for (const n of [2, 4, 6]) {
      for (let seat = 0; seat < n; seat++) {
        const { view, ace } = withAce(n, seat, 3 + n);
        const table = wasteOnly(view, seat);
        const side = seatDir(seat, n);
        const picks = new Set<string>();
        let towards = 0;
        for (let seed = 1; seed <= 30; seed++) {
          const choice = chooseIntent(table, seat, freshMemory(), seeded(seed));
          const intent = choice!.intent as Extract<Intent, { k: 'move' }>;
          expect(intent).toMatchObject({ k: 'move', cardId: ace, count: 1, to: { k: 'felt' } });
          const to = intent.to as Extract<PileRef, { k: 'felt' }>;
          expect(feltFree(table, to)).toBe(true);
          if (to.x * side.x + to.y * side.y > 0) towards++;
          picks.add(`${to.x},${to.y}`);
        }
        expect(picks.size).toBeGreaterThan(10);
        expect(towards).toBeGreaterThan(20); // mostly in its own half
      }
    }
  });

  it('finds the last free patch of a crowded table, and does not try when there is none', () => {
    const { view, ace } = withAce(2, 0);
    // Six piles already lie where the bot would like to put its own: crowded round its side of the table.
    const taken: Spot[] = [];
    const side = seatDir(0, 2);
    for (let i = 0; i < 6; i++) taken.push({ ...openPlace(taken, 2, 'free', { x: side.x * 0.5, y: side.y * 0.5 })!, r: 0 });
    expect(taken).toHaveLength(6);
    const pile = (i: number): Card[] => [{ id: `pile${i}`, owner: 1, suit: 'D', rank: 1 }];
    const crowded = wasteOnly({ ...view, slots: view.slots.map((s, i) => (i < 6 ? pile(i) : s)), places: view.places.map((p, i) => (i < 6 ? taken[i]! : p)) }, 0);
    for (let seed = 1; seed <= 10; seed++) {
      const intent = chooseIntent(crowded, 0, freshMemory(), seeded(seed))!.intent;
      expect(intent).toMatchObject({ k: 'move', cardId: ace });
      expect(feltFree(crowded, (intent as Extract<Intent, { k: 'move' }>).to as { x: number; y: number })).toBe(true);
    }
    // All eight slots in use: the Ace has nowhere to go, so the bot does something else (here: flips).
    const full = { ...crowded, slots: crowded.slots.map((s, i) => (s.length ? s : pile(i))), places: crowded.places.map((p, i) => p ?? { x: -0.8 + 0.01 * i, y: 0, r: 0 }) };
    expect(chooseIntent(full, 0, freshMemory(), seeded(1))!.intent).toEqual({ k: 'flip' });
  });

  for (const centre of ['spots', 'free'] as TableMode[]) {
    it(`tables of 2 to 6 bots play rounds out on a table with ${centre === 'free' ? 'no fixed places' : 'spots'}, every pile in a legal place throughout`, () => {
      vi.useFakeTimers();
      let finished = 0;
      let dealt = 0;
      let aces = 0;
      for (const bots of [2, 3, 4, 5, 6]) {
        for (const seed of [21, 22, 23]) {
          const room = new Room('TEST', { rng: seeded(seed * 10 + bots), schedule: () => {} });
          const host = new FakeConn();
          room.join(host, 'Ann', 'tok-host');
          room.handle(host, { t: 'settings', patch: { centre } });
          for (let i = 0; i < bots && i < 5; i++) room.handle(host, { t: 'addBot', level: 'fast' });
          const players = Math.min(6, bots + 1);
          start(room, host);
          room.disconnect(host); // the person is away: the bots' stuck votes are the only ones
          dealt++;
          const t0 = Date.now();
          let most = 0;
          while (room.phase === 'playing' && Date.now() - t0 < 20 * 60_000) {
            vi.advanceTimersToNextTimer();
            const game = room.game!;
            const problem = checkInvariants(game);
            if (problem) throw new Error(`${players} players, seed ${seed}: ${problem}`);
            expect(game.table).toBe(centre);
            most = Math.max(most, game.slots.filter((s) => s.length > 0).length);
          }
          aces += most;
          expect(most).toBeGreaterThan(players); // piles were started, on either kind of table
          expect(most).toBeLessThanOrEqual(4 * players);
          if (room.phase === 'results') finished++;
          room.close();
        }
      }
      // Not every deal is played out: small tables of this simple bot jam (see the README). Most are, on either table.
      expect(finished).toBeGreaterThanOrEqual(Math.ceil(dealt * 0.5));
      expect(aces).toBeGreaterThan(dealt * 6);
    }, 60_000);
  }
});
