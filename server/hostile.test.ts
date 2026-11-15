// A hand-written client against the real server, over real sockets, trying to cheat: racing for the same pile, spot and
// patch of felt, moving cards with position reports, dealing faster than a card per message, acting before play opens,
// getting round clear-first, reading faces early, and reconnecting at every awkward moment. Nothing here uses the
// client's code: only the wire.
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { checkInvariants, finishDeal, isHidden, legalDrops, grab, openPlay, startCountdown, viewFor, type Rng } from '../shared/engine';
import { CLOSE_OVER, DEAL_MS, DRAG_BURST, START_MS, type ServerMsg } from '../shared/protocol';
import type { AnyCard, Card, GameState, Intent, PileRef, Suit } from '../shared/types';
import { CLOSE_FLOOD, startServer, type NertzServer } from './index';
import { Room, type Conn } from './room';

type StateMsg = Extract<ServerMsg, { t: 'state' }>;
type DragMsg = Extract<ServerMsg, { t: 'drag' }>;

const wire = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const toPlay = (s: GameState): GameState => openPlay(startCountdown(finishDeal(s)));
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

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

/**
 * Which cards of a snapshot show a face that the rules say nobody may see yet. Judged from the snapshot alone, by
 * where each card lies: written out here on purpose, not borrowed from `viewFor`.
 */
function leaks(g: GameState): string[] {
  const out: string[] = [];
  const faceUp = (c: AnyCard) => !isHidden(c);
  for (const p of g.players) {
    const at = `${g.stage} seat ${p.seat}`;
    p.stock.forEach((c) => faceUp(c) && out.push(`${at}: stock card with a face`));
    p.nertz.forEach((c, i) => faceUp(c) && (i < p.nertz.length - 1 || g.stage !== 'play') && out.push(`${at}: nertz card ${i} with a face`));
    p.work.forEach((w, k) => w.forEach((c, i) => faceUp(c) && (i < p.down[k]! || g.stage === 'dealing') && out.push(`${at}: work ${k} card ${i} with a face`)));
    p.waste.forEach((c, i) => faceUp(c) && (i >= p.waste.length - p.dealt || g.stage !== 'play') && out.push(`${at}: waste card ${i} with a face`));
  }
  return out;
}

class Client {
  states: StateMsg[] = [];
  drags: DragMsg[] = [];
  errors: string[] = [];
  raw: string[] = [];
  seq = 0;
  closeCode: number | null = null;
  constructor(
    readonly ws: WebSocket,
    readonly token: string,
  ) {
    ws.on('message', (data) => {
      const text = data.toString();
      this.raw.push(text);
      const msg = JSON.parse(text) as ServerMsg;
      if (msg.t === 'state') this.states.push(msg);
      else if (msg.t === 'drag') this.drags.push(msg);
      else if (msg.t === 'error') this.errors.push(msg.message);
    });
    ws.on('close', (code) => (this.closeCode = code));
    ws.on('error', () => {});
  }
  static async open(port: number, room: string | null, name: string, token: string = randomUUID()): Promise<Client> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise((ok, fail) => ws.once('open', ok).once('error', fail));
    const client = new Client(ws, token);
    client.send(room === null ? { t: 'create', name, token } : { t: 'join', room, name, token });
    await vi.waitFor(() => expect(client.states.length).toBeGreaterThan(0));
    if (room !== null) await client.sit();
    return client;
  }
  send(msg: unknown): void {
    this.ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
  }
  /** Whoever comes to a table watches until they ask for a seat: asks, and waits until they have one or are in the queue for one. */
  async sit(): Promise<void> {
    this.send({ t: 'sit', on: true });
    await vi.waitFor(() => expect(this.last.room.seat !== null || !!this.last.room.players.find((p) => p.id === this.last.room.me)?.queued).toBe(true));
  }
  intent(intent: unknown): number {
    this.send({ t: 'intent', seq: this.seq, intent });
    return this.seq++;
  }
  /** Sends the intent and waits until the server has answered it. */
  async did(intent: unknown): Promise<StateMsg> {
    const seq = this.intent(intent);
    await vi.waitFor(() => expect(this.last.ack).toBeGreaterThanOrEqual(seq));
    return this.last;
  }
  drag(id: string, x = 0.1, y = 0.2): void {
    this.send({ t: 'drag', id, w: 0.5, h: [1, 1], p: [x, y] });
  }
  /** Everything the server has sent so far has arrived: an error is answered in order, after all that came before. */
  async synced(): Promise<void> {
    const n = this.errors.length;
    this.send('?');
    await vi.waitFor(() => expect(this.errors.length).toBeGreaterThan(n));
  }
  get last(): StateMsg {
    return this.states.at(-1)!;
  }
  get game(): GameState {
    return this.last.room.game!;
  }
  get seat(): number {
    return this.last.room.seat ?? -1;
  }
  get code(): string {
    return this.last.room.code;
  }
  async close(): Promise<void> {
    if (this.ws.readyState === WebSocket.CLOSED) return;
    const closed = new Promise((ok) => this.ws.once('close', ok));
    this.ws.terminate();
    await closed;
  }
}

