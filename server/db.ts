// What outlives the process: one SQLite file (on a volume, in production), opened with Node's own `node:sqlite`.
// Each part of the server that keeps something has its tables here, in `MIGRATIONS`; Better Auth's own (user,
// session, account, verification) it makes and looks after itself (server/accounts.ts), in the same file.
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type Db = DatabaseSync;

/**
 * Each entry is run once, in order, on a database that has not had it: the file's `user_version` is how many it has
 * had. Never change an entry that has shipped: add one.
 */
const MIGRATIONS: string[] = [
  // Rounds played to the end, each hand in them, and each snipe (server/rounds.ts). `game` is one sitting at a table:
  // the rounds from its opening (or its last start-over) on, whose totals add up on the score sheet; codes are reused,
  // so it is what tells two sittings at one code apart. `player` is who played a hand within its sitting (the room's
  // id for them: a seat, a name, can change hands between rounds), and `out` whether they had stood up, left the table, or been
  // sent away, before the round was over.
  // A hand is one person's play of one round, and within a round a seat is one hand: the engine's own identity for it,
  // held by one player from the deal to the score. So a snipe names its two hands by seat, and the database holds it to
  // two hands of that round. `name` is the name the hand was played under, guest or not.
  // `account` is who played it, if they were signed in: the id of a row of Better Auth's `user`. (Not declared as one:
  // that table is there only where there are accounts, and rounds are kept without.)
  `create table round (
     id integer primary key,
     created_at integer not null,
     game text not null,
     code text not null,
     number integer not null,
     ending text not null check (ending in ('nertz', 'jam', 'vote')),
     ms integer not null
   ) strict;
   create index round_game on round (game);
   create table hand (
     round integer not null references round (id) on delete cascade,
     seat integer not null,
     player integer not null,
     name text not null,
     account text,
     bot text check (bot in ('slow', 'medium', 'fast')),
     out text check (out in ('stood', 'left', 'kicked')),
     played integer not null,
     nertz_left integer not null,
     delta integer not null,
     nertz integer not null check (nertz in (0, 1)),
     primary key (round, seat),
     unique (round, player),
     check (bot is null or account is null)
   ) strict, without rowid;
   create table snipe (
     round integer not null,
     by_seat integer not null,
     of_seat integer not null,
     card text not null,
     check (by_seat <> of_seat),
     primary key (round, of_seat, card),
     foreign key (round, by_seat) references hand (round, seat) on delete cascade,
     foreign key (round, of_seat) references hand (round, seat) on delete cascade
   ) strict, without rowid;
   create unique index hand_account on hand (account, round) where account is not null;`,
  // What players send with the bug button (server/reports.ts): the report as it came, who sent it if they were
  // signed in, and once it has been passed on, what it was titled, how much it was judged to matter (if it was
  // judged: Linear's 2 high to 4 low) and the address of the issue filed for it. The screenshot is a file beside the
  // database (reports/<id>.jpg, server/reports.ts); the row says only how big it is, null for none.
  `create table report (
     id text primary key,
     created_at integer not null,
     kind text not null check (kind in ('bug', 'idea')),
     text text not null,
     name text,
     room text,
     context text,
     account text,
     image_bytes integer,
     title text,
     priority integer check (priority between 0 and 4),
     issue text
   ) strict;`,
  // Who someone is at the table, theirs to change (server/profile.ts): for now the name they go by, null for none
  // chosen yet. `account` is a row of Better Auth's `user`, as for `hand` (and not declared as one, for the same reason).
  // A profile is made with its account (server/accounts.ts), and goes with it.
  `create table profile (
     account text primary key,
     name text
   ) strict, without rowid;`,
  // The picture they put up of themselves, null for none: its id, the name of a file in the pictures directory beside the
  // database (server/pictures.ts). Without one they are shown by Google's, or by their initial.
  `alter table profile add column picture text;`,
  // The Discord message a report was posted as (server/feedback.ts): its id, null where it was not posted (or was
  // before this). BinaryBot opens a thread on it once a PR for the report is ready (the auto-fanout, kept outside this repo).
  `alter table report add column post text;`,
  // Where someone's page is (/u/<handle>, server/stats.ts): made with the profile from the name it goes by (server/accounts.ts),
  // `ada`, `ada-2` on a clash, or six letters and digits drawn at random for a profile with no name; theirs to change for one of their own, nobody else's. It
  // is what the others at a table are shown, as the account's id never is; and it goes with the profile.
  // Profiles already there are given theirs when the server starts, by server/accounts.ts, made the way a new one's
  // is: SQL could not try the next on a clash, and a clash here would stop the server starting. (Until then they have
  // none: a unique index lets any number of rows have none.)
  `alter table profile add column handle text;
   create unique index profile_handle on profile (handle);`,
  // Whether their page is theirs alone (server/stats.ts): to anyone else it is not there, and nobody at a table is told
  // where it is (server/room.ts). Off unless they say.
  `alter table profile add column private integer not null default 0 check (private in (0, 1));`,
  // Whether they chose their handle themselves (PUT /profile). Until they do it is the one made for them, from their
  // name, and a profile made with no name has its handle follow the first name it is given (server/accounts.ts).
  `alter table profile add column handle_chosen integer not null default 0 check (handle_chosen in (0, 1));`,
  // Who someone follows (server/profile.ts): one way, theirs alone to follow and unfollow, and nothing the one followed
  // is asked or told. Both are rows of Better Auth's `user`, as for `hand`, and go with either account
  // (server/accounts.ts). (Not declared as rows of `profile`: an account deleted by hand, with foreign keys off, would
  // leave rows that a later migration's check refuses.)
  `create table follow (
     account text not null,
     followed text not null,
     primary key (account, followed),
     check (account <> followed)
   ) strict, without rowid;`,
  // The open tables, to come back after the server is started anew (server/index.ts): each as its room says it is
  // (server/room.ts, `Kept`), as JSON, under its code. There while a round of it is on, and from the server's going down.
  `create table room (
     code text primary key,
     kept text not null
   ) strict, without rowid;`,
];

