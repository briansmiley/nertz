import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { canDrop, checkInvariants, deal, viewFor, type Rng } from '../shared/engine';
import { MAX_MESSAGE_BYTES, MAX_PLAYERS, type ServerMsg } from '../shared/protocol';
import type { Card, GameState, Intent, PileRef, Suit } from '../shared/types';
import { CLOSE_FLOOD, CLOSE_REPLACED, startServer, type NertzServer } from './index';
import { Room, type Conn } from './room';

type StateMsg = Extract<ServerMsg, { t: 'state' }>;

// ---------------------------------------------------------------- helpers

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

const move = (cardId: string, to: PileRef): Intent => ({ k: 'move', cardId, to });
const sendIntent = (room: Room, conn: Conn, seq: number, intent: Intent) => room.handle(conn, { t: 'intent', seq, intent });

/** A deal where every player's work piles show A-spades, 2-spades, A-hearts and 5-diamonds. */
function rigged(seats: number[], emptyNertzFor: number[] = []): GameState {
  const g = deal(seats, seeded(7));
  return {
    ...g,
    players: g.players.map((p) => {
      const cards = [...p.nertz, ...p.work.flat(), ...p.stock] as Card[];
      const take = (suit: Suit, rank: number) => cards.splice(cards.findIndex((c) => c.suit === suit && c.rank === rank), 1)[0]!;
      const work = [[take('S', 1)], [take('S', 2)], [take('H', 1)], [take('D', 5)]];
      const nertz = emptyNertzFor.includes(p.seat) ? [] : cards.splice(0, 13);
      return { ...p, work, nertz, stock: cards, waste: [] };
    }),
  };
}
const workTop = (g: GameState, seat: number, i: number) => g.players.find((p) => p.seat === seat)!.work[i]!.at(-1)!.id;

/** What a bot does next, given its (possibly stale) view: a mix of legal moves, flips, wrong moves and nonsense. */
function botIntent(view: GameState, seat: number, rnd: Rng): Intent {
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
  const me = view.players.find((p) => p.seat === seat)!;
  const targets: PileRef[] = [
    ...[0, 1, 2, 3].map((i): PileRef => ({ k: 'work', i })),
    ...view.foundations.map((f): PileRef => ({ k: 'foundation', id: f.id })),
    { k: 'newFoundation' },
  ];
  const roll = rnd();
  if (roll < 0.5) {
    const mine = [...me.nertz.slice(-1), ...me.waste.slice(-1), ...me.work.flat()];
    const legal = mine.flatMap((c) => targets.filter((to) => canDrop(view, seat, c.id, to)).map((to) => move(c.id, to)));
    // Prefer the foundations so the shared piles are genuinely contended.
    const toCentre = legal.filter((m) => m.k === 'move' && m.to.k !== 'work');
    if (legal.length > 0) return pick(toCentre.length > 0 && rnd() < 0.8 ? toCentre : legal);
    return { k: 'flip' };
  }
  if (roll < 0.75) return { k: 'flip' };
  if (roll < 0.8) return { k: 'stuck', on: rnd() < 0.5 };
  if (roll < 0.82) return me.nertz.length > 0 ? { k: 'nertz' } : { k: 'flip' };
  // Anyone's card, anywhere, to anywhere: almost always illegal.
  const everything = [
    ...view.players.flatMap((p) => [...p.nertz, ...p.waste, ...p.stock, ...p.work.flat()]),
    ...view.foundations.flatMap((f) => f.cards),
  ];
  return move(rnd() < 0.1 ? 'no-such-card' : pick(everything).id, rnd() < 0.1 ? { k: 'foundation', id: 'nope' } : pick(targets));
}

// ---------------------------------------------------------------- Room, driven directly

