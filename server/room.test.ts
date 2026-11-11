import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { checkInvariants, deal as dealRound, finishDeal, grab, isComplete, legalDrops, viewFor, type Rng } from '../shared/engine';
import { DEAL_MS, GRACE_MS, isRoomCode, MAX_MESSAGE_BYTES, MAX_PLAYERS, type ServerMsg } from '../shared/protocol';
import type { Card, GameState, Intent, PileRef, Suit } from '../shared/types';
import { CLOSE_FLOOD, CLOSE_REPLACED, startServer, type NertzServer } from './index';
import { Room, type Conn } from './room';

type StateMsg = Extract<ServerMsg, { t: 'state' }>;

// ---------------------------------------------------------------- helpers

/** A round in play: dealt, and the deal over. (The deal itself has its own tests.) */
const deal = (seats: readonly number[], rng: () => number): GameState => finishDeal(dealRound(seats, rng));

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

const wire = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** A connection that records what it was sent, as it would arrive over the wire. */
class FakeConn implements Conn {
  sent: StateMsg[] = [];
  closed = false;
  send(msg: ServerMsg): void {
    if (msg.t === 'state') this.sent.push(wire(msg));
  }
  close(): void {
    this.closed = true;
  }
  get last(): StateMsg {
    return this.sent.at(-1)!;
  }
}

/** A room that only flushes when the test says so, with `n` players joined (tokens tok-0000, tok-0001, ...). */
function roomWith(n: number, seed = 1): { room: Room; conns: FakeConn[] } {
  const room = new Room('TEST', { rng: seeded(seed), schedule: () => {} });
  const conns = Array.from({ length: n }, (_, i) => {
    const conn = new FakeConn();
    expect(room.join(conn, `P${i}`, `tok-000${i}`)).toBeNull();
    return conn;
  });
  return { room, conns };
}

/** Starts a round and sits through the deal: play is open, and no timer is left running. */
function startRound(room: Room, dealer: Conn): void {
  const faked = vi.isFakeTimers();
  if (!faked) vi.useFakeTimers();
  room.handle(dealer, { t: 'start' });
  vi.advanceTimersByTime(DEAL_MS);
  if (!faked) vi.useRealTimers();
}

const move = (cardId: string, to: PileRef, count = 1): Intent => ({ k: 'move', cardId, count, to });
const slot = (i: number): PileRef => ({ k: 'slot', i });
const hold = (cardId: string): Intent => ({ k: 'hold', cardId });
const sendIntent = (room: Room, conn: Conn, seq: number, intent: Intent) => room.handle(conn, { t: 'intent', seq, intent });

/**
 * A deal where every player's work piles are single face-up cards: A-spades,
 * 2-spades, A-hearts and 5-diamonds (the 5 has nowhere legal to go).
 */
function rigged(seats: number[], emptyNertzFor: number[] = []): GameState {
  const g = deal(seats, seeded(7));
  return {
    ...g,
    players: g.players.map((p) => {
      const cards = [...p.nertz, ...p.work.flat(), ...p.stock] as Card[];
      const take = (suit: Suit, rank: number) => cards.splice(cards.findIndex((c) => c.suit === suit && c.rank === rank), 1)[0]!;
      const work = [[take('S', 1)], [take('S', 2)], [take('H', 1)], [take('D', 5)]];
      const nertz = emptyNertzFor.includes(p.seat) ? [] : cards.splice(0, 13);
      return { ...p, work, down: [0, 0, 0, 0], nertz, stock: cards, waste: [] };
    }),
  };
}
const workTop = (g: GameState, seat: number, i: number) => g.players.find((p) => p.seat === seat)!.work[i]!.at(-1)!.id;
const filled = (g: GameState) => g.slots.map((pile) => pile.map((c) => c.id)).filter((pile) => pile.length > 0);

/** What a bot does next, given its (possibly stale) view: a mix of legal moves, drags, flips, wrong moves and nonsense. */
function botIntent(view: GameState, seat: number, rnd: Rng): Intent {
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
  const me = view.players.find((p) => p.seat === seat)!;
  const mine = [...me.nertz.slice(-1), ...me.waste.slice(-1), ...me.work.flat()];
  const roll = rnd();
  if (roll < 0.45) {
    const legal = mine.flatMap((c) => legalDrops(view, seat, c.id).map((to) => move(c.id, to, grab(view, seat, c.id)!.cards.length)));
    // Prefer the middle so the shared piles are genuinely contended.
    const toCentre = legal.filter((m) => m.k === 'move' && m.to.k === 'slot');
    if (legal.length > 0) return pick(toCentre.length > 0 && rnd() < 0.8 ? toCentre : legal);
    return { k: 'flip' };
  }
  if (roll < 0.65) return { k: 'flip' };
  if (roll < 0.7) return { k: 'stuck', on: rnd() < 0.5 };
  if (roll < 0.72) return me.nertz.length > 0 ? { k: 'nertz' } : { k: 'flip' };
  if (roll < 0.8) return mine.length > 0 ? hold(pick(mine).id) : { k: 'release' };
  if (roll < 0.85) return { k: 'release' };
  if (roll < 0.9) {
    const full = view.slots.flatMap((pile, i) => (isComplete(pile) ? [i] : []));
    return { k: 'clear', slot: full.length > 0 ? pick(full) : Math.floor(rnd() * 24) };
  }
  // Anyone's card, anywhere, to anywhere: almost always illegal.
  const everything = [...view.players.flatMap((p) => [...p.nertz, ...p.waste, ...p.stock, ...p.work.flat()]), ...view.slots.flat(), ...view.tray.flat()];
  const targets: PileRef[] = [...[0, 1, 2, 3].map((i): PileRef => ({ k: 'work', i })), ...view.slots.map((_, i) => slot(i)), slot(23)];
  return move(rnd() < 0.1 ? 'no-such-card' : pick(everything).id, pick(targets));
}

// ---------------------------------------------------------------- Room, driven directly

