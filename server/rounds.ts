// The rounds played to the end, kept (server/db.ts): what a room hands over when a round is scored, and what is
// asked of them after: one person's record, how they have done against someone else, and how much the game is played. A hand someone played signed
// in is theirs; every hand, theirs or not, is kept with the name it was played under.
import type { Among, BotLevel, Played, RoundEnd, RoundScore, Stats, Usage, Versus } from '../shared/types';
import { transaction, type Db } from './db';

/** A round as it ended, as a room tells it (server/room.ts, `settle`). */
export interface RoundRecord {
  /** The sitting it was played in (server/room.ts): the same for every round from a table's opening or start-over on. */
  game: string;
  /** The table's code, and which of its rounds this was (from 1). */
  code: string;
  number: number;
  end: RoundEnd;
  /** How long it was played, ms: from the word NERTZ! to its end, not counting time paused. */
  ms: number;
  /** Each hand's score, with who played it if they were signed in (`account`), and for a bot's hand how quick it was. */
  hands: (RoundScore & { player: number; name: string; account: string | null; bot: BotLevel | null; out: 'stood' | 'left' | 'kicked' | null })[];
  /** Each snipe in it: the seat that sniped, the seat sniped, and the card. */
  snipes: { by: number; of: number; card: string }[];
}

/** How many days back `usage` counts day by day (today one of them), and how many of the latest sittings it lists. */
export const USAGE_DAYS = 14;
export const USAGE_GAMES = 12;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface Rounds {
  /** Keeps `round`, played at `at`; one played offline with the id its browser gave it (`offline`), unless one of that id is kept already. */
  keep(round: RoundRecord, at?: number, offline?: string): void;
  /** The record of whoever `account` is, over the rounds `among` says: all noughts for someone who has played none. */
  stats(account: string, among?: Among): Stats;
  /** How `account` has done against `other`, over the rounds both played (of those `among` says), snipes between the two of them too: all noughts for none. */
  versus(account: string, other: string, among?: Among): Versus;
  /**
   * How much the game is played: all told, each of the last USAGE_DAYS days to `now`, and the latest USAGE_GAMES
   * sittings. A day is a date where the asker is, `offset` minutes behind UTC (as a browser's `getTimezoneOffset`).
   * Only the rounds `among` says count, whole, everywhere: a sitting is there if any of its rounds is, with those rounds
   * and whoever played in them.
   */
  usage(offset?: number, among?: Among, now?: number): Usage;
  /** Leaves `account`'s hands as they were played, but nobody's and with no name: the rounds stay whole for everyone else who played them. */
  forget(account: string): void;
}

/**
 * Whether the round `id` (an SQL expression) is among those `$among` says: every one, or those of one kind
 * (`GameKind`), by its hands. No bot: humans; two people or more and a bot: mixed; one person or none: bots. (A round
 * of one hand, a person's, has no bot: humans. A record counts it, but no one is beaten in it: see `stats`.)
 */
const counted = (id: string): string =>
  `($among = 'all' or $among = (select case when sum(k.bot is not null) = 0 then 'humans' when sum(k.bot is null) >= 2 then 'mixed' else 'bots' end
                                  from hand k where k.round = ${id}))`;

