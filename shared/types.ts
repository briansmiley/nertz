// Data shapes shared by server and client. Types only: no runtime code here.
//
// Pile convention, everywhere: the TOP of a pile is the LAST array element.

import type { Look } from './protocol';
import type { TableSettings } from './settings';
import type { Spot } from './table';

export type Suit ='S' | 'H' | 'D' | 'C';

/** A card whose face is known. `rank` is 1 (Ace) .. 13 (King). `owner` is the seat whose deck it came from. */
export interface Card {
  id: string;
  owner: number;
  suit: Suit;
  rank: number;
}

/** A face-down card as seen through `viewFor`. Same id as the real card, so it can animate when revealed. */
export interface HiddenCard {
  id: string;
  owner: number;
  hidden: true;
}

export type AnyCard = Card | HiddenCard;

export interface PlayerState {
  seat: number;
  /** Up to 13 cards; only the top (last) one is face-up. */
  nertz: AnyCard[];
  /** Always exactly 4 piles. */
  work: WorkPile[];
  /** Face-down. */
  stock: AnyCard[];
  /** Face-up; only the top is playable. While a group is in flight onto it (`draw`) that is still the card the group is covering, and taking it calls the draw off. */
  waste: AnyCard[];
  /**
   * The group in flight, or null: no draw under way. A `draw` puts its `n` cards on top of the waste in one step and
   * says when it was made (`at`, on the round's clock: `RoomView.clock`). They count as dealt one at a time,
   * STOCK_CARD_MS apart, and turned up together one step after the last: so the draw is over, and its top card can be
   * played, once that clock reads `at + n * STOCK_CARD_MS` (the engine's `landed`). Until then the card under the group
   * can be taken (`hold`, `move`), which calls the draw off: the group goes back on the stock as it came off, and
   * there is no draw under way. Each window deals the cards out
   * on its own clock. `off` is only ever on screen: how many of the group this window has dealt off the stock so
   * far (client/net.ts `dealtBy`), the rest lying on the stock yet; without it, all `n` are off. `down`, on screen
   * only too: the group is down here and gliding onto the waste, its top already playable, while the card it is
   * covering, still partly in sight, can yet be taken.
   */
  draw: { n: number; at: number; off?: number; down?: true } | null;
  /**
   * The latest draw once its group is down (`landed`): when it was made, how many cards, and the top one. Till it is
   * called off or another draw is made. A take its window made with the group still in flight (`callsOff`) can call
   * it off yet, for a moment, if the group lies untouched on the waste (the engine's `callable`).
   */
  drew?: { n: number; at: number; top: string };
  stuck: boolean;
  /** Has voted to end the round where it stands (see `RoundEnd`). */
  ending?: boolean;
  /**
   * Id of the card this player is dragging right now (the bottom card of the
   * lifted run), or null. Always a card they could pick up. Visible to everyone.
   */
  holding: string | null;
}

/**
 * One of a player's work piles: its cards, and how many of them, from the bottom,
 * are still face-down. Everything above those is a face-up descending
 * alternating-colour run. A non-empty pile always has a face-up top: when the
 * face-up cards leave, the next card turns over (`down` drops by one).
 */
export interface WorkPile {
  cards: AnyCard[];
  down: number;
}

/**
 * A pile in the middle: its cards, Ace up to King in one suit (never none: the
 * Ace starts it), and where it lies. A pile of 13 is complete: it takes nothing
 * more and stays until the player who placed its King (that King's `owner`)
 * clears it.
 */
export interface CentrePile {
  cards: [Card, ...Card[]];
  /**
   * In table space (the same for every player, and drawn at the same place of
   * the felt on every screen): the very point its Ace was put down.
   */
  at: Spot;
}

/** One round. The server holds it with every card known; clients get it via `viewFor`. */
export interface GameState {
  players: PlayerState[];
  /** Where the round is: the one field that says so. */
  status: RoundStatus;
  /**
   * The shared middle: 4 x players slots, each holding one centre pile or
   * nothing (null). A pile takes the first empty slot when its Ace is put
   * down and keeps it until it is cleared: the slot's index is how everyone
   * names the pile meanwhile.
   */
  slots: (CentrePile | null)[];
  /** Completed piles cleared off the table, oldest first. Each has 13 cards, King on top. Still scores. */
  tray: Card[][];
  /** How many times in this round the whole table has said it was stuck and had its stocks turned over (`resolveStuck`). */
  reshuffles: number;
}

