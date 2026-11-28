// A hand-written client against the real server, over real sockets, trying to cheat: racing for the same pile, spot and
// patch of felt, moving cards with position reports, dealing faster than a card per message, acting before play opens,
// getting round clear-first, reading faces early, and reconnecting at every awkward moment. Nothing here uses the
// client's code: only the wire.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { calledBy, checkInvariants, deal, hasOpened, inGrace, isHidden, viewFor } from '../shared/engine';
import { CLOSE_OVER, DEAL_MS, DRAG_BURST, START_MS, type ServerMsg } from '../shared/protocol';
import { felt, FUZZ_MS, nertzOf, run, MIXES, move, randomIntent, rig, seeded, slot, untilReached, wire, workTop } from '../shared/testkit';
import type { AnyCard, GameState, PileRef } from '../shared/types';
import { CLOSE_FLOOD, startServer, type NertzServer } from './index';
import { Room, type Conn } from './room';
import { Client, startOver, type StateMsg } from './testkit';

const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

/**
 * Which cards of a snapshot sent to `you` show a face that the rules say it may not see yet. Judged from the snapshot
 * alone, by where each card lies: written out here on purpose, not borrowed from `viewFor`. While cards can move the
 * player may see its own cards that its next move could turn over: the card under its nertz top, and the top
 * face-down card of each work pile. Nobody else may, and never deeper into a nertz pile. A stock never shows a face;
 * a waste does once play has opened, a group in flight onto it included (a draw is one snapshot, faces and all).
 */
function leaks(g: GameState, you: number | null): string[] {
  const out: string[] = [];
  const faceUp = (c: AnyCard) => !isHidden(c);
  const shut = !hasOpened(g);
  for (const p of g.players) {
    const at = `${g.status.at} seat ${p.seat}${p.seat === you ? ' (yours)' : ''}`;
    const next = (g.status.at === 'play' || g.status.at === 'grace') && p.seat === you;
    p.stock.forEach((c, i) => faceUp(c) && out.push(`${at}: stock card ${i} with a face`));
    p.nertz.forEach((c, i) => faceUp(c) && (i < p.nertz.length - 1 || shut) && !(next && i === p.nertz.length - 2) && out.push(`${at}: nertz card ${i} with a face`));
    p.work.forEach((w, k) => w.cards.forEach((c, i) => faceUp(c) && (i < w.down || g.status.at === 'dealing') && !(next && i === w.down - 1) && out.push(`${at}: work ${k} card ${i} with a face`)));
    p.waste.forEach((c, i) => faceUp(c) && shut && out.push(`${at}: waste card ${i} with a face`));
  }
  return out;
}

const me = (g: GameState, seat: number) => g.players.find((p) => p.seat === seat)!;
const piles = (g: GameState) => g.slots.filter((s) => s !== null);