const move = (cardId: string, to: PileRef, count = 1): Intent => ({ k: 'move', cardId, count, to });
const slot = (i: number): PileRef => ({ k: 'slot', i });
const felt = (x: number, y: number): PileRef => ({ k: 'felt', x, y });
const me = (g: GameState, seat: number) => g.players.find((p) => p.seat === seat)!;
const workTop = (g: GameState, seat: number, i: number) => me(g, seat).work[i]!.at(-1)!.id;
const piles = (g: GameState) => g.slots.filter((s) => s !== null);

/** The round as dealt, with every player's work piles made single face-up cards: A-spades, 2-spades, A-hearts, K-clubs. */
function rig(g: GameState, emptyNertzFor: number[] = []): GameState {
  return {
    ...g,
    players: g.players.map((p) => {
      const cards = [...p.nertz, ...p.work.flat(), ...p.stock, ...p.waste] as Card[];
      const take = (suit: Suit, rank: number) => cards.splice(cards.findIndex((c) => c.suit === suit && c.rank === rank), 1)[0]!;
      const work = [[take('S', 1)], [take('S', 2)], [take('H', 1)], [take('C', 13)]];
      const nertz = emptyNertzFor.includes(p.seat) ? [] : cards.splice(0, 13);
      return { ...p, work, down: [0, 0, 0, 0], nertz, stock: cards, waste: [], dealt: 0, holding: null };
    }),
  };
}

/** A centre pile of clubs, Ace to Queen, built from `owner`'s deck and put in slot `i`: one King short of finished. */
function nearlyDone(g: GameState, owner: number, i: number): GameState {
  const p = me(g, owner);
  const clubs = (pile: AnyCard[]) => pile.filter((c): c is Card => !isHidden(c) && c.suit === 'C' && c.rank < 13);
  const taken = [...clubs(p.nertz), ...clubs(p.stock)].sort((a, b) => a.rank - b.rank);
  expect(taken).toHaveLength(12);
  const ids = new Set(taken.map((c) => c.id));
  const without = (pile: AnyCard[]) => pile.filter((c) => !ids.has(c.id));
  return {
    ...g,
    players: g.players.map((q) => (q === p ? { ...q, nertz: without(q.nertz), stock: without(q.stock) } : q)),
    slots: g.slots.map((s, k) => (k === i ? { cards: [taken[0]!, ...taken.slice(1)], at: { x: 0, y: 0, r: 0 } } : s)),
  };
}