/**
 * How far a round has got. Only `play` takes every intent; `grace` takes one move of a card already in hand.
 * - `dealing`: the cards are being dealt out; no face is shown to anyone. Until the server's deal timer (`finishDeal`).
 * - `ready`: the work piles' tops are face-up, every nertz top is still face-down. Waits, without limit, for the dealer (`startCountdown`).
 * - `countdown`: "1, 2, 3": as `ready`, until the server's start timer (`openPlay`).
 * - `play`: the nertz tops are turned over and the round is on.
 * - `grace`: `calledBy` called "Nertz!". Everyone is frozen but those who were holding a playable card at the call:
 *   each may still make exactly one move with it. Who they are is not kept here: exactly the seats holding a card (`inGrace`).
 *   The call reaches each window a moment after it is made: `unheard` are the seats whose windows have not said yet that
 *   they have it (`heard`). Until then a seat may still take a card up, as it could just before, and that card earns
 *   it grace too: it was in hand at the call, as that player saw it. Its one play with it hears the call as well.
 * - `over`: nothing can change any more; `end` says how it came to that.
 */
export type RoundStatus = { at: 'dealing' | 'ready' | 'countdown' | 'play' } | { at: 'grace'; calledBy: number; unheard: number[] } | { at: 'over'; end: RoundEnd };

/**
 * How a round ended: `seat` called Nertz, and `out` got it: every seat whose nertz pile was empty when the round ended
 * (in seat order, the caller among them; another may have emptied theirs without calling, or with the last move of
 * grace). Or without a call, scored as it stands: a 'jam' when everyone said they were stuck and no hand could ever
 * get a card to the middle or off its nertz pile (`canProgress`); a 'vote' when every connected person voted to end it.
 */
export type RoundEnd = { by: 'nertz'; seat: number; out: number[] } | { by: 'jam' } | { by: 'vote' };

/**
 * Where a card can be dropped: one of your own work piles, one specific centre
 * slot, or (an Ace) a point of the bare felt, in table space, where a new
 * pile is to start.
 */
export type PileRef = { k: 'work'; i: number } | { k: 'slot'; i: number } | { k: 'felt'; x: number; y: number };

export type Intent =
  /**
   * Put `cardId` on exactly `to`. `count` is how many cards the sender lifted:
   * the card itself plus the run on top of it, as they saw it. If that is not
   * what lies there now (a card they thought had left came back), the move is
   * refused rather than carrying cards that were never picked up.
   */
  | { k: 'move'; cardId: string; count: number; to: PileRef; callsOff?: number }
  /**
   * A group of three off the stock, all at once (`PlayerState.draw`). Refused
   * while a group is in flight.
   * On an empty stock: turn the waste back over into the stock.
   */
  | { k: 'draw' }
  | { k: 'stuck'; on: boolean }
  /** Vote (or stop voting) to end the round where it stands. */
  | { k: 'end'; on: boolean }
  /**
   * Call Nertz. `unheard`: the others whose windows the call has yet to reach, whom the round waits for a moment (see
   * `RoundStatus`). Only the server can say who they are, and it always does; none, and everyone hears it at once.
   */
  | { k: 'nertz'; unheard?: number[] }
  /** Nertz has been called, and this window has it. */
  | { k: 'heard' }
  /** Move the completed pile in `slot` to the tray. Only for the player who placed its King, and the only thing they may do until it is done. */
  | { k: 'clear'; slot: number }
  /**
   * A drag started on `cardId`. On it and on a `move`, `callsOff`: the card is the one under the sender's own group,
   * in flight on its screen, and this is that draw's `at`. Taking it calls the draw off, even if the group is down by
   * the server's clock by the time it gets there (the engine's `callable`).
   */
  | { k: 'hold'; cardId: string; callsOff?: number }
  /** The drag ended without a move. (A move ends the hold by itself, whether it is accepted or refused.) */
  | { k: 'release' };

