// The rounds played to the end, kept (server/db.ts): what a room hands over when a round is scored, and what is
// asked of them after: one person's record. A hand someone played signed in is theirs; every hand, theirs or not, is
// kept with the name it was played under.
import type { BotLevel, RoundEnd, RoundScore, Stats } from '../shared/types';
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
  /** The record of whoever `account` is: all noughts for someone who has played nothing. */
  stats(account: string): Stats;
}

export function openRounds(db: Db): Rounds {
  const round = db.prepare('insert into round (created_at, game, code, number, ending, ms) values (?, ?, ?, ?, ?, ?)');
  const hand = db.prepare('insert into hand (round, seat, player, name, account, bot, out, played, nertz_left, delta, nertz) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const snipe = db.prepare('insert into snipe (round, by_seat, of_seat, card) values (?, ?, ?, ?)');
  // A round is won by the best score in it, by everyone who has it; a round of one hand is nobody's to win.
  const stats = db.prepare(
    `select count(*) as rounds,
            coalesce(sum(nertz), 0) as nertz,
            coalesce(sum(delta), 0) as points,
            max(delta) as best,
            coalesce(sum((select count(*) from snipe s where s.round = hand.round and s.by_seat = hand.seat)), 0) as snipes,
            coalesce(sum((select count(*) from snipe s where s.round = hand.round and s.of_seat = hand.seat)), 0) as sniped,
            coalesce(sum(delta = (select max(o.delta) from hand o where o.round = hand.round)
                         and (select count(*) from hand o where o.round = hand.round) > 1), 0) as won
       from hand where account = ?`,
  );
  return {
    keep(r, at = Date.now()) {
      transaction(db, () => {
        const id = round.run(at, r.game, r.code, r.number, r.end.by, Math.round(r.ms)).lastInsertRowid;
        for (const h of r.hands) hand.run(id, h.seat, h.player, h.name, h.account, h.bot, h.out, h.played, h.nertzLeft, h.delta, r.end.by === 'nertz' && r.end.out.includes(h.seat) ? 1 : 0);
        for (const s of r.snipes) snipe.run(id, s.by, s.of, s.card);
      });
    },
    stats: (account) => {
      const s = stats.get(account) as unknown as Stats;
      return { rounds: s.rounds, won: s.won, nertz: s.nertz, points: s.points, best: s.best, snipes: s.snipes, sniped: s.sniped };
    },
  };
}