describe('a hostile client over real sockets', () => {
  let server: NertzServer;
  let dist: string;
  const clients: Client[] = [];
  const open = async (room: string | null, name: string, token?: string) => {
    const c = await Client.open(server.port, room, name, token);
    clients.push(c);
    return c;
  };
  /** A table of `n` people with the cards dealt (stage `dealing`, the deal timer running). */
  const dealt = async (n: number) => {
    const players = [await open(null, 'P0')];
    for (let i = 1; i < n; i++) players.push(await open(players[0]!.code, `P${i}`));
    players[0]!.send({ t: 'start' });
    await vi.waitFor(() => players.forEach((p) => expect(p.last.room.phase).toBe('playing')));
    return { room: server.rooms.get(players[0]!.code)!, players };
  };
  /** The same with play open and the hands rigged; every client has seen the rigged table. */
  const playing = async (n: number, emptyNertzFor: number[] = [], also: (g: GameState) => GameState = (g) => g) => {
    const t = await dealt(n);
    t.room.game = also(rig(toPlay(t.room.game!), emptyNertzFor));
    expect(checkInvariants(t.room.game)).toBeNull();
    // Any change sends everyone the table as it now is.
    await t.players[0]!.did({ k: 'stuck', on: false });
    await vi.waitFor(() => t.players.forEach((p) => expect(p.game).toEqual(wire(viewFor(t.room.game!, p.seat)))));
    return t;
  };
  const converged = (room: Room, players: Client[]) =>
    vi.waitFor(() => {
      for (const p of players) expect(p.game).toEqual(wire(viewFor(room.game!, p.seat)));
    });

  beforeAll(async () => {
    dist = mkdtempSync(join(tmpdir(), 'nertz-hostile-'));
    writeFileSync(join(dist, 'index.html'), '<!doctype html><title>nertz</title>');
    server = await startServer({ port: 0, dist, flipMs: 0 }); // the real rate limit; the stock's pacing has its own test in room.test.ts
  });
  afterAll(async () => {
    await server.close();
    rmSync(dist, { recursive: true, force: true });
  });
  afterEach(async () => {
    // Not one snapshot of any test showed a face early, and every one was a well-formed table.
    for (const c of clients) {
      for (const s of c.states) {
        if (!s.room.game) continue;
        expect(leaks(s.room.game)).toEqual([]);
        expect(checkInvariants(s.room.game)).toBeNull();
      }
    }
    await Promise.all(clients.splice(0).map((c) => c.close()));
  });

  it('races: one pile, one patch of felt: exactly one lands every time, the other goes home, everyone converges', async () => {
    const { room, players } = await playing(3);
    // Three Aces of spades for the same place, sent in the same instant.
    const seqs = players.map((p) => p.intent(move(workTop(room.game!, p.seat, 0), felt(0.1, 0.1))));
    await vi.waitFor(() => players.forEach((p, i) => expect(p.last.ack).toBe(seqs[i])));
    expect(piles(room.game!)).toHaveLength(1);
    const at = room.game!.slots.findIndex((s) => s?.cards.length === 1);
    const winner = room.game!.slots[at]!.cards[0].owner;
    for (const p of players) expect(me(room.game!, p.seat).work[0]!.length).toBe(p.seat === winner ? 0 : 1); // the losers' Aces lie where they lay
    // Three twos of spades for that one pile.
    const twos = players.map((p) => p.intent(move(workTop(room.game!, p.seat, 1), slot(at))));
    await vi.waitFor(() => players.forEach((p, i) => expect(p.last.ack).toBe(twos[i])));
    expect(room.game!.slots[at]!.cards.map((c) => c.rank)).toEqual([1, 2]);
    expect(players.filter((p) => me(room.game!, p.seat).work[1]!.length === 1)).toHaveLength(2);
    // Overlapping, not identical, patches of felt: still one. A patch well clear of it: both.
    const [a, b] = players as [Client, Client, Client];
    const hearts = [a, b].map((p) => workTop(room.game!, p.seat, 2));
    const s = [a.intent(move(hearts[0]!, felt(-0.5, -0.2))), b.intent(move(hearts[1]!, felt(-0.47, -0.18)))];
    await vi.waitFor(() => [a, b].forEach((p, i) => expect(p.last.ack).toBe(s[i])));
    expect(piles(room.game!)).toHaveLength(2);
    const loser = [a, b].find((p) => me(room.game!, p.seat).work[2]!.length === 1)!;
    await loser.did(move(workTop(room.game!, loser.seat, 2), felt(1.2, -0.2)));
    expect(piles(room.game!)).toHaveLength(3);
    // Off the table, on another pile, or not an Ace: refused.
    const c = players[2]!;
    for (const to of [felt(2.7, 0), felt(0.1, 0.1), felt(2.6, 0.8)]) await c.did(move(workTop(room.game!, c.seat, 2), to));
    await c.did(move(workTop(room.game!, c.seat, 3), felt(0, -0.6)));
    expect(piles(room.game!)).toHaveLength(3);
    expect(checkInvariants(room.game!)).toBeNull();
    await converged(room, players);
  });

  it('position reports move nothing, go out only for the card the game says is held, are cut to a rate, and a flood of them neither starves anyone nor outlives the socket', async () => {
    const { room, players } = await playing(3);
    const [a, b, c] = players as [Client, Client, Client];
    const ace = workTop(room.game!, a.seat, 0);
    const [game, rev] = [room.game, room.rev];
    // Not held: nothing. Somebody else's card, a hidden card, a card in the stock: nothing.
    a.drag(ace);
    a.drag(workTop(room.game!, b.seat, 0));
    a.drag(me(room.game!, a.seat).stock.at(-1)!.id);
    a.drag(me(room.game!, a.seat).nertz[0]!.id);
    await a.synced();
    await b.synced();
    expect([b.drags, c.drags]).toEqual([[], []]);
    await a.did({ k: 'hold', cardId: ace });
    const held = room.game;
    // Held: forwarded with the seat stamped by the server, whatever the sender claims; the wrong card still is not.
    a.send({ t: 'drag', seat: 2, id: ace, w: 1, h: [0, 0], p: [0.3, 0.3], cardId: 'x', k: 'move', to: { k: 'slot', i: 0 } });
    a.drag(workTop(room.game!, a.seat, 1));
    await vi.waitFor(() => expect(b.drags).toHaveLength(1));
    expect(b.drags[0]).toEqual({ t: 'drag', seat: a.seat, id: ace, w: 1, h: [0, 0], p: [0.3, 0.3] });
    expect(a.drags).toEqual([]); // never echoed
    // A burst far above the rate: a dozen or so get through, the rest are dropped, and the game is exactly where it was.
    for (let i = 0; i < 100; i++) a.drag(ace, i / 1000, 0);
    await a.synced();
    await b.synced();
    expect(b.drags.length).toBeLessThanOrEqual(DRAG_BURST + 3);
    expect(c.drags.length).toBe(b.drags.length);
    expect(room.game).toBe(held);
    expect(piles(room.game!)).toHaveLength(0);
    // Let go: nothing more is forwarded.
    await a.did({ k: 'release' });
    await sleep(600); // (the allowance is full again)
    const seen = b.drags.length;
    a.drag(ace);
    await a.synced();
    await b.synced();
    expect(b.drags.length).toBe(seen);
    expect(room.game!.players).toEqual(game!.players);
    expect(room.rev).toBe(rev + 2); // the hold and the release, and nothing else

    // A flood: the socket is closed for it, and meanwhile the others play on without waiting.
    await a.did({ k: 'hold', cardId: ace });
    const before = b.drags.length;
    const closed = new Promise<number>((ok) => a.ws.once('close', (code) => ok(code)));
    for (let i = 0; i < 3000; i++) a.drag(ace, (i % 100) / 1000, 0);
    const t0 = Date.now();
    await b.did(move(workTop(room.game!, b.seat, 0), felt(0, 0)));
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(await closed).toBe(CLOSE_FLOOD);
    await vi.waitFor(() => expect(b.game.players.map((p) => p.holding)).toEqual([null, null, null])); // the flooder's card went home
    expect(b.drags.length - before).toBeLessThanOrEqual(DRAG_BURST + 3);
    expect(room.game!.slots[0]!.cards).toHaveLength(1);
    expect(checkInvariants(room.game!)).toBeNull();
    const back = await open(a.code, 'P0', a.token);
    expect(back.seat).toBe(a.seat);
    await converged(room, [back, b, c]);
  });

  it('the stock gives one card per message whatever the message says, and nobody is shown a card of a half-dealt group', async () => {
    const { room, players } = await playing(2);
    const [a, b] = players as [Client, Client];
    const stock = me(room.game!, a.seat).stock.length;
    // Everything a doctored client might hope deals three: extra fields, a list of messages, a list of intents.
    await a.did({ k: 'flip', count: 3, n: 3, cards: 3 });
    expect(me(room.game!, a.seat)).toMatchObject({ stock: { length: stock - 1 }, waste: { length: 1 }, dealt: 1 });
    a.send([{ t: 'intent', seq: a.seq, intent: { k: 'flip' } }, { t: 'intent', seq: a.seq + 1, intent: { k: 'flip' } }]);
    a.send({ t: 'intent', seq: a.seq, intent: [{ k: 'flip' }, { k: 'flip' }] });
    a.send({ t: 'intent', seq: a.seq, intents: [{ k: 'flip' }, { k: 'flip' }] });
    a.send(`${JSON.stringify({ t: 'intent', seq: a.seq, intent: { k: 'flip' } })}\n${JSON.stringify({ t: 'intent', seq: a.seq + 1, intent: { k: 'flip' } })}`);
    await a.synced();
    expect(me(room.game!, a.seat)).toMatchObject({ stock: { length: stock - 1 }, dealt: 1 });
    // The same sequence number again is not a second card.
    a.send({ t: 'intent', seq: a.seq - 1, intent: { k: 'flip' } });
    a.send({ t: 'intent', seq: a.seq - 1, intent: { k: 'flip' } });
    await a.synced();
    expect(me(room.game!, a.seat).dealt).toBe(1);
    // Half-dealt: out of play, and hidden from its owner too.
    await converged(room, players);
    const top = me(room.game!, a.seat).waste.at(-1)!;
    for (const p of players) expect(isHidden(me(p.game, a.seat).waste.at(-1)!)).toBe(true);
    for (const p of players) expect(p.raw.some((text) => text.includes(`"id":"${top.id}","owner":${a.seat},"suit"`))).toBe(false);
    await a.did({ k: 'hold', cardId: top.id });
    await a.did(move(top.id, { k: 'work', i: 0 }));
    expect(me(room.game!, a.seat)).toMatchObject({ holding: null, waste: { length: 1 } });
    await a.did({ k: 'flip' });
    for (const p of players) expect(me(p.game, a.seat).waste.every(isHidden)).toBe(true);
    await a.did({ k: 'flip' });
    await converged(room, players);
    for (const p of players) expect(me(p.game, a.seat).waste.some(isHidden)).toBe(false); // the third turned the group up
    // A whole lap, sent at once: exactly one card each, and the last message turns the waste over.
    let last = 0;
    for (let i = 0; i < stock - 3 + 1; i++) last = a.intent({ k: 'flip' });
    await vi.waitFor(() => expect(a.last.ack).toBe(last));
    expect(me(room.game!, a.seat)).toMatchObject({ stock: { length: stock }, waste: [], dealt: 0 });
    expect(me(room.game!, b.seat).stock).toHaveLength(stock); // and nobody else's stock was touched
    await converged(room, players);
  });

  it('nothing is accepted, forwarded or shown before play opens: every intent, a position report and a reconnect, in dealing, ready and the count', async () => {
    const { room, players } = await dealt(3);
    const [a, b, c] = players as [Client, Client, Client];
    const truth = room.game!;
    const faceUp = (p: Client) => p.game.players.flatMap((q) => [...q.nertz, ...q.work.flat(), ...q.stock, ...q.waste]).filter((x) => !isHidden(x)).length;
    /** Everything a client can send, about every card of its own and somebody else's top cards. */
    const everything = async (p: Client) => {
      const mine = me(truth, p.seat);
      const other = me(truth, (p.seat + 1) % 3);
      const ids = [mine.nertz.at(-1)!.id, ...mine.work.map((w) => w.at(-1)!.id), mine.stock.at(-1)!.id, other.work[0]!.at(-1)!.id];
      for (const id of ids) {
        p.intent({ k: 'hold', cardId: id });
        p.drag(id);
        for (const to of [slot(0), felt(0, 0), { k: 'work', i: 1 } as PileRef]) p.intent(move(id, to));
      }
      for (const k of ['flip', 'nertz', 'release'] as const) p.intent({ k });
      p.intent({ k: 'stuck', on: true });
      p.intent({ k: 'clear', slot: 0 });
      await vi.waitFor(() => expect(p.last.ack).toBe(p.seq - 1));
      await p.synced();
    };
    const closed = async (stage: GameState['stage'], shown: number) => {
      await vi.waitFor(() => players.forEach((p) => expect(p.game.stage).toBe(stage)), { timeout: DEAL_MS + 1000 });
      const state = room.game;
      for (const p of players) await everything(p);
      expect(room.game).toBe(state); // not one of them changed anything
      for (const p of players) {
        expect(p.drags).toEqual([]);
        expect(faceUp(p)).toBe(shown);
        expect(p.game.players.every((q) => q.holding === null && !q.stuck && q.waste.length === 0)).toBe(true);
      }
      // A new socket for the same seat (a reload) is told exactly as much.
      const again = await open(c.code, 'P2', c.token);
      expect(again.game).toEqual(wire(viewFor(room.game!, c.seat)));
      expect(faceUp(again)).toBe(shown);
      await everything(again);
      expect(room.game).toBe(state);
      players[2] = again;
    };
    await closed('dealing', 0);
    b.send({ t: 'go' }); // only the dealer starts, and only once the cards are down
    a.send({ t: 'go' });
    await closed('ready', 3 * 4); // the work tops, and no nertz top
    expect(a.last.room.startMs).toBeNull();
    b.send({ t: 'go' });
    await b.synced();
    expect(room.game!.stage).toBe('ready');
    a.send({ t: 'go' });
    await closed('countdown', 3 * 4);
    expect(players[2]!.last.room.startMs).toBeGreaterThan(0);
    expect(players[2]!.last.room.startMs).toBeLessThanOrEqual(START_MS);
    // The word: every nertz top turns over, for everyone, and now the same messages count.
    await vi.waitFor(() => players.forEach((p) => expect(p.game.stage).toBe('play')), { timeout: START_MS + 1000 });
    for (const p of players) expect(faceUp(p)).toBe(3 * 5);
    await a.did({ k: 'flip' });
    expect(me(room.game!, a.seat).waste).toHaveLength(1);
    // Nobody was ever sent the face of a nertz top before the word. (Each client's whole history is checked after the test.)
    expect(DEAL_MS).toBeGreaterThan(0);
  }, 20_000);

  it('clear-first cannot be got round: no intent of any kind, no report, no reconnect; and nobody else is held up', async () => {
    const { room, players } = await playing(2, [0], (g) => nearlyDone(g, 0, 3));
    const [a, b] = players as [Client, Client];
    const king = workTop(room.game!, a.seat, 3);
    const ace = workTop(room.game!, a.seat, 0);
    // Pick another card up first, then put the King down and try everything else in the same breath.
    a.intent({ k: 'hold', cardId: ace });
    a.intent(move(king, slot(3)));
    const tries: unknown[] = [
      { k: 'flip' },
      { k: 'stuck', on: true },
      { k: 'nertz' }, // (its nertz pile is empty)
      { k: 'hold', cardId: ace },
      { k: 'release' },
      move(ace, slot(0)),
      move(ace, felt(0.5, 0.3)),
      move(ace, { k: 'work', i: 1 }),
      move(workTop(room.game!, a.seat, 1), { k: 'work', i: 2 }),
      { k: 'clear', slot: 0 },
      { k: 'clear', slot: 4 },
    ];
    for (const t of tries) a.intent(t);
    a.drag(ace);
    await vi.waitFor(() => expect(a.last.ack).toBe(a.seq - 1));
    await a.synced();
    const waiting = room.game!;
    expect(waiting.slots[3]!.cards).toHaveLength(13);
    expect(me(waiting, a.seat)).toMatchObject({ holding: null, stuck: false, waste: [], work: [{ length: 1 }, { length: 1 }, { length: 1 }, []] });
    expect(waiting.nertzCalledBy).toBeNull();
    expect(piles(waiting)).toHaveLength(1);
    expect(b.drags).toEqual([]);
    // A new socket is held to it just the same.
    const a2 = await open(a.code, 'P0', a.token);
    for (const t of tries) a2.intent(t);
    await vi.waitFor(() => expect(a2.last.ack).toBe(a2.seq - 1));
    expect(room.game).toBe(waiting);
    // The other player is not held up, and cannot clear it for them.
    await b.did({ k: 'clear', slot: 3 });
    expect(room.game).toBe(waiting);
    await b.did({ k: 'flip' });
    expect(me(room.game!, b.seat).waste).toHaveLength(1);
    // Into the tray, and everything works again.
    await a2.did({ k: 'clear', slot: 3 });
    expect(room.game!.tray).toHaveLength(1);
    await a2.did({ k: 'nertz' });
    await vi.waitFor(() => expect(b.last.room.phase).toBe('results'));
    expect(b.last.room.lastRound!.scores.find((s) => s.seat === a.seat)!.played).toBe(13);
    await converged(room, [a2, b]);
  });

  it('a socket that goes away or is replaced in the middle of a drag: the card goes home for everyone, the old socket can do nothing, the hand is the same', async () => {
    const { room, players } = await playing(2);
    const [a, b] = players as [Client, Client];
    const ace = workTop(room.game!, a.seat, 0);
    await a.did({ k: 'hold', cardId: ace });
    a.drag(ace);
    await vi.waitFor(() => expect(b.drags).toHaveLength(1));
    await vi.waitFor(() => expect(me(b.game, a.seat).holding).toBe(ace));
    // A second socket with the same token (a duplicated tab): the newest wins, and the card is not in its hand.
    const a2 = await open(a.code, 'P0', a.token);
    await vi.waitFor(() => expect(a.closeCode).toBe(CLOSE_OVER));
    await vi.waitFor(() => expect(me(b.game, a.seat).holding).toBeNull());
    expect(me(a2.game, a.seat).holding).toBeNull();
    expect(me(a2.game, a.seat).work[0]!.at(-1)!.id).toBe(ace);
    a2.drag(ace); // not held by this socket's player any more
    await a2.synced();
    await b.synced();
    expect(b.drags).toHaveLength(1);
    // Held again, then the network drops.
    await a2.did({ k: 'hold', cardId: ace });
    await vi.waitFor(() => expect(me(b.game, a.seat).holding).toBe(ace));
    await a2.close();
    await vi.waitFor(() => expect(me(b.game, a.seat).holding).toBeNull());
    expect(b.last.room.players.find((p) => p.seat === a.seat)!.connected).toBe(false);
    // Nertz called while they are away: no grace window for a card nobody holds.
    const a3 = await open(a.code, 'P0', a.token);
    expect(a3.game).toEqual(wire(viewFor(room.game!, a.seat)));
    await a3.did(move(ace, felt(0, 0)));
    expect(room.game!.slots[0]!.cards.map((c) => c.id)).toEqual([ace]);
    expect(checkInvariants(room.game!)).toBeNull();
    await converged(room, [a3, b]);
  });
});