export interface RoundScore {
  seat: number;
  /** Own cards played to the middle: centre slots plus tray (+1 each). */
  played: number;
  /** Cards left in own nertz pile (-2 each). */
  nertzLeft: number;
  /** played - 2 * nertzLeft. Nothing else: no bonus for going out. */
  delta: number;
}

/** One line of the score sheet. Carries the name and total so the sheet stays right if that player leaves the table: and their cards' faces and backs, so the cards they left on it stay as they were. */
export interface RoundLine extends RoundScore {
  /** Whose line it is (`PlayerView.id`): the person, wherever they sit now, or if they are gone. `seat` is where they sat that round, and so whose cards on its table were theirs. */
  id: number;
  name: string;
  /** Running total including this round. */
  total: number;
  /** How many rounds that is the total of, this one included. */
  rounds: number;
  /** How many of those rounds they got Nertz in (`RoundEnd.out`), this one included if they did. */
  calls: number;
  /** A bot, or a person, that whoever deals has sent away since: their line is no longer shown on the score sheet. */
  gone?: boolean;
  /** Their faces and backs when the round ended. */
  look?: Look;
}

export interface RoundResult {
  /** How the round ended: what its `status` came to. */
  end: RoundEnd;
  scores: RoundLine[];
  /** Who beat whom to a pile in the middle with the very card the other was about to put there, and how often (`n`): most first. Absent if nobody did. */
  snipes?: { by: number; of: number; n: number }[];
}

export type Phase = 'lobby' | 'playing' | 'results';

/** How quick and how observant a bot is (the numbers are in server/bot.ts). */
export type BotLevel = 'slow' | 'medium' | 'fast';

/**
 * Someone in the room. Who they are is `id`; where they are is one of three things: at the table (`seat`), waiting
 * for a seat (`queued`), or neither: just watching. Whether they are here or away (`connected`) is apart from that.
 */
export interface PlayerView {
  /** Who this is, for as long as the table stands: it never changes and is never anyone else's. Everything about a person goes by it (who you are, who said what, who is in voice, whose line of the score sheet); what is about cards goes by `seat`. */
  id: number;
  /** Their seat at the table, which is their colour and whose cards are theirs; null for someone without one (watching). */
  seat: number | null;
  /** With a seat: when they sat down (a count; lower is earlier). The lobby lists by it, so whoever sits down goes to the end, whatever colour they take. */
  sat?: number;
  name: string;
  /** Where the picture they put up of themselves is (server/pictures.ts), if they are signed in and did. */
  picture?: string;
  /**
   * Where their page is (`/u/<handle>`), for someone else signed in, and told only to someone signed in: never who
   * they are signed in as (server/room.ts). Never one's own: that is in one's `Account`.
   */
  handle?: string;
  connected: boolean;
  /** Up from their cards in the round being played: they stood up (or whoever deals stood them up), left, or were sent away. Their cards lie there until it is over, and they play no more of it nor have a say in its votes. Then whoever stood up is watching; whoever left or was sent away is gone, and back by the same token is someone new. */
  left?: true;
  /** Standing up from their cards in the round being played, for now: as good as away (no say in its votes) until they sit back down; watching from the next round if they have not by its end. */
  standing?: true;
  /** Total across finished rounds. */
  score: number;
  /** How many rounds that is the total of: the ones they were dealt into (fewer than the table has played, for someone who came later or was away). */
  rounds: number;
  /** How many of those rounds they got Nertz in (`RoundEnd.out`). */
  calls: number;
  isHost: boolean;
  /** Once the cards are dealt, until play opens: has said they are ready for the dealer's Start (a bot always is). */
  ready?: boolean;
  /** Without a seat, and waiting for one: it is theirs when one is free and no round is being played, in the order they asked (the order of the list). Without a seat and without this: watching by choice. */
  queued?: boolean;
  /** Set for a bot the host added (it always counts as connected); absent for a person. */
  bot?: BotLevel;
  /** The faces and backs this player chose: the cards of their deck are drawn so for everyone. A bot's, and anyone's who has not said yet, are the plain ones. */
  look: Look;
}