/** The file the environment asks for: `nertz.db` in DATA_DIR, which outside production is ./data unless said; null for none. */
export function dataFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  const dir = env.DATA_DIR || (env.NODE_ENV !== 'production' ? 'data' : null);
  return dir ? join(dir, 'nertz.db') : null;
}

/**
 * Runs `does` in a transaction of its own: committed if it returns, undone if it throws. Only what it began is undone
 * (Better Auth runs transactions of its own on this connection), and a failure to begin is a throw like any other.
 */
export function transaction<T>(db: Db, does: () => T): T {
  db.exec('BEGIN');
  try {
    const done = does();
    db.exec('COMMIT');
    return done;
  } catch (err) {
    if (db.isTransaction) db.exec('ROLLBACK'); // (SQLite may have undone it already: then this would hide why)
    throw err;
  }
}

/** Opens the file (or ':memory:'), making its directory if need be, and brings its tables up to date. */
export function openDb(file: string): Db {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  try {
    // (A short wait for the file: the game's own loop writes to it, and a round not kept is better than every table held up.)
    db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 250;');
    const had = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    if (had > MIGRATIONS.length) console.warn(`the database is from a newer version of the game (${had} migrations, this one knows ${MIGRATIONS.length})`);
    // Migrations run with foreign keys off (they cannot be turned off inside a transaction): a table rebuilt by one,
    // dropped and made again, must not take every row that points at it with it. What they leave is checked instead.
    db.exec('PRAGMA foreign_keys = OFF');
    for (let i = had; i < MIGRATIONS.length; i++) {
      transaction(db, () => {
        db.exec(MIGRATIONS[i]!);
        const broken = db.prepare('PRAGMA foreign_key_check').all();
        if (broken.length) throw new Error(`migration ${i + 1} leaves rows pointing at nothing: ${JSON.stringify(broken.slice(0, 5))}`);
        db.exec(`PRAGMA user_version = ${i + 1}`);
      });
    }
    db.exec('PRAGMA foreign_keys = ON');
    return db;
  } catch (err) {
    db.close();
    throw err;
  }
}