// ---------------------------------------------------------------- bots and a swarm together

/** What a careless, impatient, slightly dishonest client sends next, going by its last (stale) view. */
function swarmIntent(view: GameState, seat: number, rnd: Rng): Intent {
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
  const p = me(view, seat);
  const mine = [...p.nertz.slice(-1), ...p.waste.slice(-1), ...p.work.flat()];
  const roll = rnd();
  if (roll < 0.5) {
    const legal = mine.flatMap((c) => legalDrops(view, seat, c.id).map((to) => move(c.id, to, grab(view, seat, c.id)!.cards.length)));
    const toCentre = legal.filter((m) => m.k === 'move' && m.to.k !== 'work');
    if (legal.length > 0) return pick(toCentre.length > 0 && rnd() < 0.85 ? toCentre : legal);
    return { k: 'flip' };
  }
  if (roll < 0.68) return { k: 'flip' };
  if (roll < 0.7) return { k: 'stuck', on: rnd() < 0.5 };
  if (roll < 0.74) return { k: 'nertz' };
  if (roll < 0.82) return mine.length > 0 ? { k: 'hold', cardId: pick(mine).id } : { k: 'release' };
  if (roll < 0.86) return { k: 'release' };
  if (roll < 0.93) return { k: 'clear', slot: Math.floor(rnd() * view.slots.length) };
  if (roll < 0.97 && mine.length > 0) return move(pick(mine).id, felt(Math.round((rnd() * 2 - 1) * 1000) / 1000, Math.round((rnd() * 2 - 1) * 1000) / 1000));
  const all = view.players.flatMap((q) => [...q.nertz, ...q.waste, ...q.stock, ...q.work.flat()]);
  return move(pick(all).id, pick([slot(Math.floor(rnd() * 24)), { k: 'work', i: Math.floor(rnd() * 4) } as PileRef]));
}