/**
 * The seats at a table: how many it has (`of`: the host's to set, between rounds, from `MIN_PLAYERS` to `MAX_PLAYERS`)
 * and how many of them are taken. Taken is held by someone at the table, but not by anyone up from their cards in the
 * round (they keep it only for those). Not a house rule: what it may be set to, and who sits down when it changes, depend
 * on who is at the table. See `freeSeats` and `fewestSeats`.
 */
export interface Seats {
  of: number;
  taken: number;
}


/**
 * Who paused a round in play: a player (`id`); or the server, stopped for an update. While the server that stopped is
 * going down the update is under way; `done` once a server is back with the table (server/room.ts `restored`), and
 * only then: the stopping server's last word is not yet done, whatever the line is doing when it is heard.
 */
export type Pause = { by: 'player'; id: number } | { by: 'update'; done: boolean };
/** Everything one client needs to render, personalised for the player `me`. */
export interface RoomView {
  code: string;
  phase: Phase;
  /** Rounds started so far (0 in the first lobby). */
  round: number;
  /** Who you are: your `PlayerView.id`. */
  me: number;
  /** The seat whose cards are yours to play: null if you have none (watching), or are up from yours (`PlayerView.left`), when your line of `players` still has it. */
  seat: number | null;
  /** Those at the table by seat; then those waiting for a seat, first to be seated first; then those just watching. */
  players: PlayerView[];
  /** The table's house rules. Only the host changes them, between rounds. */
  settings: TableSettings;
  seats: Seats;
  /** The table is kept off the home page's list (and its count): the host's to set, at any time. */
  unlisted: boolean;
  /**
   * Redacted current round; null in the lobby. Kept through 'results' as the
   * final table (centre slots, tray, hands), so the client can play the
   * end-of-round sequence from it.
   */
  game: GameState | null;
  /**
   * Milliseconds left of the round's timed status when this snapshot was sent, which `game.status` names: the deal
   * (`dealing`), the "1, 2, 3" (`countdown`: play opens, on the word NERTZ!, when it reaches 0) or the held-card
   * window (`grace`). Null in any other status. A duration, not a timestamp: count it down locally from when the
   * snapshot arrives.
   */
  timerMs: number | null;
  /**
   * The round's clock: how long it had been played when this snapshot was sent (from the word NERTZ!, not counting
   * time paused), and whether it is running: count on locally while it is. It stops when the round ends, and stays
   * at what the round took. Null before the first round is under way.
   */
  clock: { ms: number; running: boolean } | null;
  /** The round is paused (`Pause`): every card is hidden, no move is taken and the bots wait. Null otherwise. */
  paused: Pause | null;
  lastRound: RoundResult | null;
  /** The server has its aids for trying things out on (locally, and on previews): set-up deals (`?deal=`), Shift+N. */
  testing: boolean;
}

/**
 * Someone signed in (server/accounts.ts): `id` is who they are, for good. Their name and picture are what Google had
 * for them when they last signed in.
 */
/** A way to sign in: with Google, or with a code sent to one's email. */
export type Way = 'google' | 'email';

export interface Account {
  id: string;
  /** The name they go by, theirs to change (server/profile.ts): null for none chosen yet. */
  name: string | null;
  /** Google's picture of them, if it has one. */
  image: string | null;
  /** Where the picture they put up of themselves is (server/pictures.ts), if they did: shown before Google's, and the only one shown to anyone else. */
  picture: string | null;
  /** Where their page is: `/u/<handle>`. Drawn at random, and what anyone else is shown of them, as `id` never is. */
  handle: string;
  /** Their page is theirs alone: to anyone else it is not there, and nobody at a table is told where it is. */
  private: boolean;
  /** Theirs is an address the server's ADMIN_EMAILS names: they can see how much the game is played (`Usage`). */
  admin?: true;
}

/**
 * What kind of game a round was, by who held hands in it (a guest is a person): every hand a person's (`humans`); two
 * people or more, and bots (`mixed`); one person or none, the rest bots (`bots`).
 */
