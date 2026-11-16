import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { calledBy, checkInvariants, endVote, finishDeal, grab, inGrace, isComplete, isHidden, legalDrops, mustClear, seatedPeople, startCountdown, viewFor, type Rng } from '../shared/engine';
import { STOCK_CARD_MS } from '../shared/protocol';
import { CLOSE_OVER, DEAL_MS, GRACE_MS, START_BEAT_MS, START_MS, isRoomCode, MAX_MESSAGE_BYTES, MAX_PLAYERS, MAX_WATCHERS, type ServerMsg } from '../shared/protocol';
import { felt, hold, inPlay, move, rig, seeded, slot, toPlay, wire, withPile, workTop } from '../shared/testkit';
import type { Card, GameState, Intent, PileRef } from '../shared/types';
import { CLOSE_FLOOD, startServer, type NertzServer } from './index';
import { Room, type Conn } from './room';
import { Client, FakeConn, opening, roomWith, send, startRound, type StateMsg } from './testkit';

// ---------------------------------------------------------------- helpers

const sendIntent = (room: Room, conn: Conn, seq: number, intent: Intent) => room.handle(conn, { t: 'intent', seq, intent });

/**
 * A deal where every player's work piles are single face-up cards: A-spades,
 * 2-spades, A-hearts and 5-diamonds (the 5 has nowhere legal to go). Dealt
 * afresh to `seats` from seed 7, whatever the room itself dealt.
 */
const rigged = (seats: number[], emptyNertz: number[] = []): GameState => rig(inPlay(seats, seeded(7)), { work: ['S1', 'S2', 'H1', 'D5'], emptyNertz });
const filled = (g: GameState) => g.slots.flatMap((pile) => (pile ? [pile.cards.map((c) => c.id)] : []));