describe('four bots and a swarm at one table', () => {
  class Tap implements Conn {
    last: StateMsg | null = null;
    drags = 0;
    bad: string[] = [];
    send(msg: ServerMsg): void {
      if (msg.t === 'drag') this.drags++;
      if (msg.t !== 'state') return;
      this.last = wire(msg);
      const g = this.last.room.game;
      if (g) this.bad.push(...leaks(g), ...[checkInvariants(g)].filter((x): x is string => x !== null));
    }
    close(): void {}
  }
  afterEach(() => void vi.useRealTimers());

  it('every invariant holds after every single intent, bots and swarm alike, through whole rounds', () => {
    vi.useFakeTimers();
    const rnd = seeded(5);
    const room = new Room('SWRM', { rng: seeded(31), schedule: (flush) => void setTimeout(flush, 0) });
    const taps = [new Tap(), new Tap()];
    taps.forEach((t, i) => expect(room.join(t, `S${i}`, `swarm-tok-${i}`, true)).toBeNull());
    for (let i = 0; i < 4; i++) room.handle(taps[0]!, { t: 'addBot', level: 'fast' });
    // Every intent, whoever sends it, goes through this one method: look at the table after each.
    const inner = (room as unknown as { intent: (...args: unknown[]) => void }).intent.bind(room);
    const problems: string[] = [];
    const count = { intents: 0, accepted: 0, bots: 0, rounds: 0, cleared: 0, graces: 0 };
    (room as unknown as { intent: (...args: unknown[]) => void }).intent = (...args) => {
      const before = room.game;
      inner(...args);
      count.intents++;
      if (room.game !== before) count.accepted++;
      if ((args[0] as { bot?: unknown }).bot) count.bots++;
      const bad = checkInvariants(room.game!);
      if (bad) problems.push(`after ${JSON.stringify(args[2])}: ${bad}`);
      if (room.game!.grace.length > 0) count.graces++;
    };
    const seqs = [0, 0];
    for (let round = 0; round < 3; round++) {
      room.handle(taps[0]!, { t: 'start' });
      expect(room.game!.players).toHaveLength(6);
      vi.advanceTimersByTime(1); // (the first snapshot of the round)
      // The swarm does not wait for the cards, the dealer or the count: it fires all the way through the opening.
      for (const [stage, ms] of [['dealing', DEAL_MS], ['ready', 1], ['countdown', START_MS]] as const) {
        expect(room.game!.stage).toBe(stage);
        const state = room.game;
        for (let n = 0; n < 60; n++) taps.forEach((t, i) => room.handle(t, { t: 'intent', seq: seqs[i]!++, intent: swarmIntent(t.last!.room.game!, i, rnd) }));
        expect(room.game).toBe(state);
        if (stage === 'ready') room.handle(taps[0]!, { t: 'go' });
        vi.advanceTimersByTime(ms);
      }
      expect(room.game!.stage).toBe('play');
      for (let step = 0; step < 6000 && room.phase === 'playing'; step++) {
        // A burst from each swarm client on the view it last got, then a little time for the bots and the snapshots.
        taps.forEach((t, i) => {
          for (let n = Math.floor(rnd() * 4); n > 0; n--) {
            const intent = swarmIntent(t.last!.room.game!, i, rnd);
            room.handle(t, { t: 'intent', seq: seqs[i]!++, intent });
            if (intent.k === 'hold') room.handle(t, { t: 'drag', id: intent.cardId, w: 0.5, h: [0, 0], p: [0, 0] });
          }
        });
        vi.advanceTimersByTime(40);
      }
      if (room.phase === 'playing') continue; // (jammed: deal again from the lobby is not possible mid-round, so stop here)
      count.rounds++;
      count.cleared += room.game!.tray.length;
      expect(checkInvariants(room.game!)).toBeNull();
      const played = room.lastRound!.scores.reduce((sum, s) => sum + s.played, 0);
      expect(played).toBe([...room.game!.slots.map((s) => s?.cards ?? []), ...room.game!.tray].flat().length);
    }
    expect(problems).toEqual([]);
    expect(taps.flatMap((t) => t.bad)).toEqual([]);
    expect(count.rounds).toBeGreaterThan(0);
    expect(count.bots).toBeGreaterThan(50);
    expect(count.accepted).toBeGreaterThan(300);
    expect(count.intents).toBeGreaterThan(count.accepted);
    for (const t of taps) expect(t.last!.room.game).toEqual(wire(viewFor(room.game!, 0)));
  });
});
