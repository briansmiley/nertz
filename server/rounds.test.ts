// Rounds kept, and one person's record of them: the table by itself, a room handing its rounds over, and the whole way
// round over the wire (signed in, a round played, the record asked for).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deal, type Rng } from '../shared/engine';
import { rig } from '../shared/testkit';
import type { GameState, Stats } from '../shared/types';
import { openDb, type Db } from './db';
import { startServer, type NertzServer } from './index';
import { openRounds, type RoundRecord } from './rounds';
import { ACCOUNTS, ADA, BOB, Browser, Client, fakeGoogle, FakeConn, roomWith, rows, startOver, startRound } from './testkit';

/** A hand of a round, said shortly: who (an account, a bot, or with neither a guest), and what they scored. */
const hand = (seat: number, who: string | null, delta: number, bot: 'slow' | null = null): RoundRecord['hands'][number] => ({ seat, player: seat + 1, name: who ?? (bot ? 'Bot' : 'Guest'), account: who, bot, out: null, played: Math.max(delta, 0), nertzLeft: Math.max(-delta, 0) / 2, delta });
const round = (hands: RoundRecord['hands'], end: RoundRecord['end'] = { by: 'vote' }, number = 1, snipes: RoundRecord['snipes'] = []): RoundRecord => ({ game: 'g1', code: 'TEST', number, end, ms: 60_000, hands, snipes });