/** What a bot does next, given its (possibly stale) view: a mix of legal moves, drags, flips, wrong moves and nonsense. */
function botIntent(view: GameState, seat: number, rnd: Rng): Intent {
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
  const me = view.players.find((p) => p.seat === seat)!;
  const mine = [...me.nertz.slice(-1), ...me.waste.slice(-1), ...me.work.flat()];
  const roll = rnd();
  if (roll < 0.45) {
    const legal = mine.flatMap((c) => legalDrops(view, seat, c.id).map((to) => move(c.id, to, grab(view, seat, c.id)!.cards.length)));
    // Prefer the middle so the shared piles are genuinely contended.
    const toCentre = legal.filter((m) => m.k === 'move' && m.to.k !== 'work');
    if (legal.length > 0) return pick(toCentre.length > 0 && rnd() < 0.8 ? toCentre : legal);
    return { k: 'flip' };
  }
  if (roll < 0.65) return { k: 'flip' };
  if (roll < 0.7) return { k: 'stuck', on: rnd() < 0.5 };
  if (roll < 0.72) return me.nertz.length > 0 ? { k: 'nertz' } : { k: 'flip' };
  if (roll < 0.8) return mine.length > 0 ? hold(pick(mine).id) : { k: 'release' };
  if (roll < 0.85) return { k: 'release' };
  if (roll < 0.9) {
    const full = view.slots.flatMap((pile, i) => (pile && isComplete(pile.cards) ? [i] : []));
    return { k: 'clear', slot: full.length > 0 ? pick(full) : Math.floor(rnd() * 24) };
  }
  // Anyone's card, anywhere, to anywhere: almost always illegal.
  const everything = [...view.players.flatMap((p) => [...p.nertz, ...p.waste, ...p.stock, ...p.work.flat()]), ...view.slots.flatMap((pile) => pile?.cards ?? []), ...view.tray.flat()];
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
    room.join(b, 'Bea', 'tok-bbbb', true);
    room.handle(b, { t: 'start' });
    expect(room.phase).toBe('lobby'); // not the host
    room.handle(conns[0]!, { t: 'start' });
    room.flush();
    expect(room.phase).toBe('playing');
    const view = b.last.room;
    expect(view).toMatchObject({ code: 'TEST', phase: 'playing', round: 1, me: 1, seat: 1 });
    expect(view.players.map((p) => [p.seat, p.name, p.isHost, p.connected])).toEqual([[0, 'P0', true, true], [1, 'Bea', false, true]]);
    expect(view.game).toEqual(wire(viewFor(room.game!, 1)));
    expect(checkInvariants(room.game!)).toBeNull();
    expect(JSON.stringify(b.states) + JSON.stringify(conns[0]!.states)).not.toMatch(/tok-/);
  });

  it('counts a snipe: beaten to a pile by the very card one was about to play there, once, and says so with the scores', () => {
    const { room, conns } = roomWith(2);
    const [a, b] = conns as [FakeConn, FakeConn];
    room.handle(a, { t: 'start' });
    room.game = rigged([0, 1], [0]);
    const [aceA, aceB, twoA, twoB] = [workTop(room.game, 0, 0), workTop(room.game, 1, 0), workTop(room.game, 0, 1), workTop(room.game, 1, 1)]; // spades
    sendIntent(room, a, 0, move(aceA, felt(0, 0)));
    sendIntent(room, b, 0, move(aceB, felt(0, 0))); // an Ace beaten to a place is no snipe: it has others
    sendIntent(room, a, 1, move(twoA, slot(0)));
    sendIntent(room, b, 1, move(twoB, slot(0))); // too late: a's two is on it
    room.handle(b, { t: 'tried', card: twoB, slot: 0, seen: aceA }); // and their window had refused it too: counted once
    room.handle(a, { t: 'tried', card: twoA, slot: 0, seen: aceA }); // (theirs is on the pile)
    expect(send(room, b, { t: 'sniped', slot: 0 })).toBe(true); // a window from before: taken, and nothing comes of it
    sendIntent(room, a, 2, { k: 'nertz' });
    expect(room.phase).toBe('results');
    expect(room.lastRound!.snipes).toEqual([{ by: 0, of: 1, n: 1 }]);
    expect(b.of('error')).toEqual([]);
  });

  it('tells everyone in the room of a snipe, once: the one who did it, the one it was done to, and whoever watches', () => {
    const { room, conns } = roomWith(2);
    const [a, b] = conns as [FakeConn, FakeConn];
    const c = new FakeConn();
    room.join(c, 'Cy', 'tok-cccc'); // only watching
    room.handle(a, { t: 'start' });
    room.game = rigged([0, 1], [0]);
    const [aceA, twoA, twoB] = [workTop(room.game, 0, 0), workTop(room.game, 0, 1), workTop(room.game, 1, 1)];
    sendIntent(room, a, 0, move(aceA, felt(0, 0)));
    sendIntent(room, b, 0, hold(twoB)); // b takes their two up while the Ace is the top
    sendIntent(room, a, 1, move(twoA, slot(0)));
    // b's window sees a's two arrive, and refuses b's own drop there; it tells the server what it tried.
    room.handle(b, { t: 'tried', card: twoB, slot: 0, seen: aceA });
    room.handle(b, { t: 'tried', card: twoB, slot: 0, seen: aceA }); // said again: still one
    for (const conn of [a, b, c]) {
      expect(conn.of('snipe')).toEqual([{ t: 'snipe', by: 0, of: 1, slot: 0 }]);
      expect(conn.lines.filter((l) => l.k === 'sniped')).toMatchObject([{ k: 'sniped', by: { who: 0, name: 'P0' }, of: { who: 1, name: 'P1' } }]);
    }
  });

  it('a card let go where it never had a race to lose is no snipe', () => {
    const { room, conns } = roomWith(2);
    const [a, b] = conns as [FakeConn, FakeConn];
    room.handle(a, { t: 'start' });
    room.game = rigged([0, 1], [0]);
    const [aceA, twoA, twoB, aceHB] = [workTop(room.game, 0, 0), workTop(room.game, 0, 1), workTop(room.game, 1, 1), workTop(room.game, 1, 2)];
    sendIntent(room, a, 0, move(aceA, felt(0, 0)));
    sendIntent(room, a, 1, move(twoA, slot(0)));
    room.handle(b, { t: 'tried', card: twoB, slot: 0, seen: twoA }); // a's two lay there already when b took theirs up
    room.handle(b, { t: 'tried', card: aceHB, slot: 0, seen: aceA }); // a card that never went there
    room.handle(b, { t: 'tried', card: twoB, slot: 0, seen: 'no such card' });
    room.handle(b, { t: 'tried', card: twoB, slot: 1, seen: aceA }); // no pile there
    expect([...a.of('snipe'), ...b.of('snipe')]).toEqual([]);
    sendIntent(room, a, 2, { k: 'nertz' });
    expect(room.lastRound!.snipes).toBeUndefined();
  });

  it('with text chat switched off a snipe still flashes for everyone, and there is no line of it where the chat is', () => {
    const { room, conns } = roomWith(2);
    const [a, b] = conns as [FakeConn, FakeConn];
    room.handle(a, { t: 'social', text: false });
    room.handle(a, { t: 'start' });
    room.game = rigged([0, 1], [0]);
    const [aceA, twoA, twoB] = [workTop(room.game, 0, 0), workTop(room.game, 0, 1), workTop(room.game, 1, 1)];
    sendIntent(room, a, 0, move(aceA, felt(0, 0)));
    sendIntent(room, a, 1, move(twoA, slot(0)));
    sendIntent(room, b, 0, move(twoB, slot(0))); // too late
    for (const conn of [a, b]) {
      expect(conn.of('snipe')).toEqual([{ t: 'snipe', by: 0, of: 1, slot: 0 }]);
      expect(conn.lines.filter((l) => l.k === 'sniped')).toEqual([]);
    }
  });

  it('tells the table where the chat is of a round started, of how it went with the score sheet\'s numbers, and of the table started over', () => {
    const { room, conns } = roomWith(2);
    const [a, b] = conns as [FakeConn, FakeConn];
    const got: ServerMsg[] = [];
    room.join({ send: (m) => void got.push(wire(m)), close: () => {} }, 'Cy', 'tok-cccc'); // only watching
    const told = (msgs: ServerMsg[], history = false) => msgs.flatMap((m) => (m.t === 'chat' && m.history === history ? m.lines.map(({ id: _, at: __, ...l }) => l) : []));
    vi.useFakeTimers();
    room.handle(a, { t: 'start' });
    expect(told(got)).toEqual([]); // dealt, not started: nothing is told yet
    opening(room, a); // "...NERTZ!": play opens
    const first = room.game;
    room.handle(a, { t: 'redeal' }); // dealt over and started anew: the same round, not told again
    expect(room.game).not.toBe(first);
    opening(room, a);
    expect(told(got).filter((l) => l.k === 'started')).toEqual([{ k: 'started', round: 1 }]);
    room.game = rigged([0, 1], [0, 1]);
    sendIntent(room, a, 0, move(workTop(room.game, 0, 0), felt(-0.6, 0)));
    sendIntent(room, a, 1, move(workTop(room.game, 0, 1), slot(0)));
    sendIntent(room, b, 0, move(workTop(room.game, 1, 0), felt(0.6, 0)));
    sendIntent(room, b, 1, move(workTop(room.game, 1, 1), slot(1)));
    sendIntent(room, b, 2, move(workTop(room.game, 1, 2), felt(1.5, 0)));
    sendIntent(room, a, 2, { k: 'nertz' }); // called by a, with fewer cards played than b
    expect(room.phase).toBe('results');
    expect(room.lastRound!.scores.map((s) => s.delta)).toEqual([2, 3]);
    room.handle(a, { t: 'reset' });
    const lines = [
      { k: 'started', round: 1 },
      { k: 'over', round: 1, end: { who: 0, name: 'P0', points: 2 }, best: [{ who: 1, name: 'P1', points: 3 }] },
      { k: 'reset', by: { who: 0, name: 'P0' } },
    ];
    expect(told(got)).toEqual(lines);
    // Kept with what was said, for whoever comes later.
    const late: ServerMsg[] = [];
    room.join({ send: (m) => void late.push(wire(m)), close: () => {} }, 'Di', 'tok-dddd');
    expect(told(late, true)).toEqual(lines);
    // With text chat switched off there is nowhere to read them: neither told nor kept.
    room.handle(a, { t: 'social', text: false });
    room.handle(a, { t: 'start' });
    opening(room, a);
    expect(told(got)).toEqual(lines);
    const later: ServerMsg[] = [];
    room.join({ send: (m) => void later.push(wire(m)), close: () => {} }, 'Ed', 'tok-eeee');
    expect(told(later, true)).toEqual(lines);
    room.close();
  });

  // ---- who is where: at the table, in the queue for a seat, or just watching

  /** Everyone in the room as one window sees them: `name@seat`, or `name:q` in the queue, or `name:w` just watching. */
  const whereAll = (room: Room, conn: FakeConn) => (room.flush(), conn.last.room.players.map((p) => `${p.name}${p.seat !== null ? `@${p.seat}` : p.queued ? ':q' : ':w'}`));
  const sitDown = (room: Room, conn: Conn, id?: number) => room.handle(conn, { t: 'sit', on: true, ...(id === undefined ? {} : { id }) });
  const standUp = (room: Room, conn: Conn, id?: number) => room.handle(conn, { t: 'sit', on: false, ...(id === undefined ? {} : { id }) });

  it('whoever comes to a table watches until they ask for a seat; whoever opens it sits down', () => {
    const { room } = roomWith(0);
    const [a, b, c] = [new FakeConn(), new FakeConn(), new FakeConn()];
    room.join(a, 'A', 'tok-aaaa', true); // (as the server does for `create`)
    room.join(b, 'B', 'tok-bbbb');
    room.join(c, 'C', 'tok-cccc');
    expect(whereAll(room, a)).toEqual(['A@0', 'B:w', 'C:w']);
    expect(b.last.room).toMatchObject({ me: 1, seat: null });
    room.handle(a, { t: 'start' }); // nobody to deal to: those watching are not players
    expect(room.phase).toBe('lobby');
    sitDown(room, b);
    expect(whereAll(room, a)).toEqual(['A@0', 'B@1', 'C:w']);
    expect(b.last.room).toMatchObject({ me: 1, seat: 1 });
    room.handle(c, { t: 'seat', seat: 4 }); // a seat is not to be had by asking for a colour
    room.handle(c, { t: 'start' }); // nor is the table theirs to deal
    expect(whereAll(room, a)).toEqual(['A@0', 'B@1', 'C:w']);
    startRound(room, a);
    expect(room.game!.players.map((p) => p.seat)).toEqual([0, 1]);
    room.flush();
    expect(c.last.room.game).not.toBeNull(); // but they see the round
    // Asking while a round is played: in the queue, and seated when it is over. And one can think again.
    sitDown(room, c);
    expect(whereAll(room, a)).toEqual(['A@0', 'B@1', 'C:q']);
    standUp(room, c);
    expect(whereAll(room, a)).toEqual(['A@0', 'B@1', 'C:w']);
    sitDown(room, c);
    room.game = rigged([0, 1], [0]);
    sendIntent(room, a, 0, { k: 'nertz' });
    expect(whereAll(room, a)).toEqual(['A@0', 'B@1', 'C@2']);
    room.handle(a, { t: 'start' });
    expect(room.game!.players.map((p) => p.seat)).toEqual([0, 1, 2]);
  });

  it('nobody takes a seat by typing the name of someone who is away: who one is goes by the token alone', () => {
    const { room, conns } = roomWith(2);
    const [a, b] = conns as [FakeConn, FakeConn];
    startRound(room, a);
    room.disconnect(b);
    const other = new FakeConn();
    room.join(other, 'P1', 'tok-other', true);
    expect(whereAll(room, a)).toEqual(['P0@0', 'P1@1', 'P1:q']); // a stranger of the same name, waiting like anyone
    expect(other.last.room).toMatchObject({ me: 2, seat: null });
    expect(a.last.room.players.map((p) => p.connected)).toEqual([true, false, true]);
    const back = new FakeConn();
    room.join(back, 'P1', 'tok-0001'); // the token is what brings one back
    room.flush();
    expect(back.last.room).toMatchObject({ me: 1, seat: 1 });
  });

  it('lets an eleventh wait for a seat: no cards, no deal of their own; and the room has an end too', () => {
    const { room, conns } = roomWith(MAX_PLAYERS);
    const late = new FakeConn();
    expect(room.join(late, 'Late', 'tok-late', true)).toBeNull();
    room.flush();
    expect(late.last.room).toMatchObject({ me: MAX_PLAYERS, seat: null });
    expect(late.last.room.players.at(-1)).toMatchObject({ name: 'Late', seat: null, queued: true, isHost: false });
    expect(late.last.room.players.filter((p) => p.seat === null)).toHaveLength(1);
    room.handle(late, { t: 'start' }); // not theirs to deal
    expect(room.phase).toBe('lobby');
    room.handle(conns[0]!, { t: 'start' });
    expect(room.game!.players.map((p) => p.seat)).toEqual(Array.from({ length: MAX_PLAYERS }, (_, i) => i)); // the ten, not the eleventh
    room.flush();
    expect(late.last.room.game).not.toBeNull(); // but they see the round
    const more = Array.from({ length: MAX_WATCHERS - 1 }, () => new FakeConn());
    more.forEach((c, i) => expect(room.join(c, `W${i}`, `tok-w${String(i).padStart(3, '0')}`)).toBeNull());
    expect(room.join(new FakeConn(), 'Too many', 'tok-many')).toMatch(/full/);
    // (Unless someone without a seat is long gone: their place is the newcomer's.)
    room.disconnect(more[3]!);
    expect(room.join(new FakeConn(), 'One more', 'tok-more')).toBeNull();
    expect(room.join(new FakeConn(), 'Too many', 'tok-many')).toMatch(/full/);
  });

  it('lets those watching into the chat and into voice, unless whoever hosts says not: and then out of voice on standing up', () => {
    const { room, conns } = roomWith(MAX_PLAYERS);
    const got: ServerMsg[] = [];
    const w: Conn = { send: (m) => void got.push(wire(m)), close: () => {} };
    room.join(w, 'Watcher', 'tok-watch');
    const said = () => got.flatMap((m) => (m.t === 'chat' && !m.history ? m.lines.flatMap((l) => (l.k === 'said' ? [l.text] : [])) : []));
    const inVoice = () => (got.filter((m) => m.t === 'social').at(-1) as Extract<ServerMsg, { t: 'social' }>).inVoice.map((v) => v.id);
    room.handle(w, { t: 'chat', text: 'hello' });
    room.handle(w, { t: 'voice', on: true, muted: false });
    room.handle(conns[2]!, { t: 'voice', on: true, muted: false });
    expect(said()).toEqual(['hello']);
    expect(inVoice()).toEqual([MAX_PLAYERS, 2]);
    // (Standing up changes nothing about who one is: still in voice, where those watching may be.)
    standUp(room, conns[2]!);
    expect(inVoice()).toEqual([MAX_PLAYERS, 2]);
    sitDown(room, conns[2]!);
    room.handle(w, { t: 'social', watchText: false }); // not theirs to switch
    room.handle(w, { t: 'chat', text: 'still here' });
    expect(said()).toEqual(['hello', 'still here']);
    room.handle(conns[0]!, { t: 'social', watchText: false, watchVoice: false });
    expect(inVoice()).toEqual([2]); // put out of voice at once, and told so
    expect(got.filter((m) => m.t === 'outOfVoice')).toHaveLength(1);
    expect(conns.flatMap((c) => c.of('outOfVoice'))).toEqual([]);
    expect(got.filter((m) => m.t === 'social').at(-1)).toMatchObject({ text: true, voice: true, watchText: false, watchVoice: false });
    room.handle(w, { t: 'chat', text: 'anyone?' });
    room.handle(w, { t: 'voice', on: true, muted: false });
    expect(got.at(-1)).toEqual({ t: 'outOfVoice' }); // refused, and told so
    room.handle(conns[1]!, { t: 'chat', text: 'seated people still can' });
    expect(said()).toEqual(['hello', 'still here', 'seated people still can']);
    expect(inVoice()).toEqual([2]);
    standUp(room, conns[2]!); // and whoever stands up is one of those watching
    expect(inVoice()).toEqual([]);
    expect(conns[2]!.of('outOfVoice')).toHaveLength(1);
  });

  it('someone sent away is gone at once, also from the score sheet; someone who stands up watches until they ask for a seat again', () => {
    const { room, conns } = roomWith(3);
    const [a, b, c] = conns as [FakeConn, FakeConn, FakeConn];
    standUp(room, c);
    expect(whereAll(room, a)).toEqual(['P0@0', 'P1@1', 'P2:w']);
    room.handle(a, { t: 'start' });
    expect(room.game!.players.map((p) => p.seat)).toEqual([0, 1]); // not dealt in, though seats are free
    room.game = rigged([0, 1], [0]);
    sendIntent(room, a, 0, { k: 'nertz' });
    expect(whereAll(room, a)).toEqual(['P0@0', 'P1@1', 'P2:w']); // nor seated when the round ends: they chose to watch
    sitDown(room, b, 2); // not theirs to seat
    expect(whereAll(room, a)).toEqual(['P0@0', 'P1@1', 'P2:w']);
    sitDown(room, c);
    expect(whereAll(room, a)).toEqual(['P0@0', 'P1@1', 'P2@2']);
    standUp(room, a, 1); // whoever deals stands someone up
    expect(whereAll(room, a)).toEqual(['P0@0', 'P2@2', 'P1:w']);
    sitDown(room, a, 1); // and seats them again: in the seat they had
    expect(whereAll(room, a)).toEqual(['P0@0', 'P1@1', 'P2@2']);
    room.handle(a, { t: 'kick', id: 1 }); // on the score sheet: gone, not "away, in next round"
    expect(whereAll(room, a)).toEqual(['P0@0', 'P2@2']);
    expect(a.last.room.lastRound!.scores.map((l) => [l.id, !!l.gone])).toEqual([[0, false], [1, true]]); // prettier-ignore
    expect(b.closed).toBe(true);
    room.handle(a, { t: 'kick', id: 0 }); // (not oneself)
    expect(whereAll(room, a)).toEqual(['P0@0', 'P2@2']);
  });

  it('gives a seat that comes free to the first in the queue, in the order they asked; and not to someone who is away', () => {
    const { room, conns } = roomWith(MAX_PLAYERS);
    const [a, b, c, d] = [new FakeConn(), new FakeConn(), new FakeConn(), new FakeConn()];
    const at = (name: string) => (room.flush(), conns[0]!.last.room.players.find((p) => p.name === name)!.seat);
    const waiting = () => (room.flush(), conns[0]!.last.room.players.filter((p) => p.queued).map((p) => p.name));
    room.join(a, 'A', 'tok-aaaa');
    room.join(b, 'B', 'tok-bbbb');
    room.join(c, 'C', 'tok-cccc');
    room.join(d, 'D', 'tok-dddd');
    sitDown(room, b); // B asks before A does: it is the asking that counts, not the coming
    sitDown(room, a);
    sitDown(room, c);
    expect(waiting()).toEqual(['B', 'A', 'C']);
    room.handle(conns[3]!, { t: 'leave' });
    expect(at('B')).toBe(3); // in the lobby at once: the seat that came free, and its colour
    expect(waiting()).toEqual(['A', 'C']);
    // A's window goes: the next seat is not theirs while they are away, and they keep their place for when they are back.
    room.disconnect(a);
    room.handle(conns[4]!, { t: 'leave' });
    expect(at('C')).toBe(4);
    expect(waiting()).toEqual(['A']);
    room.handle(conns[5]!, { t: 'leave' });
    expect(at('A')).toBeNull();
    room.join(new FakeConn(), 'A', 'tok-aaaa');
    expect(at('A')).toBe(5);
    expect(at('D')).toBeNull(); // (and whoever never asked has none, however many are free)
    room.handle(conns[0]!, { t: 'start' });
    expect(room.game!.players.map((p) => p.seat)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('deals in whoever sits down after the deal but before Start; and deals nothing over to one player and someone watching', () => {
    const { room, conns } = roomWith(3);
    const [a, b, c] = conns as [FakeConn, FakeConn, FakeConn];
    standUp(room, c);
    room.handle(a, { t: 'start' });
    expect(room.game!.players.map((p) => p.seat)).toEqual([0, 1]);
    sitDown(room, c); // the cards are dealt, nothing is played: dealt again with them
    expect(room.game!.players.map((p) => p.seat)).toEqual([0, 1, 2]);
    expect(room.game!.status.at).toBe('dealing');
    standUp(room, c); // (not out of a round they hold cards in: so, on the next score sheet)
    expect(whereAll(room, a)).toEqual(['P0@0', 'P1@1', 'P2@2']);
    room.game = rigged([0, 1, 2], [0]);
    sendIntent(room, a, 0, { k: 'nertz' });
    standUp(room, c);
    startRound(room, a);
    room.disconnect(b);
    const before = room.game;
    room.handle(a, { t: 'redeal' }); // one at the table and one watching by choice: not a round
    expect(room.game).toBe(before);
    // Whoever sat down while nobody dealt in was here is dealt in when one of them is back.
    room.disconnect(a);
    sitDown(room, c); // mid-round: waits
    room.join(b, 'P1', 'tok-0001');
    room.game = rigged([0, 1], [1]);
    sendIntent(room, b, 0, { k: 'nertz' });
    room.handle(b, { t: 'start' }); // (the dealer while the host is away)
    room.disconnect(b);
    room.disconnect(c);
    const d = new FakeConn();
    room.join(d, 'D', 'tok-dddd', true); // alone at the table: not dealt to
    expect(room.game!.players.map((p) => p.seat)).toEqual([1, 2]);
    room.join(b, 'P1', 'tok-0001');
    expect(room.game!.players.map((p) => p.seat)).toEqual([1, 3]);
  });

  it('a line of the score sheet is its player\'s, not its seat\'s: whoever has the seat next is not shown as them, and they are back in it if it is free', () => {
    const { room, conns } = roomWith(MAX_PLAYERS);
    const all = Array.from({ length: MAX_PLAYERS }, (_, i) => i);
    const w = new FakeConn();
    room.join(w, 'W', 'tok-wwww', true);
    startRound(room, conns[0]!);
    room.game = rigged(all, [0]);
    sendIntent(room, conns[0]!, 0, { k: 'nertz' });
    standUp(room, conns[3]!);
    room.flush();
    expect(w.last.room).toMatchObject({ me: MAX_PLAYERS, seat: 3 });
    expect(w.last.room.lastRound!.scores.find((s) => s.seat === 3)).toMatchObject({ id: 3, name: 'P3' }); // still on the sheet, as P3's
    expect(w.last.room.lastRound!.scores.find((s) => s.seat === 3)).not.toHaveProperty('gone');
    expect(w.last.room.lastRound!.scores.some((s) => s.id === MAX_PLAYERS)).toBe(false);
    // (Up and straight down again: into the same seat.)
    standUp(room, conns[5]!);
    sitDown(room, conns[5]!);
    room.flush();
    expect(w.last.room.players.find((p) => p.name === 'P5')).toMatchObject({ seat: 5 });
    // (Also when a lower seat is free: P8 is sent away, P9 stands up and sits down, and has seat 9 again, not 8.)
    room.handle(conns[8]!, { t: 'kick', id: 3 }); // not theirs to send away
    room.handle(conns[0]!, { t: 'kick', id: 8 });
    standUp(room, conns[9]!);
    sitDown(room, conns[9]!);
    room.flush();
    expect(w.last.room.players.find((p) => p.name === 'P9')).toMatchObject({ seat: 9 });
    // P3, whose seat W has: the lowest that is free.
    sitDown(room, conns[3]!);
    room.flush();
    expect(w.last.room.players.find((p) => p.name === 'P3')).toMatchObject({ seat: 8 });
  });

  it('someone sent away while their cards are in a round is gone when it ends: off the sheet, not back by their token, the table handed on', () => {
    const { room, conns } = roomWith(3);
    const [a, b, c] = conns as [FakeConn, FakeConn, FakeConn];
    startRound(room, a);
    room.disconnect(a); // the host is away: B deals, and sends the host away
    room.handle(b, { t: 'kick', id: 0 });
    expect(room.game!.players.map((p) => p.seat)).toEqual([0, 1, 2]); // the cards stay for the round
    const back = new FakeConn();
    room.join(back, 'P0', 'tok-0000', true); // not back into them: a stranger, waiting for a seat
    room.flush();
    expect(back.last.room).toMatchObject({ me: 3, seat: null });
    room.handle(back, { t: 'leave' });
    room.game = rigged([0, 1, 2], [1]);
    sendIntent(room, b, 0, { k: 'nertz' });
    room.flush();
    expect(room.phase).toBe('results');
    expect(c.last.room.players.map((p) => p.name)).toEqual(['P1', 'P2']);
    expect(c.last.room.lastRound!.scores.find((s) => s.seat === 0)).toMatchObject({ gone: true });
    expect(c.last.room.players.find((p) => p.isHost)).toMatchObject({ name: 'P1' });
    room.disconnect(b); // and the table is P1's for good: C deals only while they are away
    room.flush();
    expect(c.last.room.players.find((p) => p.isHost)).toMatchObject({ name: 'P2' });
    room.join(b, 'P1', 'tok-0001');
    room.flush();
    expect(c.last.room.players.find((p) => p.isHost)).toMatchObject({ name: 'P1' });
  });

  it('whoever leaves in the middle of a round holds the seat until it is over, and may come back into their cards; after it they are gone, their line staying', () => {
    const { room, conns } = roomWith(3);
    const [a, b, c] = conns as [FakeConn, FakeConn, FakeConn];
    const late = new FakeConn();
    startRound(room, a);
    room.handle(c, { t: 'leave' });
    room.join(late, 'Late', 'tok-late', true);
    expect(whereAll(room, a)).toEqual(['P0@0', 'P1@1', 'P2@2', 'Late:q']); // listed (away) while their cards lie there
    const again = new FakeConn();
    room.join(again, 'P2', 'tok-0002'); // back, by their token: into the same cards
    room.flush();
    expect(again.last.room).toMatchObject({ me: 2, seat: 2 });
    room.handle(again, { t: 'leave' });
    room.game = rigged([0, 1, 2], [0]);
    sendIntent(room, a, 0, { k: 'nertz' });
    expect(whereAll(room, a)).toEqual(['P0@0', 'P1@1', 'Late@2']); // the round is over: gone, and the seat is the next one's
    expect(a.last.room.lastRound!.scores.find((s) => s.seat === 2)).toMatchObject({ id: 2, name: 'P2', delta: -26, total: -26 });
    expect(a.last.room.lastRound!.scores.find((s) => s.seat === 2)).not.toHaveProperty('gone');
    // On the score sheet there is nothing to wait for: whoever leaves is off the list at once.
    room.handle(b, { t: 'leave' });
    expect(whereAll(room, a)).toEqual(['P0@0', 'Late@2']);
    expect(a.last.room.lastRound!.scores.map((s) => s.name)).toEqual(['P0', 'P1', 'P2']);
    room.handle(a, { t: 'start' });
    expect(room.game!.players.map((p) => p.seat)).toEqual([0, 2]);
    expect(checkInvariants(room.game!)).toBeNull();
  });

  it('a host who stands up still hosts, unless they hand the table on: to a person at it, who has it for good', () => {
    const { room, conns } = roomWith(3);
    const [a, b, c] = conns as [FakeConn, FakeConn, FakeConn];
    const host = () => (room.flush(), c.last.room.players.find((p) => p.isHost)!.name);
    room.handle(a, { t: 'addBot', level: 'slow' }); // (id 3)
    standUp(room, a);
    expect(host()).toBe('P0'); // watching, and still the one who deals
    room.handle(a, { t: 'start' });
    expect(room.game!.players.map((p) => p.seat)).toEqual([1, 2, 3]);
    room.game = rigged([1, 2, 3], [1]);
    sendIntent(room, b, 0, { k: 'nertz' });
    room.handle(b, { t: 'host', id: 1 }); // not theirs to hand on
    room.handle(a, { t: 'host', id: 3 }); // not to a bot
    room.handle(a, { t: 'host', id: 9 }); // nor to nobody
    expect(host()).toBe('P0');
    room.handle(a, { t: 'host', id: 2 });
    expect(host()).toBe('P2');
    room.handle(a, { t: 'start' }); // no longer theirs
    expect(room.phase).toBe('results');
    room.disconnect(c); // while the host is away the first at the table who is here deals; and it is theirs again when they are back
    room.flush();
    expect(b.last.room.players.find((p) => p.isHost)!.name).toBe('P1');
    room.join(c, 'P2', 'tok-0002');
    expect(host()).toBe('P2');
    standUp(room, c);
    room.handle(c, { t: 'host', id: 0 }); // (P0 has no seat: not to someone watching)
    expect(host()).toBe('P2');
  });

  it('lists those at the table, then the queue in the order it will be seated, then those just watching; and moves nobody when a deal over is refused', () => {
    const { room, conns } = roomWith(MAX_PLAYERS);
    const [a, b] = [new FakeConn(), new FakeConn()];
    const seatless = () => (room.flush(), conns[1]!.last.room.players.filter((p) => p.seat === null).map((p) => `${p.name}${p.queued ? ':q' : ':w'}`));
    standUp(room, conns[9]!);
    room.join(a, 'A', 'tok-aaaa', true); // (takes P9's seat)
    room.join(b, 'B', 'tok-bbbb', true);
    expect(seatless()).toEqual(['B:q', 'P9:w']); // P9 came first, but is not waiting
    sitDown(room, conns[9]!);
    expect(seatless()).toEqual(['B:q', 'P9:q']); // and now waits behind B
    // A round with only two of them here; one goes; the dealer's deal over is refused, and B stays where they are.
    for (const c of conns.slice(2, 9)) room.disconnect(c);
    room.disconnect(a);
    startRound(room, conns[0]!);
    room.disconnect(conns[1]!);
    room.disconnect(b);
    const before = room.game;
    room.handle(conns[0]!, { t: 'redeal' });
    expect(room.game).toBe(before);
    room.join(b, 'B', 'tok-bbbb');
    room.flush();
    expect(b.last.room.seat).toBeNull();
  });

  it('coalesces a burst into one snapshot per player, and tells only the sender about a rejection', () => {
    const { room, conns } = roomWith(2);
    const [a, b] = conns as [FakeConn, FakeConn];
    startRound(room, a);
    room.flush();
    const [sentA, sentB, rev] = [a.states.length, b.states.length, room.rev];

    for (let seq = 0; seq < 5; seq++) sendIntent(room, a, seq, { k: 'flip' });
    room.flush();
    expect(a.states.length).toBe(sentA + 1);
    expect(b.states.length).toBe(sentB + 1);
    expect(a.last).toMatchObject({ ack: 4, rev: rev + 5 });
    expect(b.last).toMatchObject({ ack: -1, rev: rev + 5 });
    expect(a.last.room.game!.players[0]!).toMatchObject({ waste: { length: 5 }, dealt: 2 }); // one card per intent

    const before = room.game;
    sendIntent(room, a, 5, move('no-such-card', { k: 'work', i: 0 }));
    sendIntent(room, a, 5, { k: 'flip' }); // replayed seq: ignored
    sendIntent(room, a, 3, { k: 'flip' }); // stale seq: ignored
    room.flush();
    expect(room.game).toBe(before);
    expect(a.states.length).toBe(sentA + 2);
    expect(a.last).toMatchObject({ ack: 5, rev: rev + 6 });
    expect(b.states.length).toBe(sentB + 1); // nothing changed for b
  });

  it('linearises a race for one pile: first arrival lands, the loser is rejected and its card stays put', () => {
    const { room, conns } = roomWith(2);
    const [a, b] = conns as [FakeConn, FakeConn];
    room.handle(a, { t: 'start' });
    room.game = rigged([0, 1]);
    const [aceA, aceB] = [workTop(room.game, 0, 0), workTop(room.game, 1, 0)];
    sendIntent(room, a, 0, move(aceA, felt(-0.5, 0)));
    sendIntent(room, b, 0, move(aceB, felt(0.5, 0)));
    // Both players aim their 2 of spades at a's ace before either has heard about the other.
    const [twoA, twoB] = [workTop(room.game, 0, 1), workTop(room.game, 1, 1)];
    sendIntent(room, b, 1, move(twoB, slot(0)));
    sendIntent(room, a, 1, move(twoA, slot(0)));
    room.flush();
    // No fallback: a's 2 would fit b's ace in slot 1, but it was dropped on slot 0, so it goes home.
    expect(room.game.slots[0]!.cards.map((c) => c.id)).toEqual([aceA, twoB]);
    expect(room.game.slots[1]!.cards.map((c) => c.id)).toEqual([aceB]);
    expect(filled(room.game)).toHaveLength(2);
    expect(workTop(room.game, 0, 1)).toBe(twoA); // a's card never left its pile
    expect(a.last.ack).toBe(1);
    expect(b.last.ack).toBe(1);
    expect(a.last.room.game).toEqual(b.last.room.game);
    expect(checkInvariants(room.game)).toBeNull();
  });

  it('linearises two aces racing for one patch of felt: first wins, the other returns', () => {
    const { room, conns } = roomWith(2);
    const [a, b] = conns as [FakeConn, FakeConn];
    room.handle(a, { t: 'start' });
    room.game = rigged([0, 1]);
    const [aceA, aceB] = [workTop(room.game, 0, 2), workTop(room.game, 1, 2)]; // both hearts
    sendIntent(room, b, 0, move(aceB, felt(0, 0)));
    sendIntent(room, a, 0, move(aceA, felt(0, 0)));
    room.flush();
    expect(filled(room.game)).toEqual([[aceB]]);
    expect(workTop(room.game, 0, 2)).toBe(aceA);
    expect([a.last.ack, b.last.ack]).toEqual([0, 0]);
    sendIntent(room, a, 1, move(aceA, felt(0.6, 0))); // a deliberate second drop on clear felt is fine
    expect(room.game.slots.slice(0, 2).map((pile) => pile!.cards.map((c) => c.id))).toEqual([[aceB], [aceA]]);
    expect(checkInvariants(room.game)).toBeNull();
  });

  it('resumes the same seat and hand on reconnect, seats a stranger mid-round only to watch, and lets the newest socket win', () => {
    const { room, conns } = roomWith(2);
    const [a, b] = conns as [FakeConn, FakeConn];
    startRound(room, a);
    sendIntent(room, b, 9, { k: 'flip' });
    room.flush();
    const hand = b.last.room.game;

    room.disconnect(b);
    room.flush();
    expect(a.last.room.players[1]).toMatchObject({ seat: 1, connected: false });
    // A stranger who arrives in the middle of the round watches it: no seat yet (a place in the queue), and no cards.
    const stranger = new FakeConn();
    expect(room.join(stranger, 'Stranger', 'tok-zzzz', true)).toBeNull();
    room.flush();
    expect(stranger.last.room).toMatchObject({ me: 2, seat: null, phase: 'playing' });
    expect(stranger.last.room.game!.players.map((p) => p.seat)).toEqual([0, 1]);
    expect(stranger.last.room.players[2]).toMatchObject({ name: 'Stranger', score: 0, rounds: 0, seat: null, queued: true });
    room.handle(stranger, { t: 'intent', seq: 0, intent: { k: 'flip' } });
    room.flush();
    expect(room.game!.players.map((p) => p.seat)).toEqual([0, 1]);

    const b2 = new FakeConn();
    expect(room.join(b2, 'P1 again', 'tok-0001', true)).toBeNull();
    room.flush();
    expect(b2.last.room).toMatchObject({ me: 1, seat: 1, phase: 'playing' });
    expect(b2.last.room.game).toEqual(hand);
    expect(b2.last.ack).toBe(-1); // seq numbering is per connection
    expect(a.last.room.players[1]).toMatchObject({ name: 'P1 again', connected: true });

    const b3 = new FakeConn(); // a second tab with the same token takes the seat over
    room.join(b3, 'P1', 'tok-0001', true);
    expect(b2.closed).toBe(true);
    const rev = room.rev;
    sendIntent(room, b2, 0, { k: 'flip' }); // the replaced socket no longer speaks for the seat
    room.disconnect(b2);
    expect(room.rev).toBe(rev);
    expect(room.connected).toBe(3); // a, b and the stranger watching
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
    room.join(d, 'Dee', 'tok-dddd', true);
    room.flush();
    expect(d.last.room.seat).toBe(1); // the freed seat is reused
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
    room.join(a2, 'P0', 'tok-0000', true);
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
    vi.useFakeTimers();
    room.handle(a, { t: 'start' });
    expect(room.game!.players.map((p) => p.seat)).toEqual([0, 1]);
    vi.advanceTimersByTime(DEAL_MS);
    room.handle(a, { t: 'go' }); // "1, 2, 3": from here on whoever comes is too late for this round
    // Back mid-round: seated, listed, but with no cards, and unable to act or to hold up a stuck vote.
    const c2 = new FakeConn();
    expect(room.join(c2, 'P2', 'tok-0002', true)).toBeNull();
    sendIntent(room, c2, 0, { k: 'flip' });
    room.flush();
    expect(c2.last.ack).toBe(0);
    expect(c2.last.room.seat).toBe(2);
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
    expect(c.last.room.game!.players.map((p) => p.stuck)).toEqual([true, true, false]);
    expect(room.game!.players[0]!).toMatchObject({ waste: { length: 1 }, dealt: 1 }); // a group left half-dealt

    room.disconnect(c); // the only hold-out leaves: the two who remain are both stuck
    room.flush();
    const p0 = room.game!.players[0]!;
    expect(p0.waste).toHaveLength(0);
    expect(p0.dealt).toBe(0); // the half-dealt card went back with the rest
    expect(p0.stock).toHaveLength(32); // three players: the small-table deal (on by default)
    expect(p0.stock[0]!.id).toBe(firstTop); // old top card went to the bottom
    expect(a.last.room.game!.players.map((p) => p.stuck)).toEqual([false, false, false]);
    expect(checkInvariants(room.game!)).toBeNull();
  });

  it('ends the round where it stands when every connected person votes to end it, without a caller', () => {
    const { room, conns } = roomWith(2);
    const [a, b] = conns as [FakeConn, FakeConn];
    startRound(room, a);
    sendIntent(room, a, 0, { k: 'end', on: true });
    room.flush();
    expect(room.phase).toBe('playing');
    expect(b.last.room.game!.players.map((p) => !!p.ending)).toEqual([true, false]);
    sendIntent(room, b, 0, { k: 'end', on: true });
    room.flush();
    expect(room.phase).toBe('results');
    expect(room.lastRound).toMatchObject({ end: { by: 'vote' } });
  });

  it('a round ended by vote is over on the final table like any other: no card is left in a hand, no finished pile left to clear', () => {
    const { room, conns } = roomWith(2);
    const [a, b] = conns as [FakeConn, FakeConn];
    startRound(room, a);
    room.game = withPile(rigged([0, 1]), 0, 1, 'S', 13); // seat 1 finished the spades, and has not carried them to the tray
    sendIntent(room, a, 0, hold(workTop(room.game, 0, 2)));
    sendIntent(room, a, 1, { k: 'end', on: true });
    room.flush();
    expect(b.last.room.game!.players.map((p) => p.holding)).toEqual([workTop(room.game, 0, 2), null]);
    expect(mustClear(b.last.room.game!, 1)).toBe(true);
    sendIntent(room, b, 0, { k: 'end', on: true }); // (the vote is the one thing a finished pile does not hold up)
    room.flush();
    for (const conn of [a, b]) {
      const { phase, game } = conn.last.room;
      expect([phase, game!.status]).toEqual(['results', { at: 'over', end: { by: 'vote' } }]);
      expect(game!.players.map((p) => p.holding)).toEqual([null, null]);
      expect(mustClear(game!, 1)).toBe(false);
    }
  });

  it('counts the end vote as the server does: not someone back after the deal, a bot, or someone watching', () => {
    const { room, conns } = roomWith(4);
    const [a, b, c, d] = conns as [FakeConn, FakeConn, FakeConn, FakeConn];
    room.handle(a, { t: 'addBot', level: 'slow' });
    standUp(room, d);
    room.disconnect(c);
    startRound(room, a);
    expect(room.game!.players.map((p) => p.seat)).toEqual([0, 1, 4]);
    const c2 = new FakeConn();
    expect(room.join(c2, 'P2', 'tok-0002', true)).toBeNull(); // back, at seat 2, with no cards
    const slips = () => (room.flush(), [a, b, c2, d].map((x) => endVote(x.last.room.game!, seatedPeople(x.last.room.players))));
    expect(slips()).toEqual(Array(4).fill({ voters: 2, voted: 0 }));
    sendIntent(room, a, 0, { k: 'end', on: true });
    expect(slips()).toEqual(Array(4).fill({ voters: 2, voted: 1 }));
    expect(room.phase).toBe('playing');
    sendIntent(room, b, 0, { k: 'end', on: true });
    room.flush();
    expect(room.lastRound).toMatchObject({ end: { by: 'vote' } });
  });

  it('ends the round on "Nertz!" (at once when nobody holds a card), scores it, and deals the next round without players who left', () => {
    vi.useFakeTimers();
    const { room, conns } = roomWith(3);
    const [a, b, c] = conns as [FakeConn, FakeConn, FakeConn];
    startRound(room, a);
    sendIntent(room, a, 0, { k: 'nertz' }); // 13 cards left: refused
    expect(room.phase).toBe('playing');
    room.game = rigged([0, 1, 2], [1]);
    sendIntent(room, a, 1, move(workTop(room.game, 0, 0), felt(-0.6, 0)));
    sendIntent(room, b, 0, move(workTop(room.game, 1, 0), felt(0.6, 0)));
    sendIntent(room, b, 1, move(workTop(room.game, 1, 2), felt(1.5, 0)));
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
      end: { by: 'nertz', seat: 1 },
      scores: [
        { seat: 0, id: 0, name: 'P0', played: 1, nertzLeft: 13, rounds: 1, delta: -25, total: -25 },
        { seat: 1, id: 1, name: 'P1', played: 2, nertzLeft: 0, rounds: 1, delta: 2, total: 2 }, // no bonus for going out
        { seat: 2, id: 2, name: 'P2', played: 0, nertzLeft: 13, rounds: 1, delta: -26, total: -26 },
      ],
    });
    expect(a.last.room.players.map((p) => p.score)).toEqual([-25, 2, -26]);
    // The final table stays in the snapshot for the end-of-round sequence.
    expect(a.last.room.game).toEqual(wire(viewFor(room.game!, 0)));
    expect(calledBy(a.last.room.game!)).toBe(1);
    expect(filled(a.last.room.game!)).toHaveLength(3);

    room.handle(c, { t: 'leave' });
    room.flush();
    expect(a.last.room.players).toHaveLength(2); // gone from the list at once; their line of the round stays
    expect(a.last.room.lastRound!.scores).toHaveLength(3);
    expect(filled(a.last.room.game!)).toHaveLength(3);
    const d = new FakeConn();
    expect(room.join(d, 'Dee', 'tok-dddd', true)).toBeNull(); // newcomers are welcome between rounds
    room.flush();
    expect(d.last.room.game).toEqual(a.last.room.game); // and see the finished table too
    room.handle(b, { t: 'start' }); // not the host
    expect(room.phase).toBe('results');
    room.handle(a, { t: 'start' });
    room.flush();
    expect(a.last.room).toMatchObject({ phase: 'playing', round: 2 });
    expect(a.last.room.players.map((p) => [p.seat, p.name, p.score])).toEqual([[0, 'P0', -25], [1, 'P1', 2], [2, 'Dee', 0]]);
    expect(room.game!.players.map((p) => p.seat)).toEqual([0, 1, 2]);
    expect(room.game!.slots).toHaveLength(12);
    expect(checkInvariants(room.game!)).toBeNull();
  });

  it('counts cleared piles in the tray, only lets the player who placed the King clear, and lets them do nothing else first', () => {
    const { room, conns } = roomWith(2);
    const [a, b] = conns as [FakeConn, FakeConn];
    room.handle(a, { t: 'start' });
    // Seat 1's spades, Ace to Queen, are already out in slot 0; seat 0 holds the King on a work pile.
    const g = withPile(rigged([0, 1], [0]), 0, 1, 'S', 12);
    const pile = g.slots[0]!.cards;
    const king = (g.players[0]!.stock as Card[]).find((c) => c.suit === 'S' && c.rank === 13)!;
    room.game = { ...g, players: g.players.map((p) => (p.seat === 0 ? { ...p, stock: p.stock.filter((c) => c !== king), work: [[king], ...p.work.slice(1)], waste: [p.work[0]![0]!] } : p)) };
    expect(checkInvariants(room.game)).toBeNull();
    sendIntent(room, a, 0, move(king.id, slot(0)));
    sendIntent(room, b, 0, { k: 'clear', slot: 0 }); // not theirs to clear
    expect(room.game.tray).toHaveLength(0);
    // Clear-first: until the pile is in the tray everything else from seat 0 is refused (and acked), the Nertz call included; seat 1 plays on.
    const waiting = room.game;
    const tries: Intent[] = [{ k: 'flip' }, { k: 'stuck', on: true }, hold(waiting.players[0]!.waste[0]!.id), move(waiting.players[0]!.waste[0]!.id, felt(0.8, 0)), { k: 'nertz' }];
    tries.forEach((intent, i) => sendIntent(room, a, 1 + i, intent));
    expect(room.game).toBe(waiting);
    expect(room.phase).toBe('playing');
    room.flush();
    expect(a.last.ack).toBe(tries.length);
    sendIntent(room, b, 1, { k: 'flip' });
    expect(room.game.players[1]!.waste).toHaveLength(1);
    sendIntent(room, a, 10, { k: 'clear', slot: 0 });
    room.flush();
    expect(b.last.room.game!.tray).toEqual([wire([...pile, king])]);
    expect(b.last.room.game!.slots[0]).toBeNull();
    const ace = room.game.players[0]!.waste[0]!.id;
    sendIntent(room, a, 11, move(ace, felt(0, 0))); // the freed slot, and the felt it lay on, take a new Ace
    expect(room.game.slots[0]!.cards.map((c) => c.id)).toEqual([ace]);
    sendIntent(room, a, 12, { k: 'nertz' });
    room.flush();
    expect(a.last.room.lastRound!.scores).toEqual([
      { seat: 0, id: 0, name: 'P0', played: 2, nertzLeft: 0, rounds: 1, delta: 2, total: 2 },
      { seat: 1, id: 1, name: 'P1', played: 12, nertzLeft: room.game.players[1]!.nertz.length, rounds: 1, delta: 12 - 2 * room.game.players[1]!.nertz.length, total: 12 - 2 * room.game.players[1]!.nertz.length },
    ]);
    expect(a.last.room.game!.tray).toHaveLength(1); // still there for the end-of-round sequence
    expect(checkInvariants(room.game)).toBeNull();
  });

  describe('the deal', () => {
    const faces = (msg: StateMsg) => /"suit"|"rank"/.test(JSON.stringify(msg));
    const nertzFaces = (msg: StateMsg) => msg.room.game!.players.flatMap((p) => p.nertz).filter((c) => !isHidden(c)).length;
    const cardIds = (g: GameState) => g.players.flatMap((p) => [...p.nertz, ...p.work.flat(), ...p.stock, ...p.waste].map((c) => c.id));
    function table() {
      vi.useFakeTimers();
      const { room, conns } = roomWith(3);
      const [a, b, c] = conns as [FakeConn, FakeConn, FakeConn];
      room.handle(a, { t: 'start' });
      room.flush();
      return { room, conns, a, b, c };
    }

    it('is a phase of its own: no faces on the wire, every intent refused and acked, then the work tops turn over for everyone in one flush and the table waits', () => {
      const { room, conns, a } = table();
      const dealt = room.game!;
      expect(vi.getTimerCount()).toBe(1);
      for (const conn of conns) {
        expect(conn.last.room).toMatchObject({ phase: 'playing', round: 1, dealMs: DEAL_MS, startMs: null, graceMs: null, game: { status: { at: 'dealing' } } });
        expect(faces(conn.last)).toBe(false);
        expect(cardIds(conn.last.room.game!)).toEqual(cardIds(dealt));
      }

      // Everything a client could try, from every seat, on real card ids.
      vi.advanceTimersByTime(900);
      for (const [seat, conn] of conns.entries()) {
        const p = dealt.players[seat]!;
        const top = p.nertz.at(-1)!.id;
        const tries: Intent[] = [{ k: 'stuck', on: true }, { k: 'flip' }, hold(top), move(top, { k: 'work', i: 0 }), move(p.work[0]![0]!.id, felt(0, 0)), { k: 'release' }, { k: 'nertz' }, { k: 'clear', slot: 0 }];
        const others = conns.filter((x) => x !== conn).map((x) => x.states.length);
        tries.forEach((intent, seq) => sendIntent(room, conn, seq, intent));
        room.flush();
        expect(room.game).toBe(dealt); // nothing happened
        expect(conn.last).toMatchObject({ ack: tries.length - 1, room: { dealMs: DEAL_MS - 900, game: { status: { at: 'dealing' } } } }); // acked all the same
        expect(faces(conn.last)).toBe(false);
        expect(conns.filter((x) => x !== conn).map((x) => x.states.length)).toEqual(others); // only the sender hears of a refusal
      }
      expect(a.last.room.game!.players.map((p) => p.stuck)).toEqual([false, false, false]);

      vi.advanceTimersByTime(DEAL_MS - 901);
      expect(room.game).toBe(dealt);
      const sent = conns.map((x) => x.states.length);
      const anyFaceBefore = conns.some((x) => x.states.some(faces));
      expect(anyFaceBefore).toBe(false);

      vi.advanceTimersByTime(1); // the deal timer
      expect(vi.getTimerCount()).toBe(0);
      expect(conns.map((x) => x.states.length)).toEqual(sent); // nobody has been told yet...
      room.flush(); // ...and everybody is told in the same flush
      expect(conns.map((x) => x.states.length)).toEqual(sent.map((n) => n + 1));
      for (const conn of conns) {
        expect(conn.last.room).toMatchObject({ phase: 'playing', dealMs: null, startMs: null, game: { status: { at: 'ready' } } });
        expect(conn.last.rev).toBe(a.last.rev);
        expect(conn.last.room.game).toEqual(wire(viewFor(finishDeal(dealt), 0)));
        expect(cardIds(conn.last.room.game!)).toEqual(cardIds(dealt)); // the same cards, the work tops turned over
        expect(faces(conn.last)).toBe(true);
        expect(nertzFaces(conn.last)).toBe(0);
      }
      sendIntent(room, a, 100, { k: 'flip' }); // not yet
      expect(room.game!.players[0]!.waste).toHaveLength(0);
      expect(checkInvariants(room.game!)).toBeNull();
    });

    it('a reconnect mid-deal gets the remainder as a duration and still no faces; disconnects do not hold up the start', () => {
      const { room, a, b, c } = table();
      vi.advanceTimersByTime(1000);
      room.disconnect(b);
      const b2 = new FakeConn();
      expect(room.join(b2, 'P1', 'tok-0001', true)).toBeNull();
      room.flush();
      expect(b2.last.room).toMatchObject({ me: 1, seat: 1, dealMs: DEAL_MS - 1000, game: { status: { at: 'dealing' } } });
      expect(faces(b2.last)).toBe(false);
      expect(faces(a.last)).toBe(false);
      expect(vi.getTimerCount()).toBe(1); // one deal, not restarted

      // Everyone drops before the cards are down: the deal still ends on time, the table waits with no timer running
      // (so the room expires like any table nobody is at), and whoever returns can start and play.
      room.disconnect(a);
      room.disconnect(b2);
      room.disconnect(c);
      vi.advanceTimersByTime(DEAL_MS - 1000);
      expect(vi.getTimerCount()).toBe(0);
      expect(room).toMatchObject({ phase: 'playing', connected: 0, game: { status: { at: 'ready' } } });
      vi.advanceTimersByTime(60 * 60_000);
      expect(room.game!.status.at).toBe('ready');
      const a2 = new FakeConn();
      room.join(a2, 'P0', 'tok-0000', true);
      room.flush();
      expect(a2.last.room).toMatchObject({ dealMs: null, startMs: null, game: { status: { at: 'ready' } } });
      expect(faces(a2.last)).toBe(true);
      expect(nertzFaces(a2.last)).toBe(0);
      room.handle(a2, { t: 'go' });
      vi.advanceTimersByTime(START_MS);
      sendIntent(room, a2, 0, { k: 'flip' });
      expect(room.game!.players[0]!.waste).toHaveLength(1);
    });

    it('someone who comes back during the deal is dealt in: it starts over, redacted the same', () => {
      vi.useFakeTimers();
      const { room, conns } = roomWith(3);
      const [a, , c] = conns as [FakeConn, FakeConn, FakeConn];
      room.disconnect(c);
      room.handle(a, { t: 'start' });
      vi.advanceTimersByTime(600);
      const c2 = new FakeConn();
      room.join(c2, 'P2', 'tok-0002', true);
      room.flush();
      expect(c2.last.room).toMatchObject({ me: 2, seat: 2, dealMs: DEAL_MS, game: { status: { at: 'dealing' } } });
      expect(c2.last.room.game!.players.map((p) => p.seat)).toEqual([0, 1, 2]);
      expect(faces(c2.last)).toBe(false);
      sendIntent(room, c2, 0, { k: 'flip' }); // nothing is taken while the cards are being dealt
      vi.advanceTimersByTime(DEAL_MS);
      room.flush();
      expect(faces(c2.last)).toBe(true);
    });

    it('stops its timer when the room is closed, and every later round is dealt the same way', () => {
      const { room } = table();
      room.close();
      expect(vi.getTimerCount()).toBe(0);
      vi.advanceTimersByTime(DEAL_MS * 2);
      expect(room.game!.status.at).toBe('dealing'); // nothing fired on a forgotten room

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
      expect(y.last.room).toMatchObject({ phase: 'playing', round: 2, dealMs: DEAL_MS, game: { status: { at: 'dealing' } } });
      expect(faces(y.last)).toBe(false);
      vi.advanceTimersByTime(DEAL_MS);
      next.room.flush();
      expect(y.last.room).toMatchObject({ dealMs: null, game: { status: { at: 'ready' } } });
    });
  });

  describe('the start: the table waits for the dealer, then "1, 2, 3, NERTZ!"', () => {
    const nertzFaces = (msg: StateMsg) => msg.room.game!.players.flatMap((p) => p.nertz).filter((c) => !isHidden(c)).length;
    const workFaces = (msg: StateMsg) => msg.room.game!.players.flatMap((p) => p.work.flat()).filter((c) => !isHidden(c)).length;
    const everything = (g: GameState, seat: number): Intent[] => {
      const p = g.players[seat]!;
      const top = p.nertz.at(-1)!.id;
      return [{ k: 'stuck', on: true }, { k: 'flip' }, hold(top), hold(p.work[0]![0]!.id), move(top, { k: 'work', i: 0 }), move(p.work[0]![0]!.id, felt(0, 0)), { k: 'release' }, { k: 'nertz' }, { k: 'clear', slot: 0 }];
    };
    /** Three players, the cards dealt: the table is ready and waiting. */
    function ready(n = 3) {
      vi.useFakeTimers();
      const { room, conns } = roomWith(n);
      const [a, b, c] = conns as [FakeConn, FakeConn, FakeConn];
      room.handle(a, { t: 'start' });
      vi.advanceTimersByTime(DEAL_MS);
      room.flush();
      return { room, conns, a, b, c };
    }

    it('ready waits without limit: no timer, no faces on any nertz pile, every intent refused and acked; only the dealer can start', () => {
      const { room, conns, a, b, c } = ready();
      const waiting = room.game!;
      expect(waiting.status.at).toBe('ready');
      expect(vi.getTimerCount()).toBe(0);
      vi.advanceTimersByTime(24 * 60 * 60_000);
      expect(room.game).toBe(waiting);
      for (const conn of conns) {
        expect(conn.last.room).toMatchObject({ phase: 'playing', dealMs: null, startMs: null, graceMs: null, game: { status: { at: 'ready' } } });
        expect(nertzFaces(conn.last)).toBe(0);
        expect(workFaces(conn.last)).toBe(3 * 4);
      }
      let seq = 0;
      for (const [seat, conn] of conns.entries()) {
        for (const intent of everything(waiting, seat)) sendIntent(room, conn, seq++, intent);
        room.flush();
        expect(conn.last.ack).toBe(seq - 1);
      }
      expect(room.game).toBe(waiting);

      // Not the dealer: ignored, and nobody hears of it.
      const sent = conns.map((x) => x.states.length);
      room.handle(b, { t: 'go' });
      room.handle(c, { t: 'go' });
      room.flush();
      expect(room.game).toBe(waiting);
      expect(vi.getTimerCount()).toBe(0);
      expect(conns.map((x) => x.states.length)).toEqual(sent);

      room.handle(a, { t: 'go' });
      expect(room.game!.status.at).toBe('countdown');
      expect(vi.getTimerCount()).toBe(1);
    });

    it('the countdown is one server timer reported as a duration; play opens for everybody in the same flush, nertz tops turned', () => {
      const { room, conns, a, b } = ready();
      const waiting = room.game!;
      room.handle(a, { t: 'go' });
      room.flush();
      expect(START_MS).toBe(3 * START_BEAT_MS);
      for (const conn of conns) {
        expect(conn.last.room).toMatchObject({ phase: 'playing', dealMs: null, startMs: START_MS, game: { status: { at: 'countdown' } } });
        expect(nertzFaces(conn.last)).toBe(0);
        expect(conn.last.room.game).toEqual(wire(viewFor(startCountdown(waiting), 0)));
      }

      // Pressing again (or anyone else pressing) neither restarts nor shortens it; everything is still refused.
      vi.advanceTimersByTime(500);
      room.handle(a, { t: 'go' });
      room.handle(b, { t: 'go' });
      expect(vi.getTimerCount()).toBe(1);
      let seq = 0;
      for (const [seat, conn] of conns.entries()) {
        for (const intent of everything(waiting, seat)) sendIntent(room, conn, seq++, intent);
        room.flush();
        expect(conn.last).toMatchObject({ ack: seq - 1, room: { startMs: START_MS - 500, game: { status: { at: 'countdown' } } } });
        expect(nertzFaces(conn.last)).toBe(0);
      }
      expect(room.game).toEqual(startCountdown(waiting));

      vi.advanceTimersByTime(START_MS - 501);
      expect(room.game!.status.at).toBe('countdown');
      const sent = conns.map((x) => x.states.length);
      vi.advanceTimersByTime(1); // NERTZ!
      expect(vi.getTimerCount()).toBe(0);
      expect(room.game!.status.at).toBe('play');
      expect(conns.map((x) => x.states.length)).toEqual(sent); // nobody has been told yet...
      room.flush(); // ...and everybody is told in the same flush
      expect(conns.map((x) => x.states.length)).toEqual(sent.map((n) => n + 1));
      for (const conn of conns) {
        expect(conn.last.room).toMatchObject({ phase: 'playing', dealMs: null, startMs: null, game: { status: { at: 'play' } } });
        expect(conn.last.rev).toBe(a.last.rev);
        expect(nertzFaces(conn.last)).toBe(3);
        expect(conn.last.room.game).toEqual(wire(viewFor(toPlay(waiting), 0)));
      }
      room.handle(a, { t: 'go' }); // nothing to start any more
      expect(vi.getTimerCount()).toBe(0);
      sendIntent(room, a, 100, { k: 'flip' });
      sendIntent(room, b, 100, { k: 'flip' });
      expect(room.game!.players.map((p) => p.waste.length)).toEqual([1, 1, 0]);
      expect(checkInvariants(room.game!)).toBeNull();
    });

    it('is ignored in the lobby, while the cards are being dealt, during play and on the score sheet', () => {
      vi.useFakeTimers();
      const { room, conns } = roomWith(2);
      const [a] = conns as [FakeConn, FakeConn];
      room.handle(a, { t: 'go' });
      expect(room.phase).toBe('lobby');
      expect(vi.getTimerCount()).toBe(0);
      room.handle(a, { t: 'start' });
      vi.advanceTimersByTime(DEAL_MS - 1);
      room.handle(a, { t: 'go' });
      expect(room.game!.status.at).toBe('dealing');
      expect(vi.getTimerCount()).toBe(1); // only the deal timer
      vi.advanceTimersByTime(1);
      room.handle(a, { t: 'go' });
      vi.advanceTimersByTime(START_MS);
      const open = (room.game = rigged([0, 1], [0]));
      room.handle(a, { t: 'go' });
      expect(room.game).toBe(open);
      sendIntent(room, a, 0, { k: 'nertz' });
      expect(room.phase).toBe('results');
      const rev = room.rev;
      room.handle(a, { t: 'go' });
      expect(room.rev).toBe(rev);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('a reconnect or reload in any stage gets that stage: the remaining count as a duration, never a second timer', () => {
      const { room, a, b } = ready();
      const again = (token: string, name: string) => {
        const conn = new FakeConn();
        expect(room.join(conn, name, token, true)).toBeNull();
        room.flush();
        return conn;
      };
      room.disconnect(b);
      const b2 = again('tok-0001', 'P1');
      expect(b2.last.room).toMatchObject({ me: 1, seat: 1, dealMs: null, startMs: null, game: { status: { at: 'ready' } } });
      expect(nertzFaces(b2.last)).toBe(0);

      room.handle(a, { t: 'go' });
      vi.advanceTimersByTime(800);
      const b3 = again('tok-0001', 'P1'); // a reload: the same token on a new socket
      expect(b2.closed).toBe(true);
      expect(b3.last.room).toMatchObject({ startMs: START_MS - 800, game: { status: { at: 'countdown' } } });
      expect(nertzFaces(b3.last)).toBe(0);
      const a2 = again('tok-0000', 'P0'); // the dealer reloading does not stop the count either
      expect(a2.last.room).toMatchObject({ startMs: START_MS - 800, game: { status: { at: 'countdown' } } });
      expect(vi.getTimerCount()).toBe(1);

      vi.advanceTimersByTime(START_MS - 800);
      room.flush();
      expect(b3.last.room).toMatchObject({ startMs: null, game: { status: { at: 'play' } } });
      const b4 = again('tok-0001', 'P1');
      expect(b4.last.room).toMatchObject({ startMs: null, dealMs: null, game: { status: { at: 'play' } } });
      expect(nertzFaces(b4.last)).toBe(3);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('the dealer away: the acting dealer starts; back again, the role is theirs; everyone gone mid-count, play still opens', () => {
      const { room, a, b, c } = ready();
      room.disconnect(a);
      room.flush();
      expect(b.last.room.players.map((p) => p.isHost)).toEqual([false, true, false]);
      room.handle(c, { t: 'go' }); // still not c's to press
      expect(room.game!.status.at).toBe('ready');
      const a2 = new FakeConn();
      room.join(a2, 'P0', 'tok-0000', true);
      room.handle(b, { t: 'go' }); // the host is back: no longer b's
      expect(room.game!.status.at).toBe('ready');
      room.disconnect(a2);
      room.handle(b, { t: 'go' });
      expect(room.game!.status.at).toBe('countdown');

      room.disconnect(b);
      room.disconnect(c);
      expect(room.connected).toBe(0);
      vi.advanceTimersByTime(START_MS);
      expect(room.game!.status.at).toBe('play');
      expect(vi.getTimerCount()).toBe(0);
    });

    it('someone sitting the round out watches the same opening', () => {
      vi.useFakeTimers();
      const { room, conns } = roomWith(3);
      const [a, b, c] = conns as [FakeConn, FakeConn, FakeConn];
      room.disconnect(a); // the host is away at the deal: b deals, a is not in the round
      room.handle(b, { t: 'start' });
      vi.advanceTimersByTime(DEAL_MS);
      room.handle(b, { t: 'go' }); // (back before this, they would have been dealt in)
      const a2 = new FakeConn();
      room.join(a2, 'P0', 'tok-0000', true);
      room.flush();
      expect(a2.last.room.game!.players.map((p) => p.seat)).toEqual([1, 2]);
      expect(nertzFaces(a2.last)).toBe(0);
      expect(a2.last.room.players.map((p) => p.isHost)).toEqual([true, false, false]);
      for (const conn of [a2, b, c]) expect(conn.last.room).toMatchObject({ startMs: START_MS, game: { status: { at: 'countdown' } } });
      sendIntent(room, a2, 0, { k: 'flip' }); // not in the round at all
      vi.advanceTimersByTime(START_MS);
      room.flush();
      for (const conn of [a2, b, c]) {
        expect(conn.last.room).toMatchObject({ startMs: null, game: { status: { at: 'play' } } });
        expect(nertzFaces(conn.last)).toBe(2);
      }
    });

    it('closing the room stops the count, and the next round starts from a clean slate', () => {
      const { room, a } = ready();
      room.handle(a, { t: 'go' });
      expect(vi.getTimerCount()).toBe(1);
      room.close();
      expect(vi.getTimerCount()).toBe(0);
      vi.advanceTimersByTime(START_MS * 3);
      expect(room.game!.status.at).toBe('countdown'); // nothing fired on a forgotten room

      const next = roomWith(2);
      const [x, y] = next.conns as [FakeConn, FakeConn];
      startRound(next.room, x);
      next.room.game = rigged([0, 1], [0]);
      sendIntent(next.room, x, 0, { k: 'nertz' });
      next.room.handle(x, { t: 'start' });
      vi.advanceTimersByTime(DEAL_MS);
      next.room.flush();
      expect(y.last.room).toMatchObject({ round: 2, startMs: null, game: { status: { at: 'ready' } } });
      expect(vi.getTimerCount()).toBe(0);
      next.room.handle(x, { t: 'go' });
      next.room.flush();
      expect(y.last.room).toMatchObject({ startMs: START_MS, game: { status: { at: 'countdown' } } });
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
      sendIntent(room, a, 5, move(A.aceS, felt(0, 0)));
      expect(holding(room)).toEqual([null, null, null]);
      sendIntent(room, a, 6, hold(A.twoS));
      sendIntent(room, c, 0, hold(workTop(room.game!, 2, 0)));
      room.disconnect(a);
      expect(holding(room)).toEqual([null, null, workTop(room.game!, 2, 0)]);
      const c2 = new FakeConn();
      room.join(c2, 'P2', 'tok-0002', true); // same seat from a new socket: nothing is in that hand
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
        expect(conn.last.room.game!.status).toEqual({ at: 'grace', calledBy: 1 });
        expect(conn.last.room.game!.players.map((p) => p.holding)).toEqual([A.aceS, null, null]);
      }
      expect(GRACE_MS).toBe(4000);

      vi.advanceTimersByTime(1500);
      const before = room.game;
      sendIntent(room, c, 0, { k: 'flip' }); // frozen
      sendIntent(room, c, 1, move(workTop(room.game!, 2, 0), felt(0, 0)));
      sendIntent(room, c, 2, hold(workTop(room.game!, 2, 0)));
      sendIntent(room, b, 1, { k: 'flip' });
      sendIntent(room, a, 1, { k: 'flip' }); // in grace, but that is not putting the card down
      sendIntent(room, a, 2, hold(A.aceH));
      expect(room.game).toBe(before);
      room.flush();
      expect(a.last).toMatchObject({ ack: 2, room: { phase: 'playing', graceMs: GRACE_MS - 1500 } }); // a duration, counted down
      expect(c.last.ack).toBe(2);

      sendIntent(room, a, 4, move(A.aceS, felt(0.5, 0.3)));
      room.flush();
      expect(room.phase).toBe('results');
      expect(vi.getTimerCount()).toBe(0);
      expect(a.last.room).toMatchObject({ phase: 'results', graceMs: null });
      expect(a.last.room.game!.status).toEqual({ at: 'over', end: { by: 'nertz', seat: 1 } });
      expect(a.last.room.game!.slots[0]!.cards.map((x) => x.id)).toEqual([A.aceS]);
      expect(a.last.room.lastRound!.scores.map((x) => [x.played, x.delta])).toEqual([[1, -25], [0, 0], [0, -26]]); // the grace move counted
      const rev = room.rev;
      vi.advanceTimersByTime(10_000);
      sendIntent(room, a, 5, move(A.aceH, felt(-0.5, 0))); // exactly one move
      expect(room.game!.slots[1]).toBeNull();
      expect(room.rev).toBe(rev + 1); // only the rejection's ack
    });

    // Regression: a drop that lost a race used to leave `holding` set on the server (only an accepted move or an
    // explicit release cleared it), so a later Nertz call opened a 4-second window for a player holding nothing.
    it('a refused drop empties the hand: losing a race and then hearing Nertz does not open a window', () => {
      const { room, a, b, c, A, C } = table();
      // Both drag their Ace of spades to the same place, exactly as the client sends it: hold, then move. Seat 2 arrives first.
      sendIntent(room, a, 0, hold(A.aceS));
      sendIntent(room, c, 0, hold(C.aceS));
      sendIntent(room, c, 1, move(C.aceS, felt(0, 0)));
      room.flush();
      const sent = b.states.length;
      sendIntent(room, a, 1, move(A.aceS, felt(0, 0))); // refused: the place is taken
      expect(filled(room.game!)).toEqual([[C.aceS]]);
      expect(workTop(room.game!, 0, 0)).toBe(A.aceS); // back where it came from
      expect(holding(room)).toEqual([null, null, null]);
      room.flush();
      expect(b.states.length).toBe(sent + 1); // the others are told that hand is empty
      expect(b.last.room.game!.players.map((p) => p.holding)).toEqual([null, null, null]);

      sendIntent(room, a, 2, { k: 'flip' });
      sendIntent(room, b, 0, { k: 'nertz' });
      expect(inGrace(room.game!)).toEqual([]);
      expect(room.phase).toBe('results'); // at once
      expect(vi.getTimerCount()).toBe(0);
    });

    it('a refused drop during grace ends that player\'s grace: two holders racing for one place finish the round at once', () => {
      const { room, a, b, c, A, C } = table();
      sendIntent(room, a, 0, hold(A.aceS));
      sendIntent(room, c, 0, hold(C.aceS));
      sendIntent(room, b, 0, { k: 'nertz' });
      expect(inGrace(room.game!)).toEqual([0, 2]);
      vi.advanceTimersByTime(500);
      sendIntent(room, a, 1, move(A.aceS, felt(0, 0)));
      expect(inGrace(room.game!)).toEqual([2]); // seat 2 still has room elsewhere
      sendIntent(room, c, 1, move(C.aceS, felt(0, 0))); // released on the place that was just taken: that was their one move
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

      sendIntent(room, c, 0, move(C.aceS, felt(0, 0))); // seat 2 takes the place first
      // Seat 0, still looking at the bare felt: drops the Ace there, then at once drags the 2 it uncovered to the 3.
      sendIntent(room, a, 0, hold(A.aceS));
      sendIntent(room, a, 1, move(A.aceS, felt(0, 0)));
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
      const sent = a.states.length;
      vi.advanceTimersByTime(1);
      expect(room.phase).toBe('results');
      room.flush();
      expect(a.states.length).toBe(sent + 1); // everyone is told
      expect(a.last.room).toMatchObject({ phase: 'results', graceMs: null });
      expect(a.last.room.game!.status).toEqual({ at: 'over', end: { by: 'nertz', seat: 1 } });
      expect(holding(room)).toEqual([null, null, null]); // the drag is cancelled
      expect(workTop(room.game!, 0, 0)).toBe(A.aceS);
      expect(filled(room.game!)).toEqual([]);
      expect(a.last.room.lastRound!.scores.map((x) => x.delta)).toEqual([-26, 0, -26]);
      expect(a.last.room.players.map((p) => p.score)).toEqual([-26, 0, -26]);
      sendIntent(room, a, 1, move(A.aceS, felt(0, 0))); // too late
      expect(filled(room.game!)).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
      // The next round is not disturbed by anything left over.
      room.handle(a, { t: 'start' });
      vi.advanceTimersByTime(60_000);
      expect(room.phase).toBe('playing');
      expect(calledBy(room.game!)).toBeNull();
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
      sendIntent(room, a, 0, move(A.aceS, felt(0, 0)));
      // Both 2s of spades fit only that one pile.
      sendIntent(room, a, 1, hold(A.twoS));
      sendIntent(room, c, 0, hold(C.twoS));
      sendIntent(room, b, 0, { k: 'nertz' });
      expect(inGrace(room.game!)).toEqual([0, 2]);
      expect(room.phase).toBe('playing');
      vi.advanceTimersByTime(700);
      sendIntent(room, c, 1, move(C.twoS, slot(0)));
      expect(room.phase).toBe('results'); // nobody is left who could do anything
      expect(vi.getTimerCount()).toBe(0);
      sendIntent(room, a, 2, move(A.twoS, slot(0)));
      room.flush();
      expect(room.game!.slots[0]!.cards.map((x) => x.id)).toEqual([A.aceS, C.twoS]);
      expect(workTop(room.game!, 0, 1)).toBe(A.twoS);
      expect(holding(room)).toEqual([null, null, null]);
      expect(a.last.room.lastRound!.scores.map((x) => x.played)).toEqual([1, 0, 1]);
    });

    it('waits for every holder: the window stays open until the last one has moved or released', () => {
      const { room, a, b, c, A, C } = table();
      sendIntent(room, a, 0, hold(A.aceS));
      sendIntent(room, c, 0, hold(C.aceH));
      sendIntent(room, b, 0, { k: 'nertz' });
      expect(inGrace(room.game!)).toEqual([0, 2]);
      vi.advanceTimersByTime(1000);
      sendIntent(room, c, 1, { k: 'release' });
      expect(room.phase).toBe('playing');
      expect(inGrace(room.game!)).toEqual([0]);
      sendIntent(room, c, 2, move(C.aceH, felt(0, 0))); // they let go: frozen now
      expect(filled(room.game!)).toEqual([]);
      room.flush();
      expect(a.last.room.graceMs).toBe(GRACE_MS - 1000); // one window, not restarted
      vi.advanceTimersByTime(1000);
      sendIntent(room, a, 1, move(A.aceS, felt(0, 0)));
      expect(room.phase).toBe('results');
      expect(filled(room.game!)).toEqual([[A.aceS]]);
    });

    it('a player who disconnects while in grace is cut off', () => {
      const { room, a, b, c, A, C } = table();
      sendIntent(room, a, 0, hold(A.aceS));
      sendIntent(room, c, 0, hold(C.aceS));
      sendIntent(room, b, 0, { k: 'nertz' });
      room.disconnect(a);
      expect(inGrace(room.game!)).toEqual([2]);
      expect(room.phase).toBe('playing');
      const a2 = new FakeConn();
      room.join(a2, 'P0', 'tok-0000', true); // coming straight back does not reopen it
      sendIntent(room, a2, 0, move(A.aceS, felt(0, 0)));
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
    const { room, conns } = roomWith(4, { rng: seeded(42) });
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
      const revs = conn.states.map((m) => m.rev);
      expect(revs.every((r, i) => i === 0 || r > revs[i - 1]!)).toBe(true);
    });
  });
});

// ---------------------------------------------------------------- the real server, over real sockets

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
    room.game = toPlay(room.game!); // these tests are about play: skip the deal and the start (the deal timer then finds nothing to do)
    return { room, code, players };
  };

  beforeAll(async () => {
    dist = mkdtempSync(join(tmpdir(), 'nertz-dist-'));
    writeFileSync(join(dist, 'index.html'), '<!doctype html><title>nertz test</title>');
    server = await startServer({ port: 0, dist, rate: 1e9, flipMs: 0 }); // the swarm test floods on purpose, stock included
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
    let lost = await open('ZZZZ', 'Lost', randomUUID(), false);
    await vi.waitFor(() => expect(lost.closeCode).toBe(CLOSE_OVER));
    expect(lost.states).toHaveLength(0);
    expect(server.rooms.has('ZZZZ')).toBe(false);

    const ann = await open(null, 'Ann');
    expect(isRoomCode(ann.code)).toBe(true);
    expect(server.rooms.has(ann.code)).toBe(true);
    expect(ann.last.room).toMatchObject({ phase: 'lobby', me: 0, seat: 0, players: [{ name: 'Ann', isHost: true }] });
    const other = await open(null, 'Zed');
    expect(other.code).not.toBe(ann.code); // every create is its own table
    expect(other.last.room.players).toHaveLength(1);

    const bob = await open(ann.code.toLowerCase(), 'Bob');
    expect(bob.last.room).toMatchObject({ code: ann.code, me: 1, seat: 1 });
    await vi.waitFor(() => expect(ann.last.room.players.map((p) => p.name)).toEqual(['Ann', 'Bob']));

    // A refused socket is closed; the same window can still come in on another: to watch, and to a seat by asking.
    lost = await open(ann.code, 'Lost', lost.token, false);
    await vi.waitFor(() => expect(lost.last?.room).toMatchObject({ me: 2, seat: null }));
    lost.send({ t: 'sit', on: true });
    await vi.waitFor(() => expect(lost.last?.room.seat).toBe(2));
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

  it('(a) two clients racing the same rank onto one pile, and two aces onto one patch of felt: exactly one lands, both are acked, the loser stays put', async () => {
    const { room, players } = await table(2);
    const [a, b] = players as [Client, Client];
    room.game = rigged([0, 1]);
    const ace = workTop(room.game, a.seat, 0);
    const twos = [workTop(room.game, 0, 1), workTop(room.game, 1, 1)];
    a.intent(move(ace, felt(-0.6, 0)));
    await vi.waitFor(() => expect(a.last.ack).toBe(0));
    // Same tick, both sockets: whichever frame the server reads first wins. Two red aces race for one place as well.
    const hearts = [workTop(room.game, 0, 2), workTop(room.game, 1, 2)];
    a.intent(move(twos[0]!, slot(0)));
    b.intent(move(twos[1]!, slot(0)));
    const seqA = a.intent(move(hearts[0]!, felt(0.6, 0)));
    const seqB = b.intent(move(hearts[1]!, felt(0.6, 0)));
    await vi.waitFor(() => {
      expect(a.last.ack).toBe(seqA);
      expect(b.last.ack).toBe(seqB);
    });
    const pile = room.game.slots[0]!.cards.map((c) => c.id);
    expect(pile).toHaveLength(2);
    expect(twos).toContain(pile[1]);
    const loser = twos.find((id) => id !== pile[1])!;
    expect(room.game.players.some((p) => p.work[1]!.at(-1)?.id === loser)).toBe(true); // still where it was
    const red = room.game.slots[1]!.cards.map((c) => c.id);
    expect(red).toHaveLength(1);
    expect(hearts).toContain(red[0]);
    expect(room.game.players.some((p) => p.work[2]!.at(-1)?.id === hearts.find((id) => id !== red[0]))).toBe(true);
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
    await vi.waitFor(() => expect(calledBy(c.last.room.game!)).toBe(1));
    for (const p of players) {
      await vi.waitFor(() => expect(inGrace(p.last.room.game!)).toEqual([0, 2]));
      expect(p.last.room.phase).toBe('playing');
      expect(p.last.room.graceMs).toBeGreaterThan(GRACE_MS - 1000);
      expect(p.last.room.graceMs).toBeLessThanOrEqual(GRACE_MS);
    }
    const flip = b.intent({ k: 'flip' }); // frozen
    a.intent(move(aceA, felt(0, 0)));
    await vi.waitFor(() => expect(b.last.ack).toBe(flip));
    await vi.waitFor(() => expect(inGrace(b.last.room.game!)).toEqual([2]));
    expect(b.last.room.phase).toBe('playing');
    expect(b.last.room.game!.players[1]!.waste).toHaveLength(0);
    await c.close(); // the last one in grace drops off the network: no need to wait out the clock
    await vi.waitFor(() => expect(a.last.room.phase).toBe('results'));
    expect(a.last.room).toMatchObject({ graceMs: null, lastRound: { end: { by: 'nertz', seat: 1 } } });
    expect(a.last.room.lastRound!.scores.map((x) => x.played)).toEqual([1, 0, 0]);
    expect(a.last.room.game).toEqual(wire(viewFor(room.game!, 0)));
    expect(a.last.room.game!.slots[0]!.cards.map((x) => x.id)).toEqual([aceA]);
    expect(a.last.room.game!.players.every((p) => p.holding === null)).toBe(true);
  });

  it('(b) a swarm of four bots firing as fast as they can never breaks the table', async () => {
    const { room, players } = await table(4);
    const rnd = seeded(2024);
    const PER_BOT = 3000;
    const BURST = 4;
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
          // Let snapshots in, and wait for the one that answers the burst before this one: the view stays a burst or two
          // behind, however fast this loop spins. (Without the wait a busy machine got through all 1200 on the very first
          // view, the fully redacted deal, and nothing but stock cards ever moved.)
          const answered = bot.seq - 2 * BURST;
          do await new Promise((next) => setImmediate(next));
          while (bot.last.ack < answered);
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

    const stranger = await open(code, 'Stranger', randomUUID()); // sits down to watch: a seat of their own, and no cards
    expect(stranger.last.room.game!.players.some((p) => p.seat === stranger.last.room.seat)).toBe(false);

    const b2 = await open(code, 'P1', b.token);
    expect(b2.last.room.seat).toBe(before.room.seat);
    expect(b2.last.room.game).toEqual(before.room.game);
    expect(b2.last.rev).toBeGreaterThan(before.rev);
    await vi.waitFor(() => expect(a.last.room.players[1]!.connected).toBe(true));

    const b3 = await open(code, 'P1', b.token); // e.g. a duplicated tab: the newer socket takes over
    await vi.waitFor(() => expect(b2.closeCode).toBe(CLOSE_OVER));
    expect(b3.last.room.seat).toBe(before.room.seat);
    expect(room.connected).toBe(3); // a, b and the stranger watching
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
    expect(a2.last.room.seat).toBe(0);
  });

  it('closes a connection that floods, at the default rate limit, and lets it come back to its seat', async () => {
    const limited = await startServer({ port: 0, dist });
    try {
      const token = randomUUID();
      const flooder = await Client.open(limited.port, null, 'Flo', token);
      const code = flooder.code;
      const closed = new Promise<number>((ok) => flooder.ws.once('close', (code) => ok(code)));
      for (let i = 0; i < 1000; i++) flooder.intent({ k: 'stuck', on: i % 2 === 0 });
      expect(await closed).toBe(CLOSE_FLOOD);
      const back = await Client.open(limited.port, code, 'Flo', token);
      expect(back.seat).toBe(0);
      await back.close();
    } finally {
      await limited.close();
    }
  });

  it('the stock is paced by the server: cards sent in the same instant are refused, and one is dealt again after the pause', async () => {
    const paced = await startServer({ port: 0, dist });
    try {
      const a = await Client.open(paced.port, null, 'P0');
      const b = await Client.open(paced.port, a.code, 'P1');
      a.send({ t: 'start' });
      await vi.waitFor(() => expect(b.last.room.phase).toBe('playing'));
      const room = paced.rooms.get(a.code)!;
      room.game = toPlay(room.game!);
      const stock = room.game.players[1]!.stock.length;
      let last = 0;
      for (let i = 0; i < 6; i++) last = b.intent({ k: 'flip' });
      await vi.waitFor(() => expect(b.last.ack).toBe(last)); // every one is answered...
      expect(room.game!.players[1]!).toMatchObject({ stock: { length: stock - 1 }, waste: { length: 1 }, dealt: 1 }); // ...but one card moved
      await new Promise((done) => setTimeout(done, STOCK_CARD_MS));
      last = b.intent({ k: 'flip' });
      await vi.waitFor(() => expect(b.last.ack).toBe(last));
      expect(room.game!.players[1]!).toMatchObject({ stock: { length: stock - 2 }, waste: { length: 2 }, dealt: 2 });
      expect(checkInvariants(room.game!)).toBeNull();
      await a.close();
      await b.close();
    } finally {
      await paced.close();
    }
  });

  it('the default rate limit leaves plenty of room for dealing card by card: three whole laps of the stock in one burst', async () => {
    const limited = await startServer({ port: 0, dist, flipMs: 0 });
    try {
      const a = await Client.open(limited.port, null, 'P0');
      const b = await Client.open(limited.port, a.code, 'P1');
      a.send({ t: 'start' });
      await vi.waitFor(() => expect(b.last.room.phase).toBe('playing'));
      const room = limited.rooms.get(a.code)!;
      room.game = toPlay(room.game!);
      const stock = room.game.players[1]!.stock.length;
      // Nobody deals faster than a few cards a second; this is a lap of the stock (a flip per card, and one to turn the
      // waste over) three times over, sent in the same instant, with a drag started and dropped between the laps.
      const top = room.game.players[1]!.nertz.at(-1)!.id;
      let last = 0;
      for (let lap = 0; lap < 3; lap++) {
        for (let i = 0; i <= stock; i++) last = b.intent({ k: 'flip' });
        b.intent({ k: 'hold', cardId: top });
        last = b.intent({ k: 'release' });
      }
      expect(last).toBeGreaterThan(100);
      await vi.waitFor(() => expect(b.last.ack).toBe(last));
      expect(b.ws.readyState).toBe(WebSocket.OPEN);
      expect(room.game!.players[1]!).toMatchObject({ stock: { length: stock }, waste: [], dealt: 0 }); // each flip was one card
      expect(checkInvariants(room.game!)).toBeNull();
      await a.close();
      await b.close();
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
    await vi.waitFor(() => expect(late.closeCode).toBe(CLOSE_OVER));
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

describe('ready, before Start', () => {
  it('whoever was dealt in says ready and everyone sees it; it is forgotten once play opens and at the next deal', () => {
    vi.useFakeTimers();
    try {
      const { room, conns } = roomWith(3);
      const [a, b, c] = conns as [FakeConn, FakeConn, FakeConn];
      room.handle(a, { t: 'start' });
      room.handle(b, { t: 'ready', on: true }); // while the cards are still being dealt is fine
      vi.advanceTimersByTime(DEAL_MS);
      room.flush();
      expect(c.last.room.players.map((p) => !!p.ready)).toEqual([false, true, false]);
      room.handle(b, { t: 'ready', on: false });
      room.handle(c, { t: 'ready', on: true });
      room.flush();
      expect(a.last.room.players.map((p) => !!p.ready)).toEqual([false, false, true]);
      expect(room.game!.status.at).toBe('ready'); // the dealer still says when
      room.handle(a, { t: 'go' });
      vi.advanceTimersByTime(START_MS);
      room.handle(c, { t: 'ready', on: false }); // too late to matter: ignored
      room.flush();
      expect(a.last.room.players.some((p) => p.ready)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