export const GAME_KINDS = ['humans', 'mixed', 'bots'] as const;
export type GameKind = (typeof GAME_KINDS)[number];

/** Which rounds are counted, for someone's record and for how much the game is played: every one, or one kind. */
export const AMONG = ['all', ...GAME_KINDS] as const;
export type Among = (typeof AMONG)[number];

/**
 * One person's record, over the rounds they played to the end signed in (server/rounds.ts): all of them, or some (`Among`).
 */
export interface Stats {
  rounds: number;
  /** Rounds in which nobody scored more than they did (and somebody else played). */
  won: number;
  /** Rounds they ended by calling Nertz. */
  nertz: number;
  /** Everything they scored, added up; and the most in one round (null with no round played). */
  points: number;
  bestPoints: number | null;
  /** Their own cards played to the middle, added up; and the most in one round (null with no round played). */
  cards: number;
  bestCards: number | null;
  /** Cards left in their nertz pile at the end of each round, added up. */
  nertzLeft: number;
  /**
   * How far ahead they finish, on average over the rounds with someone else in them: in each, the share of the others
   * who scored less than they did, a tie counting half (1 first, 0 last, ½ the middle of any table). Null for no such round.
   */
  ahead: number | null;
  /** Times they sniped someone, and times someone sniped them. */
  snipes: number;
  sniped: number;
}

/** How one person has done against another, over the rounds they both played signed in (of those `Among` says). */
export interface Versus {
  rounds: number;
  /** Rounds they scored more than the other did, and rounds the other scored more (the rest were level). */
  ahead: number;
  behind: number;
  /**
   * How far ahead of the other they finished, on average over those rounds: the places between them over the size of
   * the table less one, a tie counting half (−1 to 1; 0 with no rounds).
   */
  edge: number;
  /** Everything they scored in those rounds, and everything the other did. */
  points: number;
  theirs: number;
  /** Times they sniped the other in those rounds, and times the other sniped them. */
  snipes: number;
  sniped: number;
}

/** Someone's page, as someone signed in sees it (`GET /stats/<handle>`): the name they go by, their record, and yours against them (null on your own). */
export interface Page {
  name: string | null;
  /** The picture they put up (server/pictures.ts), if they did: never Google's, as at a table. */
  picture: string | null;
  stats: Stats;
  versus: Versus | null;
}

/**
 * Someone you follow (`GET /profile/following`): the name they go by; where their page is, their picture, and you
 * against them over every round, but for a page that is theirs alone (null, each of them).
 */
export interface Followed {
  name: string | null;
  handle: string | null;
  picture: string | null;
  versus: Versus | null;
}

/** How much was played (server/rounds.ts): sittings, rounds, the accounts that played, and hands played as a guest or by a bot. */
export interface Played {
  games: number;
  rounds: number;
  players: number;
  guests: number;
  bots: number;
}

/**
 * How much the game is played (`GET /usage`, for an admin alone): all told; each of the last days, oldest first, by
 * the date it was where the asker is; and the latest sittings, latest first.
 */
export interface Usage {
  total: Played;
  days: (Played & { day: string })[];
  games: {
    /** When its last round ended (ms), the table's code, its rounds and how long they were played (ms). */
    at: number;
    code: string;
    rounds: number;
    ms: number;
    /** Who played in it, by the name they played under: signed in, a guest, or a bot. */
    players: { name: string; as: 'account' | 'guest' | 'bot' }[];
  }[];
}

/**
 * A table as the home page lists it (`GET /tables`), for anyone to see before coming to it: what it is doing and who is
 * at it by the names they go by. Nothing that says who anyone is beyond that (no `id`, never a token).
 */
export interface TableSummary {
  code: string;
  /** Those at the table, by seat. */
  names: string[];
  /** How many it seats. */
  seats: number;
  /** Those here without a seat: watching, or waiting for one. */
  watching: number;
  /** Rounds started so far (0: none yet). */
  round: number;
  /** Round `round` is on: dealt, and not yet scored. */
  playing: boolean;
}

/** What `GET /tables` answers: how many tables someone is at just now, and the latest of them to change (the list is cut short). */
export interface OpenTables {
  open: number;
  tables: TableSummary[];
}