describe('rounds kept', () => {
  let db: Db;
  beforeEach(() => {
    db = openDb(':memory:');
  });
  afterEach(() => db.close());

  it('someone who has played nothing has a record of noughts', () => {
    expect(openRounds(db).stats('ada')).toEqual({ rounds: 0, won: 0, nertz: 0, points: 0, bestPoints: null, cards: 0, bestCards: null, nertzLeft: 0, ahead: null, snipes: 0, sniped: 0 } satisfies Stats);
  });

  it("adds up one person's rounds: how many, their points, cards played and nertz left, the most of each, and the ones they got Nertz in", () => {
    const rounds = openRounds(db);
    rounds.keep(round([hand(0, 'ada', 12), hand(1, 'bob', 5)], { by: 'nertz', seat: 0, out: [0] }));
    rounds.keep(round([hand(0, 'bob', 20), hand(1, 'ada', -4)], { by: 'nertz', seat: 0, out: [0, 1] }, 2)); // (ada went out too, without calling)
    rounds.keep(round([hand(0, 'ada', 7), hand(1, null, 3)], { by: 'jam' }, 3));
    expect(rounds.stats('ada')).toEqual({ rounds: 3, won: 2, nertz: 2, points: 15, bestPoints: 12, cards: 19, bestCards: 12, nertzLeft: 2, ahead: 2 / 3, snipes: 0, sniped: 0 });
    expect(rounds.stats('bob')).toEqual({ rounds: 2, won: 1, nertz: 1, points: 25, bestPoints: 20, cards: 25, bestCards: 20, nertzLeft: 0, ahead: 0.5, snipes: 0, sniped: 0 });
  });

  it('a round is won by everyone with its best score, against a guest or a bot as against anyone; alone, by nobody', () => {
    const rounds = openRounds(db);
    rounds.keep(round([hand(0, 'ada', 9), hand(1, 'bob', 9), hand(2, null, 2)]));
    rounds.keep(round([hand(0, 'ada', 4), hand(1, null, 6, 'slow')], undefined, 2));
    rounds.keep(round([hand(0, 'ada', 30)], undefined, 3));
    expect(rounds.stats('ada')).toMatchObject({ rounds: 3, won: 1 });
    expect(rounds.stats('bob')).toMatchObject({ rounds: 1, won: 1 });
  });

  it('says how far ahead someone finished, as the share of the others they beat, a tie counting half: the same at a table of any size', () => {
    const rounds = openRounds(db);
    rounds.keep(round([hand(0, 'ada', 9), hand(1, 'bob', 9), hand(2, null, 12)])); // ada: 0 of 2 beaten, 1 tied
    rounds.keep(round([hand(0, 'ada', 1), hand(1, null, 6), hand(2, null, 5)], undefined, 2)); // last of three
    rounds.keep(round([hand(0, 'ada', 30)], undefined, 3)); // (alone: nobody to be ahead of)
    expect(rounds.stats('ada')).toMatchObject({ rounds: 3, ahead: (0.25 + 0) / 2 });
    expect(rounds.stats('bob')).toMatchObject({ ahead: 0.25 });
    // The middle of a table is a half whatever its size; first is 1 and last 0 at two as at six.
    const middle = openDb(':memory:');
    try {
      const kept = openRounds(middle);
      kept.keep(round([hand(0, 'cy', 5), hand(1, null, 9), hand(2, null, 1)]));
      kept.keep(round([hand(0, 'cy', 5), hand(1, null, 9), hand(2, null, 8), hand(3, null, 2), hand(4, null, 1)], undefined, 2));
      kept.keep(round([hand(0, 'cy', 2), hand(1, null, 1)], undefined, 3));
      kept.keep(round([hand(0, 'cy', 0), ...[1, 2, 3, 4, 5].map((s) => hand(s, null, s))], undefined, 4));
      expect(kept.stats('cy').ahead).toBeCloseTo((0.5 + 0.5 + 1 + 0) / 4);
    } finally {
      middle.close();
    }
  });

  it('counts every round, only those with someone else there who is no bot, or only those with no bot at all', () => {
    const rounds = openRounds(db);
    rounds.keep(round([hand(0, 'ada', 1), hand(1, null, 2, 'slow')])); // ada and a bot
    rounds.keep(round([hand(0, 'ada', 2), hand(1, null, 1), hand(2, null, 9, 'slow')], undefined, 2)); // ada, a guest, a bot
    rounds.keep(round([hand(0, 'ada', 4), hand(1, 'bob', 3)], undefined, 3)); // ada and bob
    expect(rounds.stats('ada', 'all')).toMatchObject({ rounds: 3, points: 7 });
    expect(rounds.stats('ada', 'people')).toMatchObject({ rounds: 2, points: 6 });
    expect(rounds.stats('ada', 'no-bots')).toMatchObject({ rounds: 1, points: 4, won: 1, ahead: 1 });
  });

  it('keeps the round and every hand of it, or none of it', () => {
    const rounds = openRounds(db);
    expect(() => rounds.keep(round([hand(0, 'ada', 1), hand(0, 'bob', 2)]))).toThrow(); // (two hands at one seat)
    expect(db.prepare('select count(*) as n from round').get()).toEqual({ n: 0 });
    rounds.keep(round([hand(0, 'ada', 1), hand(1, null, 2, 'slow')], { by: 'nertz', seat: 1, out: [1] }), 1234);
    expect(db.prepare('select created_at, code, number, ending, ms from round').all()).toEqual([{ created_at: 1234, code: 'TEST', number: 1, ending: 'nertz', ms: 60_000 }]);
    expect(db.prepare('select seat, account, bot, delta, nertz from hand order by seat').all()).toEqual([
      { seat: 0, account: 'ada', bot: null, delta: 1, nertz: 0 },
      { seat: 1, account: null, bot: 'slow', delta: 2, nertz: 1 },
    ]);
  });

  it('counts the snipes someone made and suffered, and keeps each hand under its name and each round in its sitting', () => {
    const rounds = openRounds(db);
    rounds.keep(round([hand(0, 'ada', 5), hand(1, 'bob', 3), hand(2, null, 1)], undefined, 1, [{ by: 0, of: 1, card: 'H3' }, { by: 0, of: 2, card: 'S7' }, { by: 1, of: 0, card: 'D2' }]));
    rounds.keep(round([hand(0, 'bob', 5), hand(1, 'ada', 3)], undefined, 2, [{ by: 1, of: 0, card: 'C9' }]));
    expect(rounds.stats('ada')).toMatchObject({ snipes: 3, sniped: 1 });
    expect(rounds.stats('bob')).toMatchObject({ snipes: 1, sniped: 2 });
    expect(db.prepare('select name, account from hand order by round, seat').all()).toEqual([
      { name: 'ada', account: 'ada' },
      { name: 'bob', account: 'bob' },
      { name: 'Guest', account: null },
      { name: 'bob', account: 'bob' },
      { name: 'ada', account: 'ada' },
    ]);
    expect(db.prepare('select distinct game from round').all()).toEqual([{ game: 'g1' }]);
    // A snipe is between two hands of its round: one naming a seat nobody played keeps nothing of the round.
    expect(() => rounds.keep(round([hand(0, 'ada', 5), hand(1, 'bob', 3)], undefined, 3, [{ by: 0, of: 4, card: 'H3' }]))).toThrow();
    expect(db.prepare('select count(*) as n from round').get()).toEqual({ n: 2 });
  });

  it('undoes only the transaction it began: one already open is left as it was', () => {
    db.exec('BEGIN');
    db.exec(`insert into round (created_at, game, code, number, ending, ms) values (1, 'g0', 'X', 1, 'vote', 0)`);
    expect(() => openRounds(db).keep(round([hand(0, 'ada', 1)]))).toThrow();
    expect(db.isTransaction).toBe(true);
    db.exec('COMMIT');
    expect(db.prepare('select count(*) as n from round').get()).toEqual({ n: 1 });
  });

  it('the tables are made once: a database opened again has what it had', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nertz-rounds-'));
    try {
      const first = openDb(join(dir, 'nertz.db'));
      openRounds(first).keep(round([hand(0, null, 3), hand(1, null, 4)]));
      first.close();
      const again = openDb(join(dir, 'nertz.db'));
      expect(again.prepare('select count(*) as n from hand').get()).toEqual({ n: 2 });
      again.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('a room hands its rounds over', () => {
  /** Seat 0 is dealt an empty nertz pile: they have only to call. */
  const rigged = (seats: readonly number[], rng: Rng): GameState => rig(deal(seats, rng), { work: ['S1', 'S2', 'H1', 'D5'], emptyNertz: [0] });

  it('as each is scored: every hand, and whose it was if they were signed in', () => {
    const kept: RoundRecord[] = [];
    const { room } = roomWith(0, { deal: rigged, record: (r) => kept.push(r) });
    const [a, b] = [new FakeConn(), new FakeConn()];
    room.join(a, 'Ada', 'tok-000a', true, 'ada');
    room.join(b, 'Guest', 'tok-000b', true);
    room.handle(a, { t: 'addBot', level: 'slow' });
    startRound(room, a);
    expect(kept).toEqual([]);
    room.handle(a, { t: 'intent', seq: 0, intent: { k: 'nertz' } });
    expect(room.phase).toBe('results');
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ code: 'TEST', number: 1, end: { by: 'nertz', seat: 0 } });
    expect(kept[0]!.hands.map((h) => [h.seat, h.account, h.bot])).toEqual([
      [0, 'ada', null],
      [1, null, null],
      [2, null, 'slow'],
    ]);
    expect(kept[0]!.hands.map((h) => h.delta)).toEqual(room.lastRound!.scores.map((s) => s.delta));
    expect(kept[0]!.hands.map((h) => h.name)).toEqual(room.lastRound!.scores.map((s) => s.name));
    expect(kept[0]!.hands[1]!.name).toBe('Guest');
    expect(new Set(kept[0]!.hands.map((h) => h.player)).size).toBe(3);

    // The next round is of the same sitting; once the table is started over, its rounds are of another.
    startRound(room, a);
    room.handle(a, { t: 'intent', seq: 1, intent: { k: 'nertz' } });
    expect(kept[1]!.game).toBe(kept[0]!.game);
    room.handle(a, { t: 'reset' });
    startRound(room, a);
    room.handle(a, { t: 'intent', seq: 2, intent: { k: 'nertz' } });
    expect(kept).toHaveLength(3);
    expect(kept[2]!.game).not.toBe(kept[0]!.game);
  });

  it('one seat to an account: a second window of it watches until the first stands up', () => {
    const kept: RoundRecord[] = [];
    const { room } = roomWith(0, { record: (r) => kept.push(r) });
    const [a, again, b] = [new FakeConn(), new FakeConn(), new FakeConn()];
    room.join(a, 'Ada', 'tok-000a', true, 'ada');
    room.join(again, 'Ada', 'tok-001a', true, 'ada');
    room.join(b, 'Bob', 'tok-000b', true, 'bob');
    room.flush();
    expect(again.states.at(-1)!.room.seat).toBeNull();
    startRound(room, a);
    room.handle(a, { t: 'intent', seq: 0, intent: { k: 'end', on: true } });
    room.handle(b, { t: 'intent', seq: 0, intent: { k: 'end', on: true } });
    expect(kept[0]!.hands.map((h) => h.account)).toEqual(['ada', 'bob']);
    room.handle(a, { t: 'sit', on: false });
    room.flush();
    expect(again.states.at(-1)!.room.seat).not.toBeNull();
  });

  it('a hand whose player left before the round was over is still theirs, and says they left', () => {
    const kept: RoundRecord[] = [];
    const { room } = roomWith(0, { deal: rigged, record: (r) => kept.push(r) });
    const [a, b, c] = [new FakeConn(), new FakeConn(), new FakeConn()];
    room.join(a, 'Ada', 'tok-000a', true, 'ada');
    room.join(b, 'Bob', 'tok-000b', true, 'bob');
    room.join(c, 'Cy', 'tok-000c', true);
    startRound(room, a);
    room.handle(b, { t: 'leave' });
    room.handle(a, { t: 'intent', seq: 0, intent: { k: 'nertz' } });
    expect(kept[0]!.hands.map((h) => [h.name, h.account, h.out])).toEqual([
      ['Ada', 'ada', null],
      ['Bob', 'bob', 'left'],
      ['Cy', null, null],
    ]);
  });

  it('who someone is signed in as is what their connection last said: signed out and back, the hand is nobody\'s', () => {
    const kept: RoundRecord[] = [];
    const { room } = roomWith(0, { record: (r) => kept.push(r) });
    const [a, b] = [new FakeConn(), new FakeConn()];
    room.join(a, 'Ada', 'tok-000a', true, 'ada');
    room.join(b, 'Bob', 'tok-000b', true, 'bob');
    const again = new FakeConn();
    room.join(again, 'Ada', 'tok-000a', true, null); // the same window, come back signed out
    startRound(room, again);
    room.handle(again, { t: 'intent', seq: 0, intent: { k: 'end', on: true } });
    room.handle(b, { t: 'intent', seq: 0, intent: { k: 'end', on: true } });
    expect(kept[0]!.hands.map((h) => h.account)).toEqual([null, 'bob']);
  });

  it('shows everyone the picture an account put up, and none once it is nobody there', () => {
    let flush = (): void => {};
    const { room } = roomWith(0, { schedule: (f) => void (flush = f) });
    const [a, b] = [new FakeConn(), new FakeConn()];
    room.join(a, 'Ada', 'tok-000a', true, 'ada', '/pictures/0123456789abcdef.webp');
    room.join(b, 'Guest', 'tok-000b', true);
    flush();
    expect(b.last.room.players.map((p) => p.picture)).toEqual(['/pictures/0123456789abcdef.webp', undefined]);
    room.forgetAccount('ada');
    room.join(b, 'Guest', 'tok-000b', true); // (a fresh snapshot)
    flush();
    expect(b.last.room.players.map((p) => p.picture)).toEqual([undefined, undefined]);
  });
});

describe('over the wire', () => {
  let server: NertzServer;
  let dir: string;
  beforeEach(async () => {
    fakeGoogle();
    dir = mkdtempSync(join(tmpdir(), 'nertz-rounds-'));
    server = await startServer({ port: 0, dist: '/nonexistent', data: join(dir, 'nertz.db'), accounts: ACCOUNTS });
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('a round played signed in is on your record, and on nobody else\'s; a guest has none', async () => {
    const [ada, bob, guest] = [new Browser(server.port), new Browser(server.port), new Browser(server.port)];
    await ada.signIn(ADA);
    await bob.signIn(BOB);
    expect(await (await ada.ask('/stats')).json()).toEqual({ rounds: 0, won: 0, nertz: 0, points: 0, bestPoints: null, cards: 0, bestCards: null, nertzLeft: 0, ahead: null, snipes: 0, sniped: 0 });
    expect(await (await ada.ask('/stats?among=no-bots')).json()).toMatchObject({ rounds: 0 });
    expect((await ada.ask('/stats?among=robots')).status).toBe(400);
    expect((await guest.ask('/stats')).status).toBe(401);

    const a = await Client.open(server.port, null, 'Ada', undefined, true, ada.cookie);
    const g = await Client.open(server.port, a.last.room.code, 'Guest');
    const room = server.rooms.get(a.last.room.code)!;
    await startOver(room, a, [a, g]);
    await a.did({ k: 'end', on: true });
    await g.did({ k: 'end', on: true });
    await vi.waitFor(() => expect(room.phase).toBe('results'));

    const mine = (await (await ada.ask('/stats')).json()) as Stats;
    const line = room.lastRound!.scores.find((s) => s.id === a.last.room.me)!;
    expect(mine).toMatchObject({ rounds: 1, nertz: 0, points: line.delta, bestPoints: line.delta, cards: line.played, bestCards: line.played, nertzLeft: line.nertzLeft });
    expect(await (await bob.ask('/stats')).json()).toMatchObject({ rounds: 0 });
    a.ws.terminate();
    g.ws.terminate();
  });

  it('an account deleted while it sits at a table plays on there as nobody: the round it finishes is kept as nobody\'s', async () => {
    const ada = new Browser(server.port);
    await ada.signIn(ADA);
    const elsewhere = new Browser(server.port);
    await elsewhere.signIn(ADA); // (the same person, on another device)
    const a = await Client.open(server.port, null, 'Ada', undefined, true, ada.cookie);
    const g = await Client.open(server.port, a.last.room.code, 'Guest');
    const room = server.rooms.get(a.last.room.code)!;
    await startOver(room, a, [a, g]);
    expect((await elsewhere.ask('/profile', undefined, { method: 'DELETE' })).status).toBe(204);
    await a.did({ k: 'end', on: true });
    await g.did({ k: 'end', on: true });
    await vi.waitFor(() => expect(room.phase).toBe('results'));
    await vi.waitFor(() => expect(rows(join(dir, 'nertz.db'), 'hand')).toHaveLength(2));
    expect(rows(join(dir, 'nertz.db'), 'hand').map((h) => h.account)).toEqual([null, null]);
    a.ws.terminate();
    g.ws.terminate();
  });

  it("a socket opened from some other site's page, in a browser signed in here, is a guest's: its round is on nobody's record", async () => {
    const ada = new Browser(server.port);
    await ada.signIn(ADA);
    const a = await Client.open(server.port, null, 'Ada', undefined, true, ada.cookie, 'https://elsewhere.example');
    const g = await Client.open(server.port, a.last.room.code, 'Guest');
    const room = server.rooms.get(a.last.room.code)!;
    await startOver(room, a, [a, g]);
    await a.did({ k: 'end', on: true });
    await g.did({ k: 'end', on: true });
    await vi.waitFor(() => expect(room.phase).toBe('results'));
    expect(await (await ada.ask('/stats')).json()).toMatchObject({ rounds: 0 });
    a.ws.terminate();
    g.ws.terminate();
  });

  it('with nothing kept, or nobody able to sign in, there are no records to ask for', async () => {
    const bare = await startServer({ port: 0, dist: '/nonexistent' });
    const kept = await startServer({ port: 0, dist: '/nonexistent', data: ':memory:' });
    try {
      expect([bare.kept, kept.kept, kept.accounts]).toEqual([false, true, false]);
      expect((await fetch(`http://localhost:${bare.port}/stats`)).status).toBe(404);
      expect((await fetch(`http://localhost:${kept.port}/stats`)).status).toBe(404);
    } finally {
      await bare.close();
      await kept.close();
    }
  });
});
