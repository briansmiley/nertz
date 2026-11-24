// Rounds kept, one person's record of them, and how much the game is played: the table by itself, a room handing its
// rounds over, and the whole way round over the wire (signed in, a round played, the record asked for).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deal, type Rng } from '../shared/engine';
import { rig } from '../shared/testkit';
import type { Account, GameState, Page, Stats, Usage } from '../shared/types';
import { openDb, type Db } from './db';
import { startServer, type NertzServer } from './index';
import { openRounds, USAGE_DAYS, type RoundRecord } from './rounds';
import { ACCOUNTS, ADA, BOB, Browser, Client, fakeGoogle, FakeConn, roomWith, rows, signedAs, startOver, startRound } from './testkit';

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

  it('says how far ahead of another someone finished: the places between them over the table, the same at any size', () => {
    const rounds = openRounds(db);
    rounds.keep(round([hand(0, 'ada', 12), hand(1, 'bob', 5)])); // first to last at two: +1
    rounds.keep(round([hand(0, 'ada', 9), hand(1, 'bob', 8), ...[2, 3, 4, 5, 6, 7, 8, 9].map((s) => hand(s, null, s - 2))], undefined, 2)); // first to second at ten: +1/9
    rounds.keep(round([hand(0, 'ada', 1), hand(1, 'bob', 1), hand(2, null, 9)], undefined, 3)); // level: 0
    expect(rounds.versus('ada', 'bob').edge).toBeCloseTo((1 + 1 / 9 + 0) / 3);
    expect(rounds.versus('bob', 'ada').edge).toBeCloseTo(-(1 + 1 / 9 + 0) / 3);
  });

  it("says how one person has done against another, over the rounds they both played: who finished ahead, and each one's points", () => {
    const rounds = openRounds(db);
    rounds.keep(round([hand(0, 'ada', 12), hand(1, 'bob', 5)])); // ada ahead
    rounds.keep(round([hand(0, 'bob', 20), hand(1, 'ada', -4), hand(2, null, 1)], undefined, 2)); // bob ahead
    rounds.keep(round([hand(0, 'ada', 3), hand(1, 'bob', 3), hand(2, null, 9, 'slow')], undefined, 3)); // level, with a bot
    rounds.keep(round([hand(0, 'ada', 7), hand(1, null, 3)], undefined, 4)); // (without bob)
    expect(rounds.versus('ada', 'bob')).toEqual({ rounds: 3, ahead: 1, behind: 1, edge: 0, points: 11, theirs: 28, snipes: 0, sniped: 0 });
    expect(rounds.versus('bob', 'ada')).toEqual({ rounds: 3, ahead: 1, behind: 1, edge: 0, points: 28, theirs: 11, snipes: 0, sniped: 0 });
    // Of one kind: no bots (the first two); two people and a bot (the third); one person and bots (none of theirs).
    expect(rounds.versus('ada', 'bob', 'humans')).toEqual({ rounds: 2, ahead: 1, behind: 1, edge: 0, points: 8, theirs: 25, snipes: 0, sniped: 0 });
    expect(rounds.versus('ada', 'bob', 'mixed')).toEqual({ rounds: 1, ahead: 0, behind: 0, edge: 0, points: 3, theirs: 3, snipes: 0, sniped: 0 });
    expect(rounds.versus('ada', 'bob', 'bots')).toEqual({ rounds: 0, ahead: 0, behind: 0, edge: 0, points: 0, theirs: 0, snipes: 0, sniped: 0 });
    expect(rounds.versus('ada', 'cy')).toEqual({ rounds: 0, ahead: 0, behind: 0, edge: 0, points: 0, theirs: 0, snipes: 0, sniped: 0 });
    // Gone, an account's rounds are nobody's: nobody has played them against it.
    rounds.forget('bob');
    expect(rounds.versus('ada', 'bob')).toMatchObject({ rounds: 0 });
  });

  it('counts every round, or one kind: no bots; someone else and bots; alone with bots', () => {
    const rounds = openRounds(db);
    rounds.keep(round([hand(0, 'ada', 1), hand(1, null, 2, 'slow')])); // ada and a bot: bots
    rounds.keep(round([hand(0, 'ada', 5), hand(1, null, 2, 'slow'), hand(2, null, 9, 'slow')], undefined, 2)); // ada and two bots: bots
    rounds.keep(round([hand(0, 'ada', 2), hand(1, null, 1), hand(2, null, 9, 'slow')], undefined, 3)); // ada, a guest, a bot: mixed
    rounds.keep(round([hand(0, 'ada', 4), hand(1, 'bob', 3)], undefined, 4)); // ada and bob: humans
    rounds.keep(round([hand(0, 'ada', 3)], undefined, 5)); // ada alone, no bot: humans, but nobody beaten or beating her
    expect(rounds.stats('ada', 'all')).toMatchObject({ rounds: 5, points: 15 });
    expect(rounds.stats('ada', 'bots')).toMatchObject({ rounds: 2, points: 6, won: 0, ahead: 0.25 });
    expect(rounds.stats('ada', 'mixed')).toMatchObject({ rounds: 1, points: 2, won: 0, ahead: 0.5 });
    expect(rounds.stats('ada', 'humans')).toMatchObject({ rounds: 2, points: 7, won: 1, ahead: 1 });
    expect(rounds.stats('bob', 'mixed')).toMatchObject({ rounds: 0 });
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

  it('counts the snipes someone made and suffered (and between two people, who sniped whom), and keeps each hand under its name and each round in its sitting', () => {
    const rounds = openRounds(db);
    rounds.keep(round([hand(0, 'ada', 5), hand(1, 'bob', 3), hand(2, null, 1)], undefined, 1, [{ by: 0, of: 1, card: 'H3' }, { by: 0, of: 2, card: 'S7' }, { by: 1, of: 0, card: 'D2' }]));
    rounds.keep(round([hand(0, 'bob', 5), hand(1, 'ada', 3)], undefined, 2, [{ by: 1, of: 0, card: 'C9' }]));
    expect(rounds.stats('ada')).toMatchObject({ snipes: 3, sniped: 1 });
    expect(rounds.stats('bob')).toMatchObject({ snipes: 1, sniped: 2 });
    // Between two of them: only the snipes one made on the other (not ada's on the guest).
    expect(rounds.versus('ada', 'bob')).toMatchObject({ snipes: 2, sniped: 1 });
    expect(rounds.versus('bob', 'ada')).toMatchObject({ snipes: 1, sniped: 2 });
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

  it('says how much the game is played: all told, day by day where the asker is, and the latest sittings and who was at them', () => {
    const rounds = openRounds(db);
    const now = Date.parse('2026-11-22T15:00:00Z'); // (10am in New York, 300 minutes behind)
    // A sitting this morning: two rounds, Ada throughout, a guest and a bot in the first, Bob come for the second.
    rounds.keep(round([hand(0, 'ada', 4), hand(1, null, 2), hand(2, null, 6, 'slow')]), now - 60 * 60_000);
    rounds.keep(round([hand(0, 'ada', 3), { ...hand(1, 'bob', 5), player: 4 }], undefined, 2), now - 30 * 60_000);
    // Last night in New York (but already the 22nd by UTC): Bob and a guest.
    rounds.keep({ ...round([hand(0, 'bob', 1), hand(1, null, 7)]), game: 'g2', code: 'NITE' }, Date.parse('2026-11-22T03:00:00Z'));
    // A month ago: on the totals, but on none of the days.
    rounds.keep({ ...round([hand(0, 'ada', 9)]), game: 'g3', code: 'OLDE' }, now - 30 * 24 * 60 * 60_000);

    const usage = rounds.usage(300, undefined, now);
    expect(usage.total).toEqual({ games: 3, rounds: 4, players: 2, guests: 2, bots: 1 });
    expect(usage.days).toHaveLength(USAGE_DAYS);
    expect(usage.days[0]!.day).toBe('2026-11-09');
    expect(usage.days.slice(-2)).toEqual([
      { day: '2026-11-21', games: 1, rounds: 1, players: 1, guests: 1, bots: 0 },
      { day: '2026-11-22', games: 1, rounds: 2, players: 2, guests: 1, bots: 1 },
    ]);
    expect(usage.days.slice(0, -2).every((d) => d.games === 0 && d.rounds === 0)).toBe(true);
    // By UTC's days, last night's is this morning's.
    expect(rounds.usage(0, undefined, now).days.at(-1)).toMatchObject({ day: '2026-11-22', games: 2, rounds: 3 });
    expect(usage.games).toEqual([
      { at: now - 30 * 60_000, code: 'TEST', rounds: 2, ms: 120_000, players: [{ name: 'ada', as: 'account' }, { name: 'Guest', as: 'guest' }, { name: 'Bot', as: 'bot' }, { name: 'bob', as: 'account' }] },
      { at: Date.parse('2026-11-22T03:00:00Z'), code: 'NITE', rounds: 1, ms: 60_000, players: [{ name: 'bob', as: 'account' }, { name: 'Guest', as: 'guest' }] },
      { at: now - 30 * 24 * 60 * 60_000, code: 'OLDE', rounds: 1, ms: 60_000, players: [{ name: 'ada', as: 'account' }] },
    ] satisfies Usage['games']);
    // An account gone leaves its hands as a guest's, and no name to list.
    rounds.forget('bob');
    expect(rounds.usage(300, undefined, now).total).toEqual({ games: 3, rounds: 4, players: 1, guests: 4, bots: 1 });
    expect(rounds.usage(300, undefined, now).games[1]!.players).toEqual([{ name: 'Guest', as: 'guest' }]);
  });

  it('one kind of game at a time, by who held hands in each round: no bots; two people or more and bots; one person or none and bots', () => {
    const rounds = openRounds(db);
    const now = Date.parse('2026-11-22T15:00:00Z');
    const at = (code: string, hands: RoundRecord['hands'], minutes: number, number = 1) => rounds.keep({ ...round(hands, undefined, number), game: code, code }, now - minutes * 60_000);
    at('HOME', [hand(0, 'ada', 4), hand(1, 'bob', 2)], 60); // no bots: humans
    at('HOME', [hand(0, 'ada', 4), hand(1, 'bob', 2), hand(2, null, 1, 'slow')], 50, 2); // two people and a bot: mixed (the same sitting)
    at('SOLO', [hand(0, 'ada', 4), hand(1, null, 2, 'slow'), hand(2, null, 1, 'slow')], 40); // one person and bots: bots
    at('GEST', [hand(0, null, 4), hand(1, null, 2, 'slow')], 30); // a guest is a person: bots
    at('BOTS', [hand(0, null, 4, 'slow'), hand(1, null, 2, 'slow')], 20); // nobody: bots
    at('PALS', [hand(0, 'ada', 4), hand(1, null, 2)], 10); // a guest and Ada: humans

    expect(rounds.usage(0, undefined, now).total).toEqual({ games: 5, rounds: 6, players: 2, guests: 2, bots: 6 });
    // Each round counts whole, for its kind: the bots and all.
    const humans = rounds.usage(0, 'humans', now);
    const mixed = rounds.usage(0, 'mixed', now);
    const bots = rounds.usage(0, 'bots', now);
    expect([humans.total, mixed.total, bots.total]).toEqual([
      { games: 2, rounds: 2, players: 2, guests: 1, bots: 0 },
      { games: 1, rounds: 1, players: 2, guests: 0, bots: 1 },
      { games: 3, rounds: 3, players: 1, guests: 1, bots: 5 },
    ]);
    expect(mixed.days.at(-1)).toEqual({ day: '2026-11-22', ...mixed.total });
    // A sitting that changed kind is under each, with its rounds of that kind and whoever played them.
    expect(humans.games.map((g) => [g.code, g.rounds, g.players.map((p) => p.name)])).toEqual([
      ['PALS', 1, ['ada', 'Guest']],
      ['HOME', 1, ['ada', 'bob']],
    ]);
    expect(mixed.games).toEqual([{ at: now - 50 * 60_000, code: 'HOME', rounds: 1, ms: 60_000, players: [{ name: 'ada', as: 'account' }, { name: 'bob', as: 'account' }, { name: 'Bot', as: 'bot' }] }] satisfies Usage['games']);
    expect(bots.games.map((g) => g.code)).toEqual(['BOTS', 'GEST', 'SOLO']);
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
    room.join(a, 'Ada', 'tok-000a', true, signedAs('ada'));
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
    room.join(a, 'Ada', 'tok-000a', true, signedAs('ada'));
    room.join(again, 'Ada', 'tok-001a', true, signedAs('ada'));
    room.join(b, 'Bob', 'tok-000b', true, signedAs('bob'));
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
    room.join(a, 'Ada', 'tok-000a', true, signedAs('ada'));
    room.join(b, 'Bob', 'tok-000b', true, signedAs('bob'));
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
    room.join(a, 'Ada', 'tok-000a', true, signedAs('ada'));
    room.join(b, 'Bob', 'tok-000b', true, signedAs('bob'));
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
    room.join(a, 'Ada', 'tok-000a', true, signedAs('ada', '/pictures/0123456789abcdef.webp'));
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
    expect(await (await ada.ask('/stats?among=humans')).json()).toMatchObject({ rounds: 0 });
    expect((await ada.ask('/stats?among=no-bots')).status).toBe(400); // (as it once was said)
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

  it("someone's page is where their handle says: their record, and the asker's against them; for someone signed in alone", async () => {
    const [ada, bob, guest] = [new Browser(server.port), new Browser(server.port), new Browser(server.port)];
    await ada.signIn(ADA);
    await bob.signIn(BOB);
    const handleOf = async (b: Browser): Promise<string> => ((await (await b.ask('/profile')).json()) as Account).handle;
    const [adas, bobs] = [await handleOf(ada), await handleOf(bob)];

    const a = await Client.open(server.port, null, 'Ada', undefined, true, ada.cookie);
    const b = await Client.open(server.port, a.last.room.code, 'Bob', undefined, true, bob.cookie);
    const g = await Client.open(server.port, a.last.room.code, 'Guest');
    const room = server.rooms.get(a.last.room.code)!;
    await startOver(room, a, [a, b, g]);
    for (const c of [a, b, g]) await c.did({ k: 'end', on: true });
    await vi.waitFor(() => expect(room.phase).toBe('results'));

    // At the table, whoever is signed in is told where the page of everyone else signed in is, and a guest is told nobody's.
    const handles = (c: Client) => c.last.room.players.map((p) => [p.name, p.handle]);
    expect(handles(a)).toEqual([['Ada', undefined], ['Bob', bobs], ['Guest', undefined]]);
    expect(handles(b)).toEqual([['Ada', adas], ['Bob', undefined], ['Guest', undefined]]);
    expect(handles(g)).toEqual([['Ada', undefined], ['Bob', undefined], ['Guest', undefined]]);
    // Who they are signed in as goes to nobody.
    const ids = rows(join(dir, 'nertz.db'), 'user').map((u) => u.id as string);
    for (const c of [a, b, g]) expect(ids.filter((id) => c.raw.some((m) => m.includes(id)))).toEqual([]);

    const line = (c: Client) => room.lastRound!.scores.find((s) => s.id === c.last.room.me)!.delta;
    const page = (await (await ada.ask(`/stats/${bobs}`)).json()) as Page;
    expect(page).toEqual({
      name: 'Bob',
      picture: null, // (none put up: Google's is never shown to anyone else)
      stats: await (await bob.ask('/stats')).json(),
      versus: { rounds: 1, ahead: Number(line(a) > line(b)), behind: Number(line(a) < line(b)), edge: expect.any(Number), points: line(a), theirs: line(b), snipes: 0, sniped: 0 },
    });
    expect(((await (await bob.ask(`/stats/${adas}?among=humans`)).json()) as Page).versus).toMatchObject({ rounds: 1, points: line(b), theirs: line(a), snipes: 0, sniped: 0 });
    // One's own: one's record, and nobody to be against.
    expect(await (await ada.ask(`/stats/${adas}`)).json()).toEqual({ name: 'Ada', picture: null, stats: await (await ada.ask('/stats')).json(), versus: null });

    // Nobody signed in is told nothing, not even whether there is such a page; a page that is nobody's is not there.
    expect((await guest.ask(`/stats/${bobs}`)).status).toBe(401);
    expect((await guest.ask('/stats/0000000000000000')).status).toBe(401);
    expect((await ada.ask('/stats/0000000000000000')).status).toBe(404);
    expect((await ada.ask(`/stats/${bobs.toUpperCase()}`)).status).toBe(200); // (an address in any case)
    expect((await ada.ask('/stats/a--b')).status).toBe(404);
    expect((await ada.ask(`/stats/${bobs}/more`)).status).toBe(404);
    expect((await ada.ask(`/stats/${bobs}?among=robots`)).status).toBe(400);
    expect((await ada.ask(`/stats/${bobs}`, {})).status).toBe(405);
    // An account gone takes its page with it.
    expect((await bob.ask('/profile', undefined, { method: 'DELETE' })).status).toBe(204);
    expect((await ada.ask(`/stats/${bobs}`)).status).toBe(404);
    await vi.waitFor(() => expect(handles(a)).toEqual([['Ada', undefined], ['Bob', undefined], ['Guest', undefined]]));
    // Their socket, still open, is nobody's from then on: joining again on it brings nothing of the account back.
    b.send({ t: 'join', room: a.last.room.code, name: 'Rob', token: b.token });
    await vi.waitFor(() => expect(handles(a)).toEqual([['Ada', undefined], ['Rob', undefined], ['Guest', undefined]]));
    for (const c of [a, b, g]) c.ws.terminate();
  });

  it('a private page is its own alone: to anyone else it is not there, and nobody at a table is told where it is', async () => {
    const [ada, bob] = [new Browser(server.port), new Browser(server.port)];
    await ada.signIn(ADA);
    await bob.signIn(BOB);
    const handleOf = async (b: Browser): Promise<string> => ((await (await b.ask('/profile')).json()) as Account).handle;
    const [adas, bobs] = [await handleOf(ada), await handleOf(bob)];
    const a = await Client.open(server.port, null, 'Ada', undefined, true, ada.cookie);
    const b = await Client.open(server.port, a.last.room.code, 'Bob', undefined, true, bob.cookie);
    const handles = (c: Client) => c.last.room.players.map((p) => [p.name, p.handle]);
    await vi.waitFor(() => expect(handles(a)).toEqual([['Ada', undefined], ['Bob', bobs]]));

    // Made private while sitting at the table: at once, the others there are no longer told where it is.
    expect((await bob.ask('/profile', { private: true }, { method: 'PUT' })).status).toBe(200);
    await vi.waitFor(() => expect(handles(a)).toEqual([['Ada', undefined], ['Bob', undefined]]));
    expect(handles(b)).toEqual([['Ada', adas], ['Bob', undefined]]); // (theirs is still where it was to them)
    // Nor when they join again on the same socket, or sit down at a table anew.
    b.send({ t: 'join', room: a.last.room.code, name: 'Bob', token: b.token });
    const b2 = await Client.open(server.port, null, 'Bob', undefined, true, bob.cookie);
    const a2 = await Client.open(server.port, b2.last.room.code, 'Ada', undefined, true, ada.cookie);
    await vi.waitFor(() => expect(handles(a2)).toEqual([['Bob', undefined], ['Ada', undefined]]));
    expect(a2.raw.some((m) => m.includes(bobs))).toBe(false);
    expect(handles(a)).toEqual([['Ada', undefined], ['Bob', undefined]]);

    // To anyone else, the page is as if it were nobody's; to them, theirs as ever.
    expect((await ada.ask(`/stats/${bobs}`)).status).toBe(404);
    expect((await new Browser(server.port).ask(`/stats/${bobs}`)).status).toBe(401); // (nobody signed in is still told nothing)
    expect(await (await bob.ask(`/stats/${bobs}`)).json()).toMatchObject({ name: 'Bob', versus: null });
    expect((await bob.ask(`/stats/${adas}`)).status).toBe(200); // (and they still see everyone else's)

    // Made anyone's again: the page is there, and the table says where it is.
    expect((await bob.ask('/profile', { private: false }, { method: 'PUT' })).status).toBe(200);
    expect((await ada.ask(`/stats/${bobs}`)).status).toBe(200);
    await vi.waitFor(() => expect(handles(a2)).toEqual([['Bob', bobs], ['Ada', undefined]]));
    for (const c of [a, b, a2, b2]) c.ws.terminate();
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
    a.send({ t: 'join', room: a.last.room.code, name: 'Ada', token: a.token }); // (their socket, opened signed in, joining again: still nobody)
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

  it('how much the game is played is for an admin alone: anyone else signed in is told there is no such thing', async () => {
    const admins = await startServer({ port: 0, dist: '/nonexistent', data: join(dir, 'admins.db'), accounts: { ...ACCOUNTS, admins: [ADA.email] } });
    try {
      const [ada, bob, guest] = [new Browser(admins.port), new Browser(admins.port), new Browser(admins.port)];
      await ada.signIn(ADA);
      await bob.signIn(BOB);
      expect(await (await ada.ask('/profile')).json()).toMatchObject({ admin: true });
      expect(await (await bob.ask('/profile')).json()).not.toHaveProperty('admin');
      const usage = (await (await ada.ask('/usage?tz=300')).json()) as Usage;
      expect(usage.total).toEqual({ games: 0, rounds: 0, players: 0, guests: 0, bots: 0 });
      expect([usage.days.length, usage.games]).toEqual([USAGE_DAYS, []]);
      expect((await ada.ask('/usage')).status).toBe(200);
      expect((await ada.ask('/usage?tz=300&among=mixed')).status).toBe(200);
      expect((await ada.ask('/usage?among=people')).status).toBe(400);
      expect((await ada.ask('/usage?tz=later')).status).toBe(400);
      expect((await bob.ask('/usage')).status).toBe(404);
      expect((await guest.ask('/usage')).status).toBe(401);
      // Nobody is an admin unless the server is told who.
      const there = new Browser(server.port);
      await there.signIn(ADA);
      expect((await there.ask('/usage')).status).toBe(404);
    } finally {
      await admins.close();
    }
  });

  it('with nothing kept, or nobody able to sign in, there are no records to ask for', async () => {
    const bare = await startServer({ port: 0, dist: '/nonexistent' });
    const kept = await startServer({ port: 0, dist: '/nonexistent', data: ':memory:' });
    try {
      expect([bare.kept, kept.kept, kept.accounts]).toEqual([false, true, false]);
      expect((await fetch(`http://localhost:${bare.port}/stats`)).status).toBe(404);
      expect((await fetch(`http://localhost:${kept.port}/stats`)).status).toBe(404);
      expect((await fetch(`http://localhost:${kept.port}/usage`)).status).toBe(404);
    } finally {
      await bare.close();
      await kept.close();
    }
  });
});