describe('a hostile client over real sockets', () => {
  let server: NertzServer;
  let dist: string;
  const clients: Client[] = [];
  const open = async (room: string | null, name: string, token?: string) => {
    const c = await Client.open(server.port, room, name, token);
    clients.push(c);
    return c;
  };
  /** How the server deals the next table's round. */
  let dealing: typeof deal = deal;
  /** `n` people at a new table, its round dealt by `how` but not yet started. */
  const seated = async (n: number, how: typeof deal) => {
    const players = [await open(null, 'P0')];
    for (let i = 1; i < n; i++) players.push(await open(players[0]!.code, `P${i}`));
    dealing = how;
    return { room: server.rooms.get(players[0]!.code)!, players };
  };
  /** A table of `n` people with the cards dealt (stage `dealing`, the deal timer running). */
  const dealt = async (n: number) => {
    const t = await seated(n, deal);
    t.players[0]!.send({ t: 'start' });
    await vi.waitFor(() => t.players.forEach((p) => expect(p.last.room.phase).toBe('playing')));
    return t;
  };
  /** The same with the hands rigged, and dealt, started and counted in to play; every client has seen the table. */
  const playing = async (n: number, emptyNertzFor: number[] = [], also: (g: GameState) => GameState = (g) => g) => {
    const t = await seated(n, (seats, rng) => also(rig(deal(seats, rng), { work: ['S1', 'S2', 'H1', 'C13'], emptyNertz: emptyNertzFor })));
    await startOver(t.room, t.players[0]!, t.players);
    expect(checkInvariants(t.room.game!)).toBeNull();
    await converged(t.room, t.players);
    return t;
  };
  const converged = (room: Room, players: Client[]) =>
    vi.waitFor(() => {
      for (const p of players) expect(p.game).toEqual(wire(viewFor(room.game!, p.seat)));
    });

  beforeAll(async () => {
    dist = mkdtempSync(join(tmpdir(), 'nertz-hostile-'));
    writeFileSync(join(dist, 'index.html'), '<!doctype html><title>nertz</title>');
    server = await startServer({ port: 0, dist, deal: (seats, rng) => dealing(seats, rng) }); // the real rate limit
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
        expect(leaks(s.room.game, s.room.seat)).toEqual([]);
        expect(checkInvariants(s.room.game)).toBeNull();
      }
    }
    await Promise.all(clients.splice(0).map((c) => c.drop()));
  });

  it('races: one pile, one patch of felt: exactly one lands every time, the other goes home, everyone converges', async () => {
    const { room, players } = await playing(3);
    // Three Aces of spades for the same place, sent in the same instant.
    const seqs = players.map((p) => p.intent(move(workTop(room.game!, p.seat, 0), felt(0.1, 0.1))));
    await vi.waitFor(() => players.forEach((p, i) => expect(p.last.ack).toBe(seqs[i])));
    expect(piles(room.game!)).toHaveLength(1);
    const at = room.game!.slots.findIndex((s) => s?.cards.length === 1);
    const winner = room.game!.slots[at]!.cards[0].owner;
    for (const p of players) expect(me(room.game!, p.seat).work[0]!.cards.length).toBe(p.seat === winner ? 0 : 1); // the losers' Aces lie where they lay
    // Three twos of spades for that one pile.
    const twos = players.map((p) => p.intent(move(workTop(room.game!, p.seat, 1), slot(at))));
    await vi.waitFor(() => players.forEach((p, i) => expect(p.last.ack).toBe(twos[i])));
    expect(room.game!.slots[at]!.cards.map((c) => c.rank)).toEqual([1, 2]);
    expect(players.filter((p) => me(room.game!, p.seat).work[1]!.cards.length === 1)).toHaveLength(2);
    // Overlapping, not identical, patches of felt: still one. A patch well clear of it: both.
    const [a, b] = players as [Client, Client, Client];
    const hearts = [a, b].map((p) => workTop(room.game!, p.seat, 2));
    const s = [a.intent(move(hearts[0]!, felt(-0.5, -0.2))), b.intent(move(hearts[1]!, felt(-0.47, -0.18)))];
    await vi.waitFor(() => [a, b].forEach((p, i) => expect(p.last.ack).toBe(s[i])));
    expect(piles(room.game!)).toHaveLength(2);
    const loser = [a, b].find((p) => me(room.game!, p.seat).work[2]!.cards.length === 1)!;
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

  it('the stock gives one group per draw whatever the messages say, and everyone is sent it whole, never card by card', async () => {
    const { room, players } = await playing(2);
    const [a, b] = players as [Client, Client];
    const stock = me(room.game!, a.seat).stock.length;
    // Everything a doctored client might hope deals more: extra fields, a list of messages, a list of intents, the same
    // sequence number again, and draws on top of a draw in flight.
    await a.did({ k: 'draw', count: 3, n: 3, cards: 3 });
    a.send([{ t: 'intent', seq: a.seq, intent: { k: 'draw' } }, { t: 'intent', seq: a.seq + 1, intent: { k: 'draw' } }]);
    a.send({ t: 'intent', seq: a.seq, intent: [{ k: 'draw' }, { k: 'draw' }] });
    a.send({ t: 'intent', seq: a.seq, intents: [{ k: 'draw' }, { k: 'draw' }] });
    a.send(`${JSON.stringify({ t: 'intent', seq: a.seq, intent: { k: 'draw' } })}\n${JSON.stringify({ t: 'intent', seq: a.seq + 1, intent: { k: 'draw' } })}`);
    a.send({ t: 'intent', seq: a.seq - 1, intent: { k: 'draw' } });
    let last = 0;
    for (let i = 0; i < 20; i++) last = a.intent({ k: 'draw' });
    await vi.waitFor(() => expect(a.last.ack).toBe(last));
    // One group, on the waste in one step: the draws on top of it were refused while it is in flight.
    expect(me(room.game!, a.seat)).toMatchObject({ stock: { length: stock - 3 }, waste: { length: 3 } });
    expect(me(room.game!, b.seat).stock).toHaveLength(stock); // and nobody else's stock was touched
    await converged(room, players);
    const group = me(room.game!, a.seat).waste.map((c) => c.id);
    for (const p of players) {
      // No snapshot ever had part of it: the group came whole, and everyone sees it.
      for (const { room: r } of p.states) {
        const h = r.game && me(r.game, a.seat);
        if (h) expect([0, 3]).toContain(h.waste.length);
      }
      expect(me(p.game, a.seat).waste.some(isHidden)).toBe(false);
      expect(me(p.game, a.seat).waste.map((c) => c.id)).toEqual(group);
    }
  });

  it('nothing is accepted, forwarded or shown before play opens: every intent, a position report and a reconnect, in dealing, ready and the count', async () => {
    const { room, players } = await dealt(3);
    const [a, b, c] = players as [Client, Client, Client];
    const truth = room.game!;
    const faceUp = (p: Client) => p.game.players.flatMap((q) => [...q.nertz, ...q.work.flatMap((w) => w.cards), ...q.stock, ...q.waste]).filter((x) => !isHidden(x)).length;
    /** Everything a client can send, about every card of its own and somebody else's top cards. */
    const everything = async (p: Client) => {
      const mine = me(truth, p.seat);
      const other = me(truth, (p.seat + 1) % 3);
      const ids = [mine.nertz.at(-1)!.id, ...mine.work.map((w) => w.cards.at(-1)!.id), mine.stock.at(-1)!.id, other.work[0]!.cards.at(-1)!.id];
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
    const closed = async (stage: GameState['status']['at'], shown: number) => {
      await vi.waitFor(() => players.forEach((p) => expect(p.game.status.at).toBe(stage)), { timeout: DEAL_MS + 1000 });
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
    expect(a.last.room.timerMs).toBeNull();
    b.send({ t: 'go' });
    await b.synced();
    expect(room.game!.status.at).toBe('ready');
    a.send({ t: 'go' });
    await closed('countdown', 3 * 4);
    expect(players[2]!.last.room.timerMs).toBeGreaterThan(0);
    expect(players[2]!.last.room.timerMs).toBeLessThanOrEqual(START_MS);
    // The word: every nertz top turns over, for everyone, and now the same messages count.
    await vi.waitFor(() => players.forEach((p) => expect(p.game.status.at).toBe('play')), { timeout: START_MS + 1000 });
    // (And each is sent the faces its own next move could turn up: the card under its nertz top and the top buried card
    // of each of its two work piles that have any. Never a stock card.)
    for (const p of players) expect(faceUp(p)).toBe(3 * 5 + 1 + 2);
    await a.did({ k: 'draw' });
    expect(me(room.game!, a.seat).waste).toHaveLength(3);
    // Nobody was ever sent the face of a nertz top before the word. (Each client's whole history is checked after the test.)
    expect(DEAL_MS).toBeGreaterThan(0);
  }, 20_000);

  it('clear-first cannot be got round: no intent of any kind, no report, no reconnect; and nobody else is held up', async () => {
    // Seat 0's nertz pile is its clubs, the Queen down to the Ace: played out, they are one King short of finished.
    const { room, players } = await playing(2, [0], (g) => nertzOf(g, 0, run('C', 12, 1)));
    const [a, b] = players as [Client, Client];
    const top = () => me(room.game!, a.seat).nertz.at(-1)!.id;
    await a.did(move(top(), felt(0, 0)));
    const pile = room.game!.slots.findIndex((s) => s !== null);
    while (me(room.game!, a.seat).nertz.length > 0) await a.did(move(top(), slot(pile)));
    expect(room.game!.slots[pile]!.cards).toHaveLength(12);
    const king = workTop(room.game!, a.seat, 3);
    const ace = workTop(room.game!, a.seat, 0);
    // Pick another card up first, then put the King down and try everything else in the same breath.
    a.intent({ k: 'hold', cardId: ace });
    a.intent(move(king, slot(pile)));
    const tries: unknown[] = [
      { k: 'draw' },
      { k: 'stuck', on: true },
      { k: 'hold', cardId: ace },
      { k: 'release' },
      move(ace, slot(pile + 1)),
      move(ace, felt(0.5, 0.3)),
      move(ace, { k: 'work', i: 1 }),
      move(workTop(room.game!, a.seat, 1), { k: 'work', i: 2 }),
      { k: 'clear', slot: pile + 1 },
      { k: 'clear', slot: pile + 4 },
    ];
    for (const t of tries) a.intent(t);
    a.drag(ace);
    await vi.waitFor(() => expect(a.last.ack).toBe(a.seq - 1));
    await a.synced();
    const waiting = room.game!;
    expect(waiting.slots[pile]!.cards).toHaveLength(13);
    expect(me(waiting, a.seat)).toMatchObject({ holding: null, stuck: false, waste: [], work: [{ cards: { length: 1 } }, { cards: { length: 1 } }, { cards: { length: 1 } }, { cards: [] }] });
    expect(calledBy(waiting)).toBeNull();
    expect(piles(waiting)).toHaveLength(1);
    expect(b.drags).toEqual([]);
    // A new socket is held to it just the same.
    const a2 = await open(a.code, 'P0', a.token);
    for (const t of tries) a2.intent(t);
    await vi.waitFor(() => expect(a2.last.ack).toBe(a2.seq - 1));
    expect(room.game).toBe(waiting);
    // The other player is not held up, and cannot clear it for them.
    await b.did({ k: 'clear', slot: pile });
    expect(room.game).toBe(waiting);
    await b.did({ k: 'draw' });
    expect(me(room.game!, b.seat).waste).toHaveLength(3);
    // Into the tray, and everything works again.
    await a2.did({ k: 'clear', slot: pile });
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
    expect(me(a2.game, a.seat).work[0]!.cards.at(-1)!.id).toBe(ace);
    a2.drag(ace); // not held by this socket's player any more
    await a2.synced();
    await b.synced();
    expect(b.drags).toHaveLength(1);
    // Held again, then the network drops.
    await a2.did({ k: 'hold', cardId: ace });
    await vi.waitFor(() => expect(me(b.game, a.seat).holding).toBe(ace));
    await a2.drop();
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
      if (g) this.bad.push(...leaks(g, this.last.room.seat), ...[checkInvariants(g)].filter((x): x is string => x !== null));
    }
    close(): void {}
  }
  afterEach(() => void vi.useRealTimers());

  it('every invariant holds after every single intent, bots and swarm alike, through whole rounds', () => {
    vi.useFakeTimers();
    // Tables until a round has been played out, a grace window has opened, and the bots have had their say.
    untilReached({ round: 1, grace: 1, 'bot intent': 50, accepted: 300 }, 8, (rnd, reached, seed) => {
      const room = new Room('SWRM', { rng: seeded(1000 + seed), schedule: (flush) => void setTimeout(flush, 0) });
      const taps = [new Tap(), new Tap()];
      taps.forEach((t, i) => expect(room.join(t, `S${i}`, `swarm-tok-${i}`, true)).toBeNull());
      for (let i = 0; i < 4; i++) room.handle(taps[0]!, { t: 'addBot', level: 'fast' });
      // Every intent, whoever sends it, goes through this one method: look at the table after each.
      const inner = room['intent'].bind(room);
      const problems: string[] = [];
      const count = { intents: 0, accepted: 0 };
      room['intent'] = (...args) => {
        const before = room.game;
        const accepted = inner(...args);
        count.intents++;
        if (room.game !== before) (count.accepted++, reached('accepted'));
        if ((args[0] as { bot?: unknown }).bot) reached('bot intent');
        const bad = checkInvariants(room.game!);
        if (bad) problems.push(`after ${JSON.stringify(args[2])}: ${bad}`);
        if (inGrace(room.game!).length > 0) reached('grace');
        return accepted;
      };
      const seqs = [0, 0];
      room.handle(taps[0]!, { t: 'start' });
      expect(room.game!.players).toHaveLength(6);
      vi.advanceTimersByTime(1); // (the first snapshot of the round)
      // The swarm does not wait for the cards, the dealer or the count: it fires all the way through the opening.
      for (const [stage, ms] of [['dealing', DEAL_MS], ['ready', 1], ['countdown', START_MS]] as const) {
        expect(room.game!.status.at).toBe(stage);
        const state = room.game;
        for (let n = 0; n < 60; n++) taps.forEach((t, i) => room.handle(t, { t: 'intent', seq: seqs[i]!++, intent: randomIntent(t.last!.room.game!, i, rnd, MIXES.playing) }));
        expect(room.game).toBe(state);
        if (stage === 'ready') room.handle(taps[0]!, { t: 'go' });
        vi.advanceTimersByTime(ms);
      }
      expect(room.game!.status.at).toBe('play');
      for (let step = 0; step < 3000 && room.phase === 'playing'; step++) {
        // A burst from each swarm client on the view it last got, then a little time for the bots and the snapshots.
        taps.forEach((t, i) => {
          for (let n = Math.floor(rnd() * 4); n > 0; n--) {
            const intent = randomIntent(t.last!.room.game!, i, rnd, MIXES.playing);
            room.handle(t, { t: 'intent', seq: seqs[i]!++, intent });
            if (intent.k === 'hold') room.handle(t, { t: 'drag', id: intent.cardId, w: 0.5, h: [0, 0], p: [0, 0] });
          }
        });
        vi.advanceTimersByTime(40);
      }
      expect(problems).toEqual([]);
      expect(taps.flatMap((t) => t.bad)).toEqual([]);
      expect(count.intents).toBeGreaterThan(count.accepted);
      if (room.phase === 'playing') return room.close(); // (jammed)
      reached('round');
      expect(checkInvariants(room.game!)).toBeNull();
      const played = room.lastRound!.scores.reduce((sum, s) => sum + s.played, 0);
      expect(played).toBe([...room.game!.slots.map((s) => s?.cards ?? []), ...room.game!.tray].flat().length);
      vi.advanceTimersByTime(1);
      for (const t of taps) expect(t.last!.room.game).toEqual(wire(viewFor(room.game!, t.last!.room.seat ?? -1)));
      room.close();
    });
  }, FUZZ_MS);
});