describe('Room', () => {
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

  it('coalesces a burst into one snapshot per player, and tells only the sender about a rejection', () => {
    const { room, conns } = roomWith(2);
    const [a, b] = conns as [FakeConn, FakeConn];
    room.handle(a, { t: 'start' });
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

  it('linearises a race for one foundation: first arrival lands, the loser is rejected', () => {
    const { room, conns } = roomWith(2);
    const [a, b] = conns as [FakeConn, FakeConn];
    room.handle(a, { t: 'start' });
    room.game = rigged([0, 1]);
    const aceA = workTop(room.game, 0, 0);
    sendIntent(room, a, 0, move(aceA, { k: 'newFoundation' }));
    // Both players aim their 2 of spades at a's ace before either has heard about the other.
    const [twoA, twoB] = [workTop(room.game, 0, 1), workTop(room.game, 1, 1)];
    sendIntent(room, b, 0, move(twoB, { k: 'foundation', id: aceA }));
    sendIntent(room, a, 1, move(twoA, { k: 'foundation', id: aceA }));
    room.flush();
    expect(room.game.foundations).toHaveLength(1);
    expect(room.game.foundations[0]!.cards.map((c) => c.id)).toEqual([aceA, twoB]);
    expect(workTop(room.game, 0, 1)).toBe(twoA); // a's card never left its pile
    expect(a.last.ack).toBe(1);
    expect(b.last.ack).toBe(0);
    expect(a.last.room.game).toEqual(b.last.room.game);
    expect(checkInvariants(room.game)).toBeNull();
  });

  it('linearises a race for one foundation: the loser falls back to another foundation that fits', () => {
    const { room, conns } = roomWith(2);
    const [a, b] = conns as [FakeConn, FakeConn];
    room.handle(a, { t: 'start' });
    room.game = rigged([0, 1]);
    const [aceA, aceB] = [workTop(room.game, 0, 0), workTop(room.game, 1, 0)];
    sendIntent(room, a, 0, move(aceA, { k: 'newFoundation' }));
    sendIntent(room, b, 0, move(aceB, { k: 'newFoundation' }));
    const [twoA, twoB] = [workTop(room.game, 0, 1), workTop(room.game, 1, 1)];
    sendIntent(room, a, 1, move(twoA, { k: 'foundation', id: aceA }));
    sendIntent(room, b, 1, move(twoB, { k: 'foundation', id: aceA }));
    room.flush();
    expect(room.game.foundations.map((f) => f.cards.map((c) => c.id))).toEqual([[aceA, twoA], [aceB, twoB]]);
    expect([a.last.ack, b.last.ack]).toEqual([1, 1]);
    expect(checkInvariants(room.game)).toBeNull();
  });

  it('resumes the same seat and hand on reconnect, refuses strangers mid-round, and lets the newest socket win', () => {
    const { room, conns } = roomWith(2);
    const [a, b] = conns as [FakeConn, FakeConn];
    room.handle(a, { t: 'start' });
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
    room.handle(a, { t: 'start' });
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
    expect(p0.stock).toHaveLength(35);
    expect(p0.stock[0]!.id).toBe(firstTop); // old top card went to the bottom
    expect(a.last.room.players.map((p) => p.stuck)).toEqual([false, false, false]);
    expect(checkInvariants(room.game!)).toBeNull();
  });

  it('ends the round on "Nertz!", scores it, and deals the next round without players who left', () => {
    const { room, conns } = roomWith(3);
    const [a, b, c] = conns as [FakeConn, FakeConn, FakeConn];
    room.handle(a, { t: 'start' });
    sendIntent(room, a, 0, { k: 'nertz' }); // 13 cards left: refused
    expect(room.phase).toBe('playing');
    room.game = rigged([0, 1, 2], [1]);
    sendIntent(room, a, 1, move(workTop(room.game, 0, 0), { k: 'newFoundation' }));
    sendIntent(room, b, 0, move(workTop(room.game, 1, 0), { k: 'newFoundation' }));
    sendIntent(room, b, 1, move(workTop(room.game, 1, 1), { k: 'newFoundation' }));
    sendIntent(room, b, 2, { k: 'nertz' });
    sendIntent(room, a, 2, { k: 'flip' }); // too late
    room.flush();
    expect(room.phase).toBe('results');
    expect(a.last.ack).toBe(2);
    expect(a.last.room.lastRound).toEqual({
      calledBy: 1,
      scores: [
        { seat: 0, foundation: 1, nertzLeft: 13, delta: -25 },
        { seat: 1, foundation: 2, nertzLeft: 0, delta: 2 },
        { seat: 2, foundation: 0, nertzLeft: 13, delta: -26 },
      ],
    });
    expect(a.last.room.players.map((p) => p.score)).toEqual([-25, 2, -26]);
    expect(a.last.room.game!.nertzCalledBy).toBe(1); // final table still visible

    room.handle(c, { t: 'leave' });
    room.flush();
    expect(a.last.room.players).toHaveLength(3); // still listed on the results screen
    const d = new FakeConn();
    expect(room.join(d, 'Dee', 'tok-dddd')).toBeNull(); // newcomers are welcome between rounds
    room.handle(b, { t: 'start' }); // not the host
    expect(room.phase).toBe('results');
    room.handle(a, { t: 'start' });
    room.flush();
    expect(a.last.room).toMatchObject({ phase: 'playing', round: 2 });
    expect(a.last.room.players.map((p) => [p.seat, p.name, p.score])).toEqual([[0, 'P0', -25], [1, 'P1', 2], [3, 'Dee', 0]]);
    expect(room.game!.players.map((p) => p.seat)).toEqual([0, 1, 3]);
    expect(checkInvariants(room.game!)).toBeNull();
  });

  it('keeps every invariant through thousands of random intents decided on stale views', () => {
    const { room, conns } = roomWith(4, 42);
    room.handle(conns[0]!, { t: 'start' });
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
    expect(room.game!.foundations.length).toBeGreaterThan(4);
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
      else this.errors.push(msg.message);
    });
    ws.on('close', (code) => (this.closeCode = code));
    ws.on('error', () => {});
  }
  static async open(port: number, room: string, name: string, token: string = randomUUID(), expectSeat = true): Promise<Client> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise((ok, fail) => ws.once('open', ok).once('error', fail));
    const client = new Client(ws, token);
    client.send({ t: 'join', room, name, token });
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
  const table = async (code: string, n: number): Promise<{ room: Room; players: Client[] }> => {
    const players: Client[] = [];
    for (let i = 0; i < n; i++) players.push(await open(code, `P${i}`));
    players[0]!.send({ t: 'start' });
    await vi.waitFor(() => players.forEach((p) => expect(p.last.room.phase).toBe('playing')));
    return { room: server.rooms.get(code)!, players };
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

  it('(a) two clients racing the same rank onto one foundation: exactly one lands, both are acked', async () => {
    const { room, players } = await table('RACE', 2);
    const [a, b] = players as [Client, Client];
    room.game = rigged([0, 1]);
    const ace = workTop(room.game, a.seat, 0);
    const twos = [workTop(room.game, 0, 1), workTop(room.game, 1, 1)];
    a.intent(move(ace, { k: 'newFoundation' }));
    await vi.waitFor(() => expect(a.last.ack).toBe(0));
    // Same tick, both sockets: whichever frame the server reads first wins.
    const seqA = a.intent(move(workTop(room.game, a.seat, 1), { k: 'foundation', id: ace }));
    const seqB = b.intent(move(workTop(room.game, b.seat, 1), { k: 'foundation', id: ace }));
    await vi.waitFor(() => {
      expect(a.last.ack).toBe(seqA);
      expect(b.last.ack).toBe(seqB);
    });
    const pile = room.game.foundations[0]!.cards.map((c) => c.id);
    expect(room.game.foundations).toHaveLength(1);
    expect(pile).toHaveLength(2);
    expect(twos).toContain(pile[1]);
    const loser = twos.find((id) => id !== pile[1])!;
    expect(room.game.players.some((p) => p.work[1]!.at(-1)?.id === loser)).toBe(true); // still where it was
    expect(checkInvariants(room.game)).toBeNull();
    await vi.waitFor(() => {
      for (const c of [a, b]) expect(c.last.room.game).toEqual(wire(viewFor(room.game!, c.seat)));
    });
  });

  it('(b) a swarm of four bots firing as fast as they can never breaks the table', async () => {
    const { room, players } = await table('SWRM', 4);
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
    expect(room.game!.foundations.length).toBeGreaterThan(0);
    for (const bot of players) {
      const revs = bot.states.map((m) => m.rev);
      expect(revs.every((r, i) => i === 0 || r > revs[i - 1]!)).toBe(true);
      const acks = bot.states.map((m) => m.ack);
      expect(acks.every((k, i) => i === 0 || k >= acks[i - 1]!)).toBe(true);
      expect(bot.errors.every((e) => e === 'Malformed message')).toBe(true);
    }
  }, 30_000);

  it('(c) reconnecting with the same token resumes the seat with the same hand', async () => {
    const { room, players } = await table('BACK', 2);
    const [a, b] = players as [Client, Client];
    b.intent({ k: 'flip' });
    await vi.waitFor(() => expect(b.last.ack).toBe(0));
    const before = b.last;
    await b.close();
    await vi.waitFor(() => expect(a.last.room.players[1]!.connected).toBe(false));

    const stranger = await open('BACK', 'Stranger', randomUUID(), false);
    await vi.waitFor(() => expect(stranger.errors).toEqual([expect.stringMatching(/in progress/)]));

    const b2 = await open('BACK', 'P1', b.token);
    expect(b2.last.room.you).toBe(before.room.you);
    expect(b2.last.room.game).toEqual(before.room.game);
    expect(b2.last.rev).toBeGreaterThan(before.rev);
    await vi.waitFor(() => expect(a.last.room.players[1]!.connected).toBe(true));

    const b3 = await open('BACK', 'P1', b.token); // e.g. a duplicated tab: the newer socket takes over
    await vi.waitFor(() => expect(b2.closeCode).toBe(CLOSE_REPLACED));
    expect(b3.last.room.you).toBe(before.room.you);
    expect(room.connected).toBe(2);
  });

  it('(d) malformed and oversized messages neither crash the server nor change any state', async () => {
    const { room, players } = await table('JUNK', 2);
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
      { t: 'intent', seq: 0, intent: { k: 'move', cardId: 'x', to: { k: 'work', i: 99 } } },
      { t: 'intent', seq: 0, intent: { k: 'move', cardId: { $ne: 1 }, to: null } },
      { t: 'join', room: 'JUNK', name: '', token: 'short' },
      { t: 'join', room: '../etc', name: 'x', token: randomUUID() },
      { t: 'selfdestruct' },
      { __proto__: null, t: 'start', constructor: 'x' },
    ];
    for (const j of junk) a.send(j);
    a.ws.send(Buffer.from([0, 1, 2, 255])); // binary frame
    await vi.waitFor(() => expect(a.errors).toHaveLength(junk.length)); // 13 text errors + 1 binary - 1 valid 'start'
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
    const a2 = await open('JUNK', 'P0', a.token);
    expect(a2.last.room.you).toBe(0);
  });

  it('closes a connection that floods, at the default rate limit, and lets it come back to its seat', async () => {
    const limited = await startServer({ port: 0, dist });
    try {
      const token = randomUUID();
      const flooder = await Client.open(limited.port, 'FLUD', 'Flo', token);
      const closed = new Promise<number>((ok) => flooder.ws.once('close', (code) => ok(code)));
      for (let i = 0; i < 400; i++) flooder.intent({ k: 'stuck', on: i % 2 === 0 });
      expect(await closed).toBe(CLOSE_FLOOD);
      const back = await Client.open(limited.port, 'FLUD', 'Flo', token);
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

  it('creates rooms on first join, forgets empty ones at once and idle ones after ten minutes', async () => {
    const a = await open('GCGC', 'Ann');
    const b = await open('GCGC', 'Bob');
    const solo = await open('LANE', 'Sol');
    expect(server.rooms.has('GCGC') && server.rooms.has('LANE')).toBe(true);

    solo.send({ t: 'leave' }); // last player walks out of a lobby: nothing left to keep
    await vi.waitFor(() => expect(server.rooms.has('LANE')).toBe(false));

    a.send({ t: 'start' });
    await vi.waitFor(() => expect(b.last.room.phase).toBe('playing'));
    await a.close();
    await b.close();
    await vi.waitFor(() => expect(server.rooms.get('GCGC')!.connected).toBe(0));
    server.sweep(Date.now() + 9 * 60_000);
    expect(server.rooms.has('GCGC')).toBe(true);
    const a2 = await open('GCGC', 'Ann', a.token); // coming back resets the clock
    expect(a2.last.room.phase).toBe('playing');
    server.sweep(Date.now() + 11 * 60_000);
    expect(server.rooms.has('GCGC')).toBe(true);
    await a2.close();
    await vi.waitFor(() => expect(server.rooms.get('GCGC')!.connected).toBe(0));
    server.sweep(Date.now() + 11 * 60_000);
    expect(server.rooms.has('GCGC')).toBe(false);
  });
});