export function openRounds(db: Db): Rounds {
  const round = db.prepare('insert into round (created_at, game, code, number, ending, ms, offline) values (?, ?, ?, ?, ?, ?, ?) on conflict (offline) do nothing');
  const hand = db.prepare('insert into hand (round, seat, player, name, account, bot, out, played, nertz_left, delta, nertz) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const snipe = db.prepare('insert into snipe (round, by_seat, of_seat, card) values (?, ?, ?, ?)');
  // A round is won by the best score in it, by everyone who has it; a round of one hand is nobody's to win, and has no
  // one else to be ahead of. How far ahead someone finished is the share of the others in the round who scored less
  // than they did, a tie counting half: 1 for first, 0 for last, ½ for the middle of the table, whatever its size.
  const stats = db.prepare(
    `with mine as (
       select h.round, h.seat, h.delta, h.played, h.nertz_left, h.nertz,
              (select count(*) from hand o where o.round = h.round) as hands,
              (select count(*) from hand o where o.round = h.round and o.delta > h.delta) as above,
              (select count(*) from hand o where o.round = h.round and o.seat <> h.seat and o.delta = h.delta) as level
         from hand h where h.account = $account)
     select count(*) as rounds,
            coalesce(sum(above = 0 and hands > 1), 0) as won,
            coalesce(sum(nertz), 0) as nertz,
            coalesce(sum(delta), 0) as points,
            max(delta) as bestPoints,
            coalesce(sum(played), 0) as cards,
            max(played) as bestCards,
            coalesce(sum(nertz_left), 0) as nertzLeft,
            avg(case when hands > 1 then (hands - 1 - above - level + level / 2.0) / (hands - 1) end) as ahead,
            coalesce(sum((select count(*) from snipe s where s.round = mine.round and s.by_seat = mine.seat)), 0) as snipes,
            coalesce(sum((select count(*) from snipe s where s.round = mine.round and s.of_seat = mine.seat)), 0) as sniped
       from mine
      where ${counted('mine.round')}`,
  );
  // Edge: how far ahead of the other someone finished, round by round, as the difference of how far ahead each did (as
  // above): the places between them over the size of the table, a tie counting half. 1 for first to their last at any
  // table, 1/9 for first to their second at ten; averaged over the rounds both played.
  const versus = db.prepare(
    `with place as (
       select h.round, h.seat, h.account, h.delta,
              (select count(*) from hand o where o.round = h.round) as hands,
              (select count(*) from hand o where o.round = h.round and o.delta > h.delta) as above,
              (select count(*) from hand o where o.round = h.round and o.seat <> h.seat and o.delta = h.delta) as level
         from hand h where h.account in ($account, $other))
     select count(*) as rounds,
            coalesce(sum(m.delta > o.delta), 0) as ahead,
            coalesce(sum(m.delta < o.delta), 0) as behind,
            coalesce(avg((o.above + o.level / 2.0 - m.above - m.level / 2.0) / (m.hands - 1)), 0) as edge,
            coalesce(sum(m.delta), 0) as points,
            coalesce(sum(o.delta), 0) as theirs,
            coalesce(sum((select count(*) from snipe s where s.round = m.round and s.by_seat = m.seat and s.of_seat = o.seat)), 0) as snipes,
            coalesce(sum((select count(*) from snipe s where s.round = m.round and s.by_seat = o.seat and s.of_seat = m.seat)), 0) as sniped
       from place m join place o on o.round = m.round
      where m.account = $account and o.account = $other
        and ${counted('m.round')}`,
  );
  // A hand nobody's and no bot's is a guest's (or that of an account since gone: it is nobody's now).
  const played = `count(distinct r.game) as games, count(distinct r.id) as rounds, count(distinct h.account) as players,
                  coalesce(sum(h.account is null and h.bot is null), 0) as guests, coalesce(sum(h.bot is not null), 0) as bots
             from round r left join hand h on h.round = r.id
            where ${counted('r.id')}`;
  const total = db.prepare(`select ${played}`);
  const daily = db.prepare(`select date(r.created_at / 1000 - $offset * 60, 'unixepoch') as day, ${played} and r.created_at >= $since group by day`);
  // (Each sitting's code and time are its last round's.)
  const latest = db.prepare(`select game, code, max(created_at) as at, count(*) as rounds, sum(ms) as ms from round r where ${counted('r.id')} group by game order by at desc limit $n`);
  // Who played in a sitting, in the order they came to it, each under the name of their last hand in it. (An account
  // gone leaves its hands with no name: it is not listed.)
  const players = db.prepare(
    `select h.name, h.account is not null as signed, h.bot is not null as bot, max(r.number)
       from hand h join round r on r.id = h.round
      where r.game = $game and h.name <> '' and ${counted('r.id')}
      group by h.player order by h.player`,
  );
  const count = (p: Played): Played => ({ games: p.games, rounds: p.rounds, players: p.players, guests: p.guests, bots: p.bots });
  const forget = db.prepare("update hand set account = null, name = '' where account = ?");
  return {
    keep(r, at = Date.now(), offline) {
      transaction(db, () => {
        const made = round.run(at, r.game, r.code, r.number, r.end.by, Math.round(r.ms), offline ?? null);
        if (!made.changes) return;
        const id = made.lastInsertRowid;
        for (const h of r.hands) hand.run(id, h.seat, h.player, h.name, h.account, h.bot, h.out, h.played, h.nertzLeft, h.delta, r.end.by === 'nertz' && r.end.out.includes(h.seat) ? 1 : 0);
        for (const s of r.snipes) snipe.run(id, s.by, s.of, s.card);
      });
    },
    stats: (account, among = 'all') => {
      const s = stats.get({ $account: account, $among: among }) as unknown as Stats;
      return { rounds: s.rounds, won: s.won, nertz: s.nertz, points: s.points, bestPoints: s.bestPoints, cards: s.cards, bestCards: s.bestCards, nertzLeft: s.nertzLeft, ahead: s.ahead, snipes: s.snipes, sniped: s.sniped };
    },
    versus: (account, other, among = 'all') => {
      const v = versus.get({ $account: account, $other: other, $among: among }) as unknown as Versus;
      return { rounds: v.rounds, ahead: v.ahead, behind: v.behind, edge: v.edge, points: v.points, theirs: v.theirs, snipes: v.snipes, sniped: v.sniped };
    },
    usage: (offset = 0, among = 'all', now = Date.now()) => {
      const date = (t: number): string => new Date(t).toISOString().slice(0, 10);
      /** Midnight today where the asker is, as if it were UTC's. */
      const today = Date.parse(date(now - offset * 60_000));
      const dates = Array.from({ length: USAGE_DAYS }, (_, i) => date(today - (USAGE_DAYS - 1 - i) * DAY_MS));
      const had = new Map((daily.all({ $offset: offset, $since: Date.parse(dates[0]!) + offset * 60_000, $among: among }) as unknown as (Played & { day: string })[]).map((d) => [d.day, d]));
      const none: Played = { games: 0, rounds: 0, players: 0, guests: 0, bots: 0 };
      const games = (latest.all({ $n: USAGE_GAMES, $among: among }) as { game: string; code: string; at: number; rounds: number; ms: number }[]).map((g) => ({
        at: g.at,
        code: g.code,
        rounds: g.rounds,
        ms: g.ms,
        players: (players.all({ $game: g.game, $among: among }) as { name: string; signed: number; bot: number }[]).map((p) => ({ name: p.name, as: p.bot ? ('bot' as const) : p.signed ? ('account' as const) : ('guest' as const) })),
      }));
      return { total: count(total.get({ $among: among }) as unknown as Played), days: dates.map((day) => ({ day, ...count(had.get(day) ?? none) })), games };
    },
    forget: (account) => void forget.run(account),
  };
}