describe('Room', () => {
  afterEach(() => void vi.useRealTimers());

  it('seats players, makes the first one host and starts only for the host with enough players', () => {
    const { room, conns } = roomWith(1);
    room.handle(conns[0]!, { t: 'start' });
    expect(room.phase).toBe('lobby'); // one player is not enough
    const b = new FakeConn();
    room.join(b, 'Bea', 'tok-bbbb');
    room.handle(b, { t: 'start' });
    expect(room.phase).toBe('lobby'); // not the host
    room.handle(conns[0]!, { t: 'start' });
    room.flush();
    expect(room.phase).toBe('playing');
    const view = b.last.room;
    expect(view).toMatchObject({ code: 'TEST', phase: 'playing', round: 1, you: 1 });
    expect(view.players.map((p) => [p.seat, p.name, p.isHost, p.connected])).toEqual([[0, 'P0', true, true], [1, 'Bea', false, true]]);
    expect(view.game).toEqual(wire(viewFor(room.game!, 1)));
    expect(checkInvariants(room.game!)).toBeNull();
    expect(JSON.stringify(b.sent) + JSON.stringify(conns[0]!.sent)).not.toMatch(/tok-/);
  });

  it('refuses a seventh player', () => {
    const { room } = roomWith(MAX_PLAYERS);
    expect(room.join(new FakeConn(), 'Late', 'tok-late')).toMatch(/full/);
  });

  // Regression: someone who pressed Leave on the score sheet still counted towards the six seats until the next deal.
  it('gives the seat of a player who left after the round to a newcomer, and keeps their line on the score sheet', () => {
    const { room, conns } = roomWith(MAX_PLAYERS);
    room.handle(conns[0]!, { t: 'start' });
    room.game = rigged([0, 1, 2, 3, 4, 5], [0]);
    sendIntent(room, conns[0]!, 0, { k: 'nertz' });
    expect(room.phase).toBe('results');
    expect(room.join(new FakeConn(), 'Early', 'tok-early')).toMatch(/full/); // six people are still here

    room.handle(conns[5]!, { t: 'leave' });
    room.flush();
    expect(conns[0]!.last.room.players.map((p) => [p.name, p.connected])).toContainEqual(['P5', false]); // still listed
    const late = new FakeConn();
    expect(room.join(late, 'Late', 'tok-late')).toBeNull();
    room.flush();
    expect(late.last.room.players.map((p) => p.name)).toEqual(['P0', 'P1', 'P2', 'P3', 'P4', 'Late']);
    expect(late.last.room.you).toBe(5); // the only free seat (and back colour) is the leaver's
    // The round that was played is still P5's: name and total travel with the score line.
    expect(late.last.room.lastRound!.scores[5]).toMatchObject({ seat: 5, name: 'P5', delta: -26, total: -26 });
    expect(late.last.room.players[5]!.score).toBe(0);
    expect(room.join(new FakeConn(), 'Later', 'tok-later')).toMatch(/full/);

    room.handle(conns[0]!, { t: 'start' });
    expect(room.game!.players.map((p) => p.seat)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(checkInvariants(room.game!)).toBeNull();
  });

  it('coalesces a burst into one snapshot per player, and tells only the sender about a rejection', () => {
    const { room, conns } = roomWith(2);
    const [a, b] = conns as [FakeConn, FakeConn];
    startRound(room, a);
    room.flush();
    const [sentA, sentB, rev] = [a.sent.length, b.sent.length, room.rev];

    for (let seq = 0; seq < 5; seq++) sendIntent(room, a, seq, { k: 'flip' });
    room.flush();
    expect(a.sent.length).toBe(sentA + 1);
    expect(b.sent.length).toBe(sentB + 1);
    expect(a.last).toMatchObject({ ack: 4, rev: rev + 5 });
    expect(b.last).toMatchObject({ ack: -1, rev: rev + 5 });
    expect(a.last.room.game!.players[0]!.waste.length).toBe(15);

    const before = room.game;
    sendIntent(room, a, 5, move('no-such-card', { k: 'work', i: 0 }));
    sendIntent(room, a, 5, { k: 'flip' }); // replayed seq: ignored
    sendIntent(room, a, 3, { k: 'flip' }); // stale seq: ignored
    room.flush();
    expect(room.game).toBe(before);
    expect(a.sent.length).toBe(sentA + 2);
    expect(a.last).toMatchObject({ ack: 5, rev: rev + 6 });
    expect(b.sent.length).toBe(sentB + 1); // nothing changed for b
  });

  it('linearises a race for one pile: first arrival lands, the loser is rejected and its card stays put', () => {
    const { room, conns } = roomWith(2);
    const [a, b] = conns as [FakeConn, FakeConn];
    room.handle(a, { t: 'start' });
    room.game = rigged([0, 1]);
    const [aceA, aceB] = [workTop(room.game, 0, 0), workTop(room.game, 1, 0)];
    sendIntent(room, a, 0, move(aceA, slot(2)));
    sendIntent(room, b, 0, move(aceB, slot(5)));
    // Both players aim their 2 of spades at a's ace before either has heard about the other.
    const [twoA, twoB] = [workTop(room.game, 0, 1), workTop(room.game, 1, 1)];
    sendIntent(room, b, 1, move(twoB, slot(2)));
    sendIntent(room, a, 1, move(twoA, slot(2)));
    room.flush();
    // No fallback: a's 2 would fit b's ace in slot 5, but it was dropped on slot 2, so it goes home.
    expect(room.game.slots[2]!.map((c) => c.id)).toEqual([aceA, twoB]);
    expect(room.game.slots[5]!.map((c) => c.id)).toEqual([aceB]);
    expect(filled(room.game)).toHaveLength(2);
    expect(workTop(room.game, 0, 1)).toBe(twoA); // a's card never left its pile
    expect(a.last.ack).toBe(1);
    expect(b.last.ack).toBe(1);
    expect(a.last.room.game).toEqual(b.last.room.game);
    expect(checkInvariants(room.game)).toBeNull();
  });

  it('linearises two aces racing for one empty slot: first wins, the other returns', () => {
    const { room, conns } = roomWith(2);
    const [a, b] = conns as [FakeConn, FakeConn];
    room.handle(a, { t: 'start' });
    room.game = rigged([0, 1]);
    const [aceA, aceB] = [workTop(room.game, 0, 2), workTop(room.game, 1, 2)]; // both hearts
    sendIntent(room, b, 0, move(aceB, slot(0)));
    sendIntent(room, a, 0, move(aceA, slot(0)));
    room.flush();
    expect(filled(room.game)).toEqual([[aceB]]);
    expect(workTop(room.game, 0, 2)).toBe(aceA);
    expect([a.last.ack, b.last.ack]).toEqual([0, 0]);
    sendIntent(room, a, 1, move(aceA, slot(1))); // a deliberate second drop on a free slot is fine
    expect(room.game.slots.slice(0, 2).map((pile) => pile.map((c) => c.id))).toEqual([[aceB], [aceA]]);
    expect(checkInvariants(room.game)).toBeNull();
  });

  it('resumes the same seat and hand on reconnect, refuses strangers mid-round, and lets the newest socket win', () => {
    const { room, conns } = roomWith(2);
    const [a, b] = conns as [FakeConn, FakeConn];
    startRound(room, a);
    sendIntent(room, b, 9, { k: 'flip' });
    room.flush();
    const hand = b.last.room.game;

    room.disconnect(b);
    room.flush();
    expect(a.last.room.players[1]).toMatchObject({ seat: 1, connected: false });
    expect(room.join(new FakeConn(), 'Stranger', 'tok-zzzz')).toMatch(/in progress/);

    const b2 = new FakeConn();
    expect(room.join(b2, 'P1 again', 'tok-0001')).toBeNull();
    room.flush();
    expect(b2.last.room).toMatchObject({ you: 1, phase: 'playing' });
    expect(b2.last.room.game).toEqual(hand);
    expect(b2.last.ack).toBe(-1); // seq numbering is per connection
    expect(a.last.room.players[1]).toMatchObject({ name: 'P1 again', connected: true });

    const b3 = new FakeConn(); // a second tab with the same token takes the seat over
    room.join(b3, 'P1', 'tok-0001');
    expect(b2.closed).toBe(true);
    const rev = room.rev;
    sendIntent(room, b2, 0, { k: 'flip' }); // the replaced socket no longer speaks for the seat
    room.disconnect(b2);
    expect(room.rev).toBe(rev);
    expect(room.connected).toBe(2);
  });

  it('hands the host role on when the host is gone outside a round, and frees a seat on leaving the lobby', () => {
    const { room, conns } = roomWith(3);
    const [a, b, c] = conns as [FakeConn, FakeConn, FakeConn];
    room.disconnect(a);
    room.flush();
    expect(b.last.room.players.map((p) => p.isHost)).toEqual([false, true, false]);
    room.handle(b, { t: 'leave' });
    room.flush();
    expect(c.last.room.players.map((p) => [p.seat, p.isHost])).toEqual([[0, false], [2, true]]);
    const d = new FakeConn();
    room.join(d, 'Dee', 'tok-dddd');
    room.flush();
    expect(d.last.room.you).toBe(1); // the freed seat is reused
    // The original host (seat 0) is still away, so the first connected player deals.
    room.handle(c, { t: 'start' });
    expect(room.phase).toBe('lobby');
    room.handle(d, { t: 'start' });
    expect(room.phase).toBe('playing');
    expect(room.game!.players.map((p) => p.seat)).toEqual([1, 2]);
    room.disconnect(d);
    room.flush();
    expect(c.last.room.players.find((p) => p.isHost)?.seat).toBe(2);
  });

  it('gives the host role back when the host returns (a reload must not cost them the table)', () => {
    const { room, conns } = roomWith(2);
    const [a, b] = conns as [FakeConn, FakeConn];
    room.disconnect(a);
    room.flush();
    expect(b.last.room.players.map((p) => p.isHost)).toEqual([false, true]);
    const a2 = new FakeConn();
    room.join(a2, 'P0', 'tok-0000');
    room.flush();
    expect(b.last.room.players.map((p) => p.isHost)).toEqual([true, false]);
    room.handle(b, { t: 'start' }); // no longer the dealer
    expect(room.phase).toBe('lobby');
    room.handle(a2, { t: 'start' });
    expect(room.phase).toBe('playing');
  });

  it('deals only to players who are connected; someone away keeps seat and score and sits the round out', () => {
    const { room, conns } = roomWith(3);
    const [a, b, c] = conns as [FakeConn, FakeConn, FakeConn];
    room.disconnect(c);
    room.handle(a, { t: 'start' });
    expect(room.game!.players.map((p) => p.seat)).toEqual([0, 1]);
    // Back mid-round: seated, listed, but with no cards, and unable to act or to hold up a stuck vote.
    const c2 = new FakeConn();
    expect(room.join(c2, 'P2', 'tok-0002')).toBeNull();
    sendIntent(room, c2, 0, { k: 'flip' });
    room.flush();
    expect(c2.last.ack).toBe(0);
    expect(c2.last.room.you).toBe(2);
    expect(c2.last.room.players.map((p) => p.seat)).toEqual([0, 1, 2]);
    expect(c2.last.room.game!.players.map((p) => p.seat)).toEqual([0, 1]);
    sendIntent(room, a, 0, { k: 'flip' });
    sendIntent(room, a, 1, { k: 'stuck', on: true });
    sendIntent(room, b, 0, { k: 'stuck', on: true });
    expect(room.game!.players.every((p) => !p.stuck && p.waste.length === 0)).toBe(true);
    expect(checkInvariants(room.game!)).toBeNull();
    // One connected player is not a game.
    const solo = roomWith(2);
    solo.room.disconnect(solo.conns[1]!);
    solo.room.handle(solo.conns[0]!, { t: 'start' });
    expect(solo.room.phase).toBe('lobby');
  });

  it('unsticks the table when every connected player is stuck, re-checking when someone disconnects', () => {
    const { room, conns } = roomWith(3);
    const [a, b, c] = conns as [FakeConn, FakeConn, FakeConn];
    startRound(room, a);
    const firstTop = room.game!.players[0]!.stock.at(-1)!.id;
    sendIntent(room, a, 0, { k: 'flip' });
    sendIntent(room, a, 1, { k: 'stuck', on: true });
    sendIntent(room, b, 0, { k: 'stuck', on: true });
    room.flush();
    expect(c.last.room.players.map((p) => p.stuck)).toEqual([true, true, false]);
    expect(room.game!.players[0]!.waste).toHaveLength(3);

    room.disconnect(c); // the only hold-out leaves: the two who remain are both stuck
    room.flush();
    const p0 = room.game!.players[0]!;
    expect(p0.waste).toHaveLength(0);
    expect(p0.stock).toHaveLength(29);
    expect(p0.stock[0]!.id).toBe(firstTop); // old top card went to the bottom
    expect(a.last.room.players.map((p) => p.stuck)).toEqual([false, false, false]);
    expect(checkInvariants(room.game!)).toBeNull();
  });

  it('ends the round on "Nertz!" (at once when nobody holds a card), scores it, and deals the next round without players who left', () => {
    vi.useFakeTimers();
    const { room, conns } = roomWith(3);
    const [a, b, c] = conns as [FakeConn, FakeConn, FakeConn];
    startRound(room, a);
    sendIntent(room, a, 0, { k: 'nertz' }); // 13 cards left: refused
    expect(room.phase).toBe('playing');
    room.game = rigged([0, 1, 2], [1]);
    sendIntent(room, a, 1, move(workTop(room.game, 0, 0), slot(0)));
    sendIntent(room, b, 0, move(workTop(room.game, 1, 0), slot(1)));
    sendIntent(room, b, 1, move(workTop(room.game, 1, 2), slot(11)));
    room.flush();
    expect(a.last.room.graceMs).toBeNull();
    sendIntent(room, b, 2, { k: 'nertz' });
    sendIntent(room, a, 2, { k: 'flip' }); // too late
    room.flush();
    expect(room.phase).toBe('results');
    expect(vi.getTimerCount()).toBe(0); // no grace window was opened
    expect(a.last.ack).toBe(2);
    expect(a.last.room.graceMs).toBeNull();
    expect(a.last.room.lastRound).toEqual({
      calledBy: 1,
      scores: [
        { seat: 0, name: 'P0', played: 1, nertzLeft: 13, delta: -25, total: -25 },
        { seat: 1, name: 'P1', played: 2, nertzLeft: 0, delta: 2, total: 2 }, // no bonus for going out
        { seat: 2, name: 'P2', played: 0, nertzLeft: 13, delta: -26, total: -26 },
      ],
    });
    expect(a.last.room.players.map((p) => p.score)).toEqual([-25, 2, -26]);
    // The final table stays in the snapshot for the end-of-round sequence.
    expect(a.last.room.game).toEqual(wire(viewFor(room.game!, 0)));
    expect(a.last.room.game!.nertzCalledBy).toBe(1);
    expect(filled(a.last.room.game!)).toHaveLength(3);

    room.handle(c, { t: 'leave' });
    room.flush();
    expect(a.last.room.players).toHaveLength(3); // still listed on the results screen
    expect(filled(a.last.room.game!)).toHaveLength(3);
    const d = new FakeConn();
    expect(room.join(d, 'Dee', 'tok-dddd')).toBeNull(); // newcomers are welcome between rounds
    room.flush();
    expect(d.last.room.game).toEqual(a.last.room.game); // and see the finished table too
    room.handle(b, { t: 'start' }); // not the host
    expect(room.phase).toBe('results');
    room.handle(a, { t: 'start' });
    room.flush();
    expect(a.last.room).toMatchObject({ phase: 'playing', round: 2 });
    expect(a.last.room.players.map((p) => [p.seat, p.name, p.score])).toEqual([[0, 'P0', -25], [1, 'P1', 2], [3, 'Dee', 0]]);
    expect(room.game!.players.map((p) => p.seat)).toEqual([0, 1, 3]);
    expect(room.game!.slots).toHaveLength(12);
    expect(checkInvariants(room.game!)).toBeNull();
  });

  it('counts cleared piles in the tray, and only lets the player who placed the King clear', () => {
    const { room, conns } = roomWith(2);
    const [a, b] = conns as [FakeConn, FakeConn];
    room.handle(a, { t: 'start' });
    const g = rigged([0, 1], [0]);
    // Seat 1's spades, Ace to Queen, are already out in slot 3; seat 0 holds the King on a work pile.
    const spades = (seat: number) => {
      const p = g.players[seat]!;
      return ([...p.nertz, ...p.stock, ...p.work.flat()] as Card[]).filter((c) => c.suit === 'S').sort((x, y) => x.rank - y.rank);
    };
    const [king, pile] = [spades(0)[12]!, spades(1).slice(0, 12)];
    const strip = (cards: Card[], gone: Card[]) => cards.filter((c) => !gone.includes(c));
    room.game = {
      ...g,
      slots: g.slots.map((s, i) => (i === 3 ? pile : s)),
      players: g.players.map((p) =>
        p.seat === 0
          ? { ...p, stock: strip(p.stock as Card[], [king]), work: [[king], ...p.work.slice(1)], waste: [p.work[0]![0]!] }
          : { ...p, nertz: strip(p.nertz as Card[], pile), stock: strip(p.stock as Card[], pile), work: p.work.map((w) => strip(w as Card[], pile)) },
      ),
    };
    expect(checkInvariants(room.game)).toBeNull();
    sendIntent(room, a, 0, move(king.id, slot(3)));
    sendIntent(room, b, 0, { k: 'clear', slot: 3 }); // not theirs to clear
    expect(room.game.tray).toHaveLength(0);
    sendIntent(room, a, 1, { k: 'clear', slot: 3 });
    room.flush();
    expect(b.last.room.game!.tray).toEqual([wire([...pile, king])]);
    expect(b.last.room.game!.slots[3]).toEqual([]);
    sendIntent(room, a, 2, move(room.game.players[0]!.waste[0]!.id, slot(3))); // the freed slot takes a new Ace
    sendIntent(room, a, 3, { k: 'nertz' });
    room.flush();
    expect(a.last.room.lastRound!.scores).toEqual([
      { seat: 0, name: 'P0', played: 2, nertzLeft: 0, delta: 2, total: 2 },
      { seat: 1, name: 'P1', played: 12, nertzLeft: room.game.players[1]!.nertz.length, delta: 12 - 2 * room.game.players[1]!.nertz.length, total: 12 - 2 * room.game.players[1]!.nertz.length },
    ]);
    expect(a.last.room.game!.tray).toHaveLength(1); // still there for the end-of-round sequence
    expect(checkInvariants(room.game)).toBeNull();
  });

  describe('the deal', () => {
    const faces = (msg: StateMsg) => /"suit"|"rank"/.test(JSON.stringify(msg));
    const cardIds = (g: GameState) => g.players.flatMap((p) => [...p.nertz, ...p.work.flat(), ...p.stock, ...p.waste].map((c) => c.id));
    function table() {
      vi.useFakeTimers();
      const { room, conns } = roomWith(3);
      const [a, b, c] = conns as [FakeConn, FakeConn, FakeConn];
      room.handle(a, { t: 'start' });
      room.flush();
      return { room, conns, a, b, c };
    }

    it('is a phase of its own: no faces on the wire, every intent refused and acked, then play opens for everyone in one flush', () => {
      const { room, conns, a } = table();
      const dealt = room.game!;
      expect(vi.getTimerCount()).toBe(1);
      for (const conn of conns) {
        expect(conn.last.room).toMatchObject({ phase: 'playing', round: 1, dealMs: DEAL_MS, graceMs: null, game: { dealing: true } });
        expect(faces(conn.last)).toBe(false);
        expect(cardIds(conn.last.room.game!)).toEqual(cardIds(dealt));
      }

      // Everything a client could try, from every seat, on real card ids.
      vi.advanceTimersByTime(900);
      for (const [seat, conn] of conns.entries()) {
        const p = dealt.players[seat]!;
        const top = p.nertz.at(-1)!.id;
        const tries: Intent[] = [{ k: 'stuck', on: true }, { k: 'flip' }, hold(top), move(top, { k: 'work', i: 0 }), move(p.work[0]![0]!.id, slot(0)), { k: 'release' }, { k: 'nertz' }, { k: 'clear', slot: 0 }];
        const others = conns.filter((x) => x !== conn).map((x) => x.sent.length);
        tries.forEach((intent, seq) => sendIntent(room, conn, seq, intent));
        room.flush();
        expect(room.game).toBe(dealt); // nothing happened
        expect(conn.last).toMatchObject({ ack: tries.length - 1, room: { dealMs: DEAL_MS - 900, game: { dealing: true } } }); // acked all the same
        expect(faces(conn.last)).toBe(false);
        expect(conns.filter((x) => x !== conn).map((x) => x.sent.length)).toEqual(others); // only the sender hears of a refusal
      }
      expect(a.last.room.players.map((p) => p.stuck)).toEqual([false, false, false]);

      vi.advanceTimersByTime(DEAL_MS - 901);
      expect(room.game).toBe(dealt);
      const sent = conns.map((x) => x.sent.length);
      const anyFaceBefore = conns.some((x) => x.sent.some(faces));
      expect(anyFaceBefore).toBe(false);

      vi.advanceTimersByTime(1); // the deal timer
      expect(vi.getTimerCount()).toBe(0);
      expect(conns.map((x) => x.sent.length)).toEqual(sent); // nobody has been told yet...
      room.flush(); // ...and everybody is told in the same flush
      expect(conns.map((x) => x.sent.length)).toEqual(sent.map((n) => n + 1));
      for (const conn of conns) {
        expect(conn.last.room).toMatchObject({ phase: 'playing', dealMs: null, game: { dealing: false } });
        expect(conn.last.rev).toBe(a.last.rev);
        expect(conn.last.room.game).toEqual(wire(viewFor(finishDeal(dealt), 0)));
        expect(cardIds(conn.last.room.game!)).toEqual(cardIds(dealt)); // the same cards, turned over
      }
      sendIntent(room, a, 100, { k: 'flip' });
      expect(room.game!.players[0]!.waste).toHaveLength(3);
      expect(checkInvariants(room.game!)).toBeNull();
    });

    it('a reconnect mid-deal gets the remainder as a duration and still no faces; disconnects do not hold up the start', () => {
      const { room, a, b, c } = table();
      vi.advanceTimersByTime(1000);
      room.disconnect(b);
      const b2 = new FakeConn();
      expect(room.join(b2, 'P1', 'tok-0001')).toBeNull();
      room.flush();
      expect(b2.last.room).toMatchObject({ you: 1, dealMs: DEAL_MS - 1000, game: { dealing: true } });
      expect(faces(b2.last)).toBe(false);
      expect(faces(a.last)).toBe(false);
      expect(vi.getTimerCount()).toBe(1); // one deal, not restarted

      // Everyone drops before the cards are down: the round still opens on time, and whoever returns can play.
      room.disconnect(a);
      room.disconnect(b2);
      room.disconnect(c);
      vi.advanceTimersByTime(DEAL_MS - 1000);
      expect(vi.getTimerCount()).toBe(0);
      expect(room).toMatchObject({ phase: 'playing', game: { dealing: false, nertzCalledBy: null } });
      const a2 = new FakeConn();
      room.join(a2, 'P0', 'tok-0000');
      room.flush();
      expect(a2.last.room).toMatchObject({ dealMs: null, game: { dealing: false } });
      expect(faces(a2.last)).toBe(true);
      sendIntent(room, a2, 0, { k: 'flip' });
      expect(room.game!.players[0]!.waste).toHaveLength(3);
    });

    it('someone sitting the round out sees the same redacted deal', () => {
      vi.useFakeTimers();
      const { room, conns } = roomWith(3);
      const [a, , c] = conns as [FakeConn, FakeConn, FakeConn];
      room.disconnect(c);
      room.handle(a, { t: 'start' });
      vi.advanceTimersByTime(600);
      const c2 = new FakeConn();
      room.join(c2, 'P2', 'tok-0002');
      room.flush();
      expect(c2.last.room).toMatchObject({ you: 2, dealMs: DEAL_MS - 600, game: { dealing: true } });
      expect(c2.last.room.game!.players.map((p) => p.seat)).toEqual([0, 1]);
      expect(faces(c2.last)).toBe(false);
      sendIntent(room, c2, 0, { k: 'flip' }); // not in the round at all
      vi.advanceTimersByTime(DEAL_MS);
      room.flush();
      expect(faces(c2.last)).toBe(true);
    });

    it('stops its timer when the room is closed, and every later round is dealt the same way', () => {
      const { room } = table();
      room.close();
      expect(vi.getTimerCount()).toBe(0);
      vi.advanceTimersByTime(DEAL_MS * 2);
      expect(room.game!.dealing).toBe(true); // nothing fired on a forgotten room

      // A second round on a live room: scored round 1, then a fresh deal with its own timer.
      const next = roomWith(2);
      const [x, y] = next.conns as [FakeConn, FakeConn];
      startRound(next.room, x);
      next.room.game = rigged([0, 1], [0]);
      sendIntent(next.room, x, 0, { k: 'nertz' });
      expect(next.room.phase).toBe('results');
      expect(vi.getTimerCount()).toBe(0);
      next.room.handle(x, { t: 'start' });
      next.room.flush();
      expect(vi.getTimerCount()).toBe(1);
      expect(y.last.room).toMatchObject({ phase: 'playing', round: 2, dealMs: DEAL_MS, game: { dealing: true } });
      expect(faces(y.last)).toBe(false);
      vi.advanceTimersByTime(DEAL_MS);
      next.room.flush();
      expect(y.last.room).toMatchObject({ dealMs: null, game: { dealing: false } });
    });
  });

  describe('held-card grace', () => {
    /** Three players on the rigged deal; seat 1's nertz pile is empty, so `b` can call. */
    function table() {
      vi.useFakeTimers();
      const { room, conns } = roomWith(3);
      const [a, b, c] = conns as [FakeConn, FakeConn, FakeConn];
      startRound(room, a);
      room.game = rigged([0, 1, 2], [1]);
      const g = room.game;
      const cards = (seat: number) => ({ aceS: workTop(g, seat, 0), twoS: workTop(g, seat, 1), aceH: workTop(g, seat, 2), fiveD: workTop(g, seat, 3) });
      return { room, a, b, c, A: cards(0), C: cards(2) };
    }
    const holding = (room: Room) => room.game!.players.map((p) => p.holding);

    it('tracks holds: visible to everyone, cleared by a release, a move, a disconnect or a takeover', () => {
      const { room, a, b, c, A } = table();
      sendIntent(room, a, 0, hold(A.aceS));
      room.flush();
      expect(c.last.room.game!.players.map((p) => p.holding)).toEqual([A.aceS, null, null]);
      sendIntent(room, a, 1, hold(workTop(room.game!, 1, 0))); // someone else's card: refused, the earlier hold stands
      sendIntent(room, a, 2, hold(room.game!.players[0]!.stock[0]!.id)); // a face-down card: refused
      expect(holding(room)).toEqual([A.aceS, null, null]);
      sendIntent(room, a, 3, { k: 'release' });
      expect(holding(room)).toEqual([null, null, null]);
      sendIntent(room, a, 4, hold(A.aceS));
      sendIntent(room, a, 5, move(A.aceS, slot(0)));
      expect(holding(room)).toEqual([null, null, null]);
      sendIntent(room, a, 6, hold(A.twoS));
      sendIntent(room, c, 0, hold(workTop(room.game!, 2, 0)));
      room.disconnect(a);
      expect(holding(room)).toEqual([null, null, workTop(room.game!, 2, 0)]);
      const c2 = new FakeConn();
      room.join(c2, 'P2', 'tok-0002'); // same seat from a new socket: nothing is in that hand
      expect(c.closed).toBe(true);
      expect(holding(room)).toEqual([null, null, null]);
      sendIntent(room, b, 0, { k: 'nertz' }); // so nobody is in grace
      expect(room.phase).toBe('results');
      expect(vi.getTimerCount()).toBe(0);
    });

    it('a holder with a legal spot gets a window: everyone else is frozen, only the held card moves, and the move ends the round and scores', () => {
      const { room, a, b, c, A } = table();
      sendIntent(room, a, 0, hold(A.aceS));
      sendIntent(room, b, 0, { k: 'nertz' });
      room.flush();
      expect(room.phase).toBe('playing');
      for (const conn of [a, b, c]) {
        expect(conn.last.room).toMatchObject({ phase: 'playing', graceMs: GRACE_MS, lastRound: null });
        expect(conn.last.room.game).toMatchObject({ nertzCalledBy: 1, grace: [0] });
        expect(conn.last.room.game!.players.map((p) => p.holding)).toEqual([A.aceS, null, null]);
      }
      expect(GRACE_MS).toBe(4000);

      vi.advanceTimersByTime(1500);
      const before = room.game;
      sendIntent(room, c, 0, { k: 'flip' }); // frozen
      sendIntent(room, c, 1, move(workTop(room.game!, 2, 0), slot(0)));
      sendIntent(room, c, 2, hold(workTop(room.game!, 2, 0)));
      sendIntent(room, b, 1, { k: 'flip' });
      sendIntent(room, a, 1, { k: 'flip' }); // in grace, but that is not putting the card down
      sendIntent(room, a, 2, hold(A.aceH));
      expect(room.game).toBe(before);
      room.flush();
      expect(a.last).toMatchObject({ ack: 2, room: { phase: 'playing', graceMs: GRACE_MS - 1500 } }); // a duration, counted down
      expect(c.last.ack).toBe(2);

      sendIntent(room, a, 4, move(A.aceS, slot(7)));
      room.flush();
      expect(room.phase).toBe('results');
      expect(vi.getTimerCount()).toBe(0);
      expect(a.last.room).toMatchObject({ phase: 'results', graceMs: null });
      expect(a.last.room.game).toMatchObject({ nertzCalledBy: 1, grace: [] });
      expect(a.last.room.game!.slots[7]!.map((x) => x.id)).toEqual([A.aceS]);
      expect(a.last.room.lastRound!.scores.map((x) => [x.played, x.delta])).toEqual([[1, -25], [0, 0], [0, -26]]); // the grace move counted
      const rev = room.rev;
      vi.advanceTimersByTime(10_000);
      sendIntent(room, a, 5, move(A.aceH, slot(0))); // exactly one move
      expect(room.game!.slots[0]).toEqual([]);
      expect(room.rev).toBe(rev + 1); // only the rejection's ack
    });

    // Regression: a drop that lost a race used to leave `holding` set on the server (only an accepted move or an
    // explicit release cleared it), so a later Nertz call opened a 4-second window for a player holding nothing.
    it('a refused drop empties the hand: losing a race and then hearing Nertz does not open a window', () => {
      const { room, a, b, c, A, C } = table();
      // Both drag their Ace of spades to slot 0, exactly as the client sends it: hold, then move. Seat 2 arrives first.
      sendIntent(room, a, 0, hold(A.aceS));
      sendIntent(room, c, 0, hold(C.aceS));
      sendIntent(room, c, 1, move(C.aceS, slot(0)));
      room.flush();
      const sent = b.sent.length;
      sendIntent(room, a, 1, move(A.aceS, slot(0))); // refused: the slot is taken
      expect(filled(room.game!)).toEqual([[C.aceS]]);
      expect(workTop(room.game!, 0, 0)).toBe(A.aceS); // back where it came from
      expect(holding(room)).toEqual([null, null, null]);
      room.flush();
      expect(b.sent.length).toBe(sent + 1); // the others are told that hand is empty
      expect(b.last.room.game!.players.map((p) => p.holding)).toEqual([null, null, null]);

      sendIntent(room, a, 2, { k: 'flip' });
      sendIntent(room, b, 0, { k: 'nertz' });
      expect(room.game!.grace).toEqual([]);
      expect(room.phase).toBe('results'); // at once
      expect(vi.getTimerCount()).toBe(0);
    });

    it('a refused drop during grace ends that player\'s grace: two holders racing for one slot finish the round at once', () => {
      const { room, a, b, c, A, C } = table();
      sendIntent(room, a, 0, hold(A.aceS));
      sendIntent(room, c, 0, hold(C.aceS));
      sendIntent(room, b, 0, { k: 'nertz' });
      expect(room.game!.grace).toEqual([0, 2]);
      vi.advanceTimersByTime(500);
      sendIntent(room, a, 1, move(A.aceS, slot(0)));
      expect(room.game!.grace).toEqual([2]); // seat 2 still has other empty slots to go to
      sendIntent(room, c, 1, move(C.aceS, slot(0))); // released on the slot that was just taken: that was their one move
      expect(holding(room)).toEqual([null, null, null]);
      expect(room.phase).toBe('results');
      expect(vi.getTimerCount()).toBe(0);
      expect(filled(room.game!)).toEqual([[A.aceS]]);
      expect(workTop(room.game!, 2, 0)).toBe(C.aceS);

      // A drop on a spot that never took the card is a drop all the same.
      const again = table();
      sendIntent(again.room, again.a, 0, hold(again.A.aceS));
      sendIntent(again.room, again.b, 0, { k: 'nertz' });
      sendIntent(again.room, again.a, 1, move(again.A.aceS, { k: 'work', i: 1 }));
      expect(again.room.phase).toBe('results');
      expect(filled(again.room.game!)).toEqual([]);
    });

    // Regression (R1): a move used to lift whatever lay on the named card NOW. A client that had predicted its top
    // card gone and dragged the card beneath it would carry the refused card along to a pile it was never dropped on.
    it('a move says how many cards were lifted: a refused card is not carried along by a drag of the card under it', () => {
      const { room, a, c, A, C } = table();
      const g = room.game!;
      const me = g.players[0]!;
      const pool = [...me.nertz, ...me.stock] as Card[];
      const [twoH, threeC] = [pool.find((x) => x.suit === 'H' && x.rank === 2)!, pool.find((x) => x.suit === 'C' && x.rank === 3)!];
      const rest = (pile: readonly unknown[]) => (pile as Card[]).filter((x) => x !== twoH && x !== threeC);
      const ace = me.work[0]![0]!;
      // Seat 0: Ace of spades on the 2 of hearts in pile 0, the 3 of clubs alone in pile 1.
      room.game = { ...g, players: g.players.map((p) => (p.seat === 0 ? { ...p, nertz: rest(p.nertz), stock: [...rest(p.stock), p.work[1]![0]!], work: [[twoH, ace], [threeC], p.work[2]!, p.work[3]!] } : p)) };
      expect(checkInvariants(room.game)).toBeNull();

      sendIntent(room, c, 0, move(C.aceS, slot(0))); // seat 2 takes the slot first
      // Seat 0, still looking at the empty slot: drops the Ace on it, then at once drags the 2 it uncovered to the 3.
      sendIntent(room, a, 0, hold(A.aceS));
      sendIntent(room, a, 1, move(A.aceS, slot(0)));
      sendIntent(room, a, 2, hold(twoH.id));
      sendIntent(room, a, 3, move(twoH.id, { k: 'work', i: 1 })); // "one card", but two lie there now
      const work = room.game.players[0]!.work.map((pile) => pile.map((x) => x.id));
      expect(work.slice(0, 2)).toEqual([[twoH.id, A.aceS], [threeC.id]]); // both are back where they came from
      expect(room.game.players[0]!.holding).toBeNull();
      sendIntent(room, a, 4, move(twoH.id, { k: 'work', i: 1 }, 2)); // lifting both on purpose is an ordinary run move
      expect(room.game.players[0]!.work[1]!.map((x) => x.id)).toEqual([threeC.id, twoH.id, A.aceS]);
      expect(checkInvariants(room.game)).toBeNull();
    });

    it('the window closes by itself after 4 seconds: the card goes back and the round is scored without it', () => {
      const { room, a, b, c, A } = table();
      sendIntent(room, a, 0, hold(A.aceS));
      sendIntent(room, b, 0, { k: 'nertz' });
      room.flush();
      vi.advanceTimersByTime(GRACE_MS - 1);
      expect(room.phase).toBe('playing');
      sendIntent(room, c, 0, { k: 'flip' });
      room.flush();
      expect(c.last.room.graceMs).toBe(1);
      const sent = a.sent.length;
      vi.advanceTimersByTime(1);
      expect(room.phase).toBe('results');
      room.flush();
      expect(a.sent.length).toBe(sent + 1); // everyone is told
      expect(a.last.room).toMatchObject({ phase: 'results', graceMs: null });
      expect(a.last.room.game).toMatchObject({ nertzCalledBy: 1, grace: [] });
      expect(holding(room)).toEqual([null, null, null]); // the drag is cancelled
      expect(workTop(room.game!, 0, 0)).toBe(A.aceS);
      expect(filled(room.game!)).toEqual([]);
      expect(a.last.room.lastRound!.scores.map((x) => x.delta)).toEqual([-26, 0, -26]);
      expect(a.last.room.players.map((p) => p.score)).toEqual([-26, 0, -26]);
      sendIntent(room, a, 1, move(A.aceS, slot(0))); // too late
      expect(filled(room.game!)).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
      // The next round is not disturbed by anything left over.
      room.handle(a, { t: 'start' });
      vi.advanceTimersByTime(60_000);
      expect(room.phase).toBe('playing');
      expect(room.game!.nertzCalledBy).toBeNull();
    });

    it('a holder whose card has nowhere legal to go is cut off at the call: no window at all', () => {
      const { room, a, b, c, C } = table();
      sendIntent(room, c, 0, hold(C.fiveD));
      sendIntent(room, b, 0, { k: 'nertz' });
      expect(room.phase).toBe('results');
      expect(vi.getTimerCount()).toBe(0);
      room.flush();
      expect(a.last.room.game!.players.map((p) => p.holding)).toEqual([null, null, null]);
    });

    it('a target taken during grace by another grace player cuts the other one off and ends the window early', () => {
      const { room, a, b, c, A, C } = table();
      sendIntent(room, a, 0, move(A.aceS, slot(4)));
      // Both 2s of spades fit only that one pile.
      sendIntent(room, a, 1, hold(A.twoS));
      sendIntent(room, c, 0, hold(C.twoS));
      sendIntent(room, b, 0, { k: 'nertz' });
      expect(room.game!.grace).toEqual([0, 2]);
      expect(room.phase).toBe('playing');
      vi.advanceTimersByTime(700);
      sendIntent(room, c, 1, move(C.twoS, slot(4)));
      expect(room.phase).toBe('results'); // nobody is left who could do anything
      expect(vi.getTimerCount()).toBe(0);
      sendIntent(room, a, 2, move(A.twoS, slot(4)));
      room.flush();
      expect(room.game!.slots[4]!.map((x) => x.id)).toEqual([A.aceS, C.twoS]);
      expect(workTop(room.game!, 0, 1)).toBe(A.twoS);
      expect(holding(room)).toEqual([null, null, null]);
      expect(a.last.room.lastRound!.scores.map((x) => x.played)).toEqual([1, 0, 1]);
    });

    it('waits for every holder: the window stays open until the last one has moved or released', () => {
      const { room, a, b, c, A, C } = table();
      sendIntent(room, a, 0, hold(A.aceS));
      sendIntent(room, c, 0, hold(C.aceH));
      sendIntent(room, b, 0, { k: 'nertz' });
      expect(room.game!.grace).toEqual([0, 2]);
      vi.advanceTimersByTime(1000);
      sendIntent(room, c, 1, { k: 'release' });
      expect(room.phase).toBe('playing');
      expect(room.game!.grace).toEqual([0]);
      sendIntent(room, c, 2, move(C.aceH, slot(0))); // they let go: frozen now
      expect(filled(room.game!)).toEqual([]);
      room.flush();
      expect(a.last.room.graceMs).toBe(GRACE_MS - 1000); // one window, not restarted
      vi.advanceTimersByTime(1000);
      sendIntent(room, a, 1, move(A.aceS, slot(0)));
      expect(room.phase).toBe('results');
      expect(filled(room.game!)).toEqual([[A.aceS]]);
    });

    it('a player who disconnects while in grace is cut off', () => {
      const { room, a, b, c, A, C } = table();
      sendIntent(room, a, 0, hold(A.aceS));
      sendIntent(room, c, 0, hold(C.aceS));
      sendIntent(room, b, 0, { k: 'nertz' });
      room.disconnect(a);
      expect(room.game!.grace).toEqual([2]);
      expect(room.phase).toBe('playing');
      const a2 = new FakeConn();
      room.join(a2, 'P0', 'tok-0000'); // coming straight back does not reopen it
      sendIntent(room, a2, 0, move(A.aceS, slot(0)));
      expect(filled(room.game!)).toEqual([]);
      room.flush();
      expect(a2.last.room).toMatchObject({ phase: 'playing', graceMs: GRACE_MS });
      room.handle(c, { t: 'leave' }); // walking out counts as letting go too
      expect(room.phase).toBe('results');
      expect(vi.getTimerCount()).toBe(0);
      expect(holding(room)).toEqual([null, null, null]);
    });
  });

  it('keeps every invariant through thousands of random intents decided on stale views', () => {
    const { room, conns } = roomWith(4, 42);
    startRound(room, conns[0]!);
    room.flush();
    const rnd = seeded(99);
    const seqs = [0, 0, 0, 0];
    let accepted = 0;
    for (let n = 0; n < 6000; n++) {
      const seat = Math.floor(rnd() * 4);
      const conn = conns[seat]!;
      const before = room.game;
      sendIntent(room, conn, seqs[seat]!++, botIntent(conn.last.room.game!, seat, rnd));
      if (room.game !== before) accepted++;
      expect(checkInvariants(room.game!)).toBeNull();
      if (rnd() < 0.15) room.flush(); // views lag behind by a handful of intents
    }
    room.flush();
    expect(accepted).toBeGreaterThan(1000);
    expect(filled(room.game!).length + room.game!.tray.length).toBeGreaterThan(4); // these bots often play every last card out
    expect(room.game!.players.some((p) => p.down.some((n, i) => n < i))).toBe(true); // face-down work cards were turned over
    conns.forEach((conn, seat) => {
      expect(conn.last.ack).toBe(seqs[seat]! - 1);
      expect(conn.last.room.game).toEqual(wire(viewFor(room.game!, seat)));
      expect(checkInvariants(conn.last.room.game!)).toBeNull();
      const revs = conn.sent.map((m) => m.rev);
      expect(revs.every((r, i) => i === 0 || r > revs[i - 1]!)).toBe(true);
    });
  });
});

// ---------------------------------------------------------------- the real server, over real sockets

/** A websocket client that records everything the server sends it. */
class Client {
  states: StateMsg[] = [];
  errors: string[] = [];
  raw: string[] = [];
  seq = 0;
  closeCode: number | null = null;
  private constructor(
    readonly ws: WebSocket,
    readonly token: string,
  ) {
    ws.on('message', (data) => {
      const text = data.toString();
      this.raw.push(text);
      const msg = JSON.parse(text) as ServerMsg;
      if (msg.t === 'state') this.states.push(msg);
      else if (msg.t === 'error') this.errors.push(msg.message);
    });
    ws.on('close', (code) => (this.closeCode = code));
    ws.on('error', () => {});
  }
  /** Connects and sits down: `room` null opens a new table (the server picks the code), otherwise joins that code. */
  static async open(port: number, room: string | null, name: string, token: string = randomUUID(), expectSeat = true): Promise<Client> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise((ok, fail) => ws.once('open', ok).once('error', fail));
    const client = new Client(ws, token);
    client.send(room === null ? { t: 'create', name, token } : { t: 'join', room, name, token });
    if (expectSeat) await vi.waitFor(() => expect(client.states.length).toBeGreaterThan(0));
    return client;
  }
  send(msg: unknown): void {
    this.ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
  }
  intent(intent: unknown): number {
    this.send({ t: 'intent', seq: this.seq, intent });
    return this.seq++;
  }
  get last(): StateMsg {
    return this.states.at(-1)!;
  }
  get seat(): number {
    return this.last.room.you;
  }
  get code(): string {
    return this.last.room.code;
  }
  async close(): Promise<void> {
    if (this.ws.readyState === WebSocket.CLOSED) return;
    const closed = new Promise((ok) => this.ws.once('close', ok));
    this.ws.close();
    await closed;
  }
}

