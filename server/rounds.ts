// The rounds played to the end, kept (server/db.ts): what a room hands over when a round is scored, and what is
// asked of them after: one person's record. A hand someone played signed in is theirs; every hand, theirs or not, is
// kept with the name it was played under.
import type { Among, BotLevel, RoundEnd, RoundScore, Stats } from '../shared/types';
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

export interface Rounds {
  keep(round: RoundRecord, at?: number): void;
  /** The record of whoever `account` is, over the rounds `among` says: all noughts for someone who has played none. */
  stats(account: string, among?: Among): Stats;
  /** Leaves `account`'s hands as they were played, but nobody's and with no name: the rounds stay whole for everyone else who played them. */
  forget(account: string): void;
}

export function openRounds(db: Db): Rounds {
  const round = db.prepare('insert into round (created_at, game, code, number, ending, ms) values (?, ?, ?, ?, ?, ?)');
  const hand = db.prepare('insert into hand (round, seat, player, name, account, bot, out, played, nertz_left, delta, nertz) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const snipe = db.prepare('insert into snipe (round, by_seat, of_seat, card) values (?, ?, ?, ?)');
  // A round is won by the best score in it, by everyone who has it; a round of one hand is nobody's to win, and has no
  // place in it. A place is one more than the hands that scored more: those who tie share it.
  const stats = db.prepare(
    `with mine as (
       select h.round, h.seat, h.delta, h.nertz,
              (select count(*) from hand o where o.round = h.round) as hands,
              (select count(*) from hand o where o.round = h.round and o.seat <> h.seat and o.bot is null) as people,
              (select count(*) from hand o where o.round = h.round and o.bot is not null) as bots,
              1 + (select count(*) from hand o where o.round = h.round and o.delta > h.delta) as place
         from hand h where h.account = $account)
     select count(*) as rounds,
            coalesce(sum(nertz), 0) as nertz,
            coalesce(sum(delta), 0) as points,
            max(delta) as best,
            avg(case when hands > 1 then place end) as place,
            coalesce(sum((select count(*) from snipe s where s.round = mine.round and s.by_seat = mine.seat)), 0) as snipes,
            coalesce(sum((select count(*) from snipe s where s.round = mine.round and s.of_seat = mine.seat)), 0) as sniped,
            coalesce(sum(place = 1 and hands > 1), 0) as won
       from mine
      where $among = 'all' or ($among = 'people' and people > 0) or ($among = 'no-bots' and bots = 0)`,
  );
  const forget = db.prepare("update hand set account = null, name = '' where account = ?");
  return {
    keep(r, at = Date.now()) {
      transaction(db, () => {
        const id = round.run(at, r.game, r.code, r.number, r.end.by, Math.round(r.ms)).lastInsertRowid;
        for (const h of r.hands) hand.run(id, h.seat, h.player, h.name, h.account, h.bot, h.out, h.played, h.nertzLeft, h.delta, r.end.by === 'nertz' && r.end.out.includes(h.seat) ? 1 : 0);
        for (const s of r.snipes) snipe.run(id, s.by, s.of, s.card);
      });
    },
    stats: (account, among = 'all') => {
      const s = stats.get({ $account: account, $among: among }) as unknown as Stats;
      return { rounds: s.rounds, won: s.won, nertz: s.nertz, points: s.points, place: s.place, best: s.best, snipes: s.snipes, sniped: s.sniped };
    },
    forget: (account) => void forget.run(account),
  };
}