describe('server over real sockets', () => {
  let server: NertzServer;
  let dist: string;
  const clients: Client[] = [];
  const open = async (...args: Parameters<typeof Client.open> extends [number, ...infer R] ? R : never) => {
    const c = await Client.open(server.port, ...args);
    clients.push(c);
    return c;
  };
  /** A new table with `n` players, round started. */
  const table = async (n: number): Promise<{ room: Room; code: string; players: Client[] }> => {
    const players = [await open(null, 'P0')];
    const code = players[0]!.code;
    for (let i = 1; i < n; i++) players.push(await open(code, `P${i}`));
    players[0]!.send({ t: 'start' });
    await vi.waitFor(() => players.forEach((p) => expect(p.last.room.phase).toBe('playing')));
    const room = server.rooms.get(code)!;
    room.game = finishDeal(room.game!); // these tests are about play: skip the deal (its timer then finds nothing to do)
    return { room, code, players };
  };

  beforeAll(async () => {
    dist = mkdtempSync(join(tmpdir(), 'nertz-dist-'));
    writeFileSync(join(dist, 'index.html'), '<!doctype html><title>nertz test</title>');
    server = await startServer({ port: 0, dist, rate: 1e9 }); // the swarm test floods on purpose
  });
  afterAll(async () => {
    await server.close();
    rmSync(dist, { recursive: true, force: true });
  });

  it('answers /healthz, serves the client with an SPA fallback and does not leak files', async () => {
    const get = (path: string) => fetch(`http://127.0.0.1:${server.port}${path}`);
    expect(await (await get('/healthz')).json()).toMatchObject({ ok: true });
    for (const path of ['/', '/?room=ABCD', '/some/route']) {
      const res = await get(path);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/text\/html/);
      expect(await res.text()).toContain('nertz test');
    }
    expect((await get('/assets/missing.js')).status).toBe(404);
    expect((await get('/%2e%2e/%2e%2e/package.json')).status).toBe(404);
    expect((await get('/%00')).status).toBe(200); // falls back to the app, does not throw
    expect((await get('/%E0%A4%A')).status).toBe(400); // undecodable path
    expect((await get('/ws')).status).toBe(200); // plain GET on the socket path is just an app route
  });

  it('create makes a table with a server-chosen code; joining a code that does not exist is an error, not a new table', async () => {
    const lost = await open('ZZZZ', 'Lost', randomUUID(), false);
    await vi.waitFor(() => expect(lost.errors).toEqual([expect.stringMatching(/no table ZZZZ/i)]));
    expect(lost.states).toHaveLength(0);
    expect(server.rooms.has('ZZZZ')).toBe(false);

    const ann = await open(null, 'Ann');
    expect(isRoomCode(ann.code)).toBe(true);
    expect(server.rooms.has(ann.code)).toBe(true);
    expect(ann.last.room).toMatchObject({ phase: 'lobby', you: 0, players: [{ name: 'Ann', isHost: true }] });
    const other = await open(null, 'Zed');
    expect(other.code).not.toBe(ann.code); // every create is its own table
    expect(other.last.room.players).toHaveLength(1);

    const bob = await open(ann.code.toLowerCase(), 'Bob');
    expect(bob.last.room).toMatchObject({ code: ann.code, you: 1 });
    await vi.waitFor(() => expect(ann.last.room.players.map((p) => p.name)).toEqual(['Ann', 'Bob']));

    // The same socket can still take a seat after a refused join.
    lost.send({ t: 'join', room: ann.code, name: 'Lost', token: lost.token });
    await vi.waitFor(() => expect(lost.last?.room.you).toBe(2));
    // A second create from a seated socket moves it to a fresh table of its own.
    lost.send({ t: 'create', name: 'Lost', token: lost.token });
    await vi.waitFor(() => expect(lost.code).not.toBe(ann.code));
    // Going to another table from a lobby gives the seat up: nothing is left behind to hold a place.
    await vi.waitFor(() => expect(ann.last.room.players.map((p) => p.name)).toEqual(['Ann', 'Bob']));
  });

  // Regression: every `create` left its previous table behind with a seated, disconnected player, kept for ten
  // minutes. A handful of sockets could fill all 2000 tables in a second or two.
  it('one connection holds at most one never-started table, and an abandoned lobby is forgotten after a minute', async () => {
    const before = server.rooms.size;
    const spam = await open(null, 'Spam');
    const codes = new Set([spam.code]);
    for (let i = 0; i < 100; i++) spam.send({ t: 'create', name: 'Spam', token: spam.token });
    spam.send('not json'); // answered in order, so its error means all hundred creates have been handled
    await vi.waitFor(() => expect(spam.errors).toHaveLength(1));
    expect(server.rooms.size).toBe(before + 1); // each create gave up the table before it
    await vi.waitFor(() => expect(codes.has(spam.code)).toBe(false)); // and the socket sits at the newest one
    expect(server.rooms.has(spam.code)).toBe(true);

    // Closing the socket keeps a lobby seat for a reload, but only briefly.
    const code = spam.code;
    await spam.close();
    await vi.waitFor(() => expect(server.rooms.get(code)!.connected).toBe(0));
    server.sweep(Date.now() + 30_000);
    expect(server.rooms.has(code)).toBe(true);
    server.sweep(Date.now() + 61_000);
    expect(server.rooms.has(code)).toBe(false);
  });

  it('(a) two clients racing the same rank onto one pile, and two aces onto one slot: exactly one lands, both are acked, the loser stays put', async () => {
    const { room, players } = await table(2);
    const [a, b] = players as [Client, Client];
    room.game = rigged([0, 1]);
    const ace = workTop(room.game, a.seat, 0);
    const twos = [workTop(room.game, 0, 1), workTop(room.game, 1, 1)];
    a.intent(move(ace, slot(6)));
    await vi.waitFor(() => expect(a.last.ack).toBe(0));
    // Same tick, both sockets: whichever frame the server reads first wins. Two red aces race for slot 0 as well.
    const hearts = [workTop(room.game, 0, 2), workTop(room.game, 1, 2)];
    a.intent(move(twos[0]!, slot(6)));
    b.intent(move(twos[1]!, slot(6)));
    const seqA = a.intent(move(hearts[0]!, slot(0)));
    const seqB = b.intent(move(hearts[1]!, slot(0)));
    await vi.waitFor(() => {
      expect(a.last.ack).toBe(seqA);
      expect(b.last.ack).toBe(seqB);
    });
    const pile = room.game.slots[6]!.map((c) => c.id);
    expect(pile).toHaveLength(2);
    expect(twos).toContain(pile[1]);
    const loser = twos.find((id) => id !== pile[1])!;
    expect(room.game.players.some((p) => p.work[1]!.at(-1)?.id === loser)).toBe(true); // still where it was
    const slot0 = room.game.slots[0]!.map((c) => c.id);
    expect(slot0).toHaveLength(1);
    expect(hearts).toContain(slot0[0]);
    expect(room.game.players.some((p) => p.work[2]!.at(-1)?.id === hearts.find((id) => id !== slot0[0]))).toBe(true);
    expect(filled(room.game)).toHaveLength(2); // nothing was rerouted anywhere else
    expect(checkInvariants(room.game)).toBeNull();
    await vi.waitFor(() => {
      for (const c of [a, b]) expect(c.last.room.game).toEqual(wire(viewFor(room.game!, c.seat)));
    });
  });

  it('held-card grace over the wire: hold, call, countdown duration, one last move, then results with the final table', async () => {
    const { room, players } = await table(3);
    const [a, b, c] = players as [Client, Client, Client];
    room.game = rigged([0, 1, 2], [1]);
    const [aceA, aceC] = [workTop(room.game, 0, 0), workTop(room.game, 2, 0)];
    a.intent({ k: 'hold', cardId: aceA });
    c.intent({ k: 'hold', cardId: aceC });
    await vi.waitFor(() => expect(b.last.room.game!.players.map((p) => p.holding)).toEqual([aceA, null, aceC]));
    b.intent({ k: 'nertz' });
    await vi.waitFor(() => expect(c.last.room.game!.nertzCalledBy).toBe(1));
    for (const p of players) {
      await vi.waitFor(() => expect(p.last.room.game!.grace).toEqual([0, 2]));
      expect(p.last.room.phase).toBe('playing');
      expect(p.last.room.graceMs).toBeGreaterThan(GRACE_MS - 1000);
      expect(p.last.room.graceMs).toBeLessThanOrEqual(GRACE_MS);
    }
    const flip = b.intent({ k: 'flip' }); // frozen
    a.intent(move(aceA, slot(2)));
    await vi.waitFor(() => expect(b.last.ack).toBe(flip));
    await vi.waitFor(() => expect(b.last.room.game!.grace).toEqual([2]));
    expect(b.last.room.phase).toBe('playing');
    expect(b.last.room.game!.players[1]!.waste).toHaveLength(0);
    await c.close(); // the last one in grace drops off the network: no need to wait out the clock
    await vi.waitFor(() => expect(a.last.room.phase).toBe('results'));
    expect(a.last.room).toMatchObject({ graceMs: null, lastRound: { calledBy: 1 } });
    expect(a.last.room.lastRound!.scores.map((x) => x.played)).toEqual([1, 0, 0]);
    expect(a.last.room.game).toEqual(wire(viewFor(room.game!, 0)));
    expect(a.last.room.game!.slots[2]!.map((x) => x.id)).toEqual([aceA]);
    expect(a.last.room.game!.players.every((p) => p.holding === null)).toBe(true);
  });

  it('(b) a swarm of four bots firing as fast as they can never breaks the table', async () => {
    const { room, players } = await table(4);
    const rnd = seeded(2024);
    const PER_BOT = 1200;
    const BURST = 12;
    const problems: string[] = [];
    let checks = 0;
    for (const bot of players) {
      bot.ws.on('message', () => {
        // Runs between server turns, so this samples the authoritative state all the way through.
        const bad = checkInvariants(room.game!) ?? checkInvariants(bot.last.room.game!);
        if (bad) problems.push(bad);
        checks++;
      });
    }
    await Promise.all(
      players.map(async (bot) => {
        while (bot.seq < PER_BOT) {
          for (let i = 0; i < BURST && bot.seq < PER_BOT; i++) {
            if (rnd() < 0.03) bot.send(rnd() < 0.5 ? 'not json {' : { t: 'intent', seq: bot.seq, intent: { k: 'teleport' } });
            // Always finish on something well-formed, so the last seq is one the server can ack.
            bot.intent(bot.seq === PER_BOT - 1 ? { k: 'flip' } : botIntent(bot.last.room.game!, bot.seat, rnd));
          }
          await new Promise((next) => setImmediate(next)); // let snapshots in; the view stays a burst behind
        }
      }),
    );
    await vi.waitFor(
      () => {
        for (const bot of players) {
          expect(bot.last.ack).toBe(PER_BOT - 1);
          expect(bot.last.room.game).toEqual(wire(viewFor(room.game!, bot.seat)));
        }
      },
      { timeout: 10_000 },
    );
    expect(problems).toEqual([]);
    expect(checks).toBeGreaterThan(100);
    expect(filled(room.game!).length + room.game!.tray.length).toBeGreaterThan(0);
    for (const bot of players) {
      const revs = bot.states.map((m) => m.rev);
      expect(revs.every((r, i) => i === 0 || r > revs[i - 1]!)).toBe(true);
      const acks = bot.states.map((m) => m.ack);
      expect(acks.every((k, i) => i === 0 || k >= acks[i - 1]!)).toBe(true);
      expect(bot.errors.every((e) => e === 'Malformed message')).toBe(true);
    }
  }, 30_000);

  it('(c) reconnecting with the same token resumes the seat with the same hand', async () => {
    const { room, code, players } = await table(2);
    const [a, b] = players as [Client, Client];
    b.intent({ k: 'flip' });
    await vi.waitFor(() => expect(b.last.ack).toBe(0));
    const before = b.last;
    await b.close();
    await vi.waitFor(() => expect(a.last.room.players[1]!.connected).toBe(false));

    const stranger = await open(code, 'Stranger', randomUUID(), false);
    await vi.waitFor(() => expect(stranger.errors).toEqual([expect.stringMatching(/in progress/)]));

    const b2 = await open(code, 'P1', b.token);
    expect(b2.last.room.you).toBe(before.room.you);
    expect(b2.last.room.game).toEqual(before.room.game);
    expect(b2.last.rev).toBeGreaterThan(before.rev);
    await vi.waitFor(() => expect(a.last.room.players[1]!.connected).toBe(true));

    const b3 = await open(code, 'P1', b.token); // e.g. a duplicated tab: the newer socket takes over
    await vi.waitFor(() => expect(b2.closeCode).toBe(CLOSE_REPLACED));
    expect(b3.last.room.you).toBe(before.room.you);
    expect(room.connected).toBe(2);
  });

  it('(d) malformed and oversized messages neither crash the server nor change any state', async () => {
    const { room, code, players } = await table(2);
    const [a, b] = players as [Client, Client];
    const [game, rev, seen] = [room.game, room.rev, b.states.length];
    const junk: unknown[] = [
      'not json',
      '',
      'null',
      '[]',
      '{"t":"intent"}',
      { t: 'intent', seq: -1, intent: { k: 'flip' } },
      { t: 'intent', seq: 1.5, intent: { k: 'flip' } },
      { t: 'intent', seq: 0, intent: { k: 'move', cardId: 'x', count: 1, to: { k: 'work', i: 99 } } },
      { t: 'intent', seq: 0, intent: { k: 'move', cardId: { $ne: 1 }, to: null } },
      { t: 'intent', seq: 0, intent: { k: 'move', cardId: 'x', to: { k: 'newFoundation' } } },
      { t: 'intent', seq: 0, intent: { k: 'hold' } },
      { t: 'intent', seq: 0, intent: { k: 'clear', slot: 99 } },
      { t: 'create', name: '', token: randomUUID() },
      { t: 'join', room: 'JUNK', name: '', token: 'short' },
      { t: 'join', room: '../etc', name: 'x', token: randomUUID() },
      { t: 'selfdestruct' },
      { __proto__: null, t: 'start', constructor: 'x' },
    ];
    for (const j of junk) a.send(j);
    a.ws.send(Buffer.from([0, 1, 2, 255])); // binary frame
    await vi.waitFor(() => expect(a.errors).toHaveLength(junk.length)); // every text frame but the valid 'start', plus the binary one
    expect(room.game).toBe(game); // the stray 'start' mid-round was ignored too
    expect(room.rev).toBe(rev);
    expect(b.states.length).toBe(seen);

    a.send(JSON.stringify({ t: 'intent', seq: 0, intent: { k: 'flip' }, pad: 'x'.repeat(MAX_MESSAGE_BYTES) }));
    await vi.waitFor(() => expect(a.closeCode).toBe(1009)); // "message too big": the socket is dropped
    await vi.waitFor(() => expect(b.last.room.players[0]!.connected).toBe(false));
    expect(room.game).toBe(game);

    // The server and the room are still perfectly usable.
    b.intent({ k: 'flip' });
    await vi.waitFor(() => expect(b.last.ack).toBe(0));
    expect(checkInvariants(room.game!)).toBeNull();
    const a2 = await open(code, 'P0', a.token);
    expect(a2.last.room.you).toBe(0);
  });

  it('closes a connection that floods, at the default rate limit, and lets it come back to its seat', async () => {
    const limited = await startServer({ port: 0, dist });
    try {
      const token = randomUUID();
      const flooder = await Client.open(limited.port, null, 'Flo', token);
      const code = flooder.code;
      const closed = new Promise<number>((ok) => flooder.ws.once('close', (code) => ok(code)));
      for (let i = 0; i < 400; i++) flooder.intent({ k: 'stuck', on: i % 2 === 0 });
      expect(await closed).toBe(CLOSE_FLOOD);
      const back = await Client.open(limited.port, code, 'Flo', token);
      expect(back.seat).toBe(0);
      await back.close();
    } finally {
      await limited.close();
    }
  });

  it('(e) never sends a token to anyone', () => {
    const tokens = new Set(clients.map((c) => c.token));
    expect(tokens.size).toBeGreaterThan(8);
    let messages = 0;
    for (const c of clients) {
      for (const text of c.raw) {
        messages++;
        for (const token of tokens) expect(text.includes(token)).toBe(false);
      }
    }
    expect(messages).toBeGreaterThan(300);
  });

  it('forgets empty rooms at once and idle ones after ten minutes', async () => {
    const a = await open(null, 'Ann');
    const code = a.code;
    const b = await open(code, 'Bob');
    const solo = await open(null, 'Sol');
    const lane = solo.code;
    expect(server.rooms.has(code) && server.rooms.has(lane)).toBe(true);

    solo.send({ t: 'leave' }); // last player walks out of a lobby: nothing left to keep
    await vi.waitFor(() => expect(server.rooms.has(lane)).toBe(false));
    const late = await open(lane, 'Late', randomUUID(), false); // and the code is not quietly revived
    await vi.waitFor(() => expect(late.errors).toHaveLength(1));
    expect(server.rooms.has(lane)).toBe(false);

    a.send({ t: 'start' });
    await vi.waitFor(() => expect(b.last.room.phase).toBe('playing'));
    await a.close();
    await b.close();
    await vi.waitFor(() => expect(server.rooms.get(code)!.connected).toBe(0));
    server.sweep(Date.now() + 9 * 60_000);
    expect(server.rooms.has(code)).toBe(true);
    const a2 = await open(code, 'Ann', a.token); // coming back resets the clock
    expect(a2.last.room.phase).toBe('playing');
    server.sweep(Date.now() + 11 * 60_000);
    expect(server.rooms.has(code)).toBe(true);
    await a2.close();
    await vi.waitFor(() => expect(server.rooms.get(code)!.connected).toBe(0));
    server.sweep(Date.now() + 11 * 60_000);
    expect(server.rooms.has(code)).toBe(false);
  });
});
