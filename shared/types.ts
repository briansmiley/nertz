// Data shapes shared by server and client. Types only: no runtime code here.
//
// Pile convention, everywhere: the TOP of a pile is the LAST array element.

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
  /**
   * Always exactly 4 piles. In pile i the bottom `down[i]` cards are face-down;
   * everything above them is a face-up descending alternating-colour run.
   */
  work: AnyCard[][];
  /**
   * How many cards at the bottom of each work pile are still face-down. A
   * non-empty pile always has a face-up top: when the face-up cards leave, the
   * next card turns over (down[i] drops by one).
   */
  down: number[];
  /** Face-down. */
  stock: AnyCard[];
  /** Face-up, except the top `dealt` cards; only the top is playable, and only when `dealt` is 0. */
  waste: AnyCard[];
  /**
   * How many cards of a group still being dealt lie face-down on top of the
   * waste: 0, 1 or 2. Cards come off the stock one per `flip`; the third (or
   * the last card of the stock) turns the group face-up and this is 0 again.
   * Never above 0 on an empty stock.
   */
  dealt: number;
  stuck: boolean;
  /** Has voted to end the round where it stands (see `GameState.ended`). */
  ending?: boolean;
  /**
   * Id of the card this player is dragging right now (the bottom card of the
   * lifted run), or null. Always a card they could pick up. Visible to everyone.
   */
  holding: string | null;
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
  /**
   * How far the opening of the round has got. Only `play` accepts intents.
   * - `dealing`: the cards are being dealt out; no face is shown to anyone. Until the server's deal timer (`finishDeal`).
   * - `ready`: the work piles' tops are face-up, every nertz top is still face-down. Waits, without limit, for the dealer (`startCountdown`).
   * - `countdown`: "1, 2, 3": as `ready`, until the server's start timer (`openPlay`).
   * - `play`: the nertz tops are turned over and the round is on.
   */
  stage: RoundStage;
  /**
   * The shared middle: 4 x players slots, each holding one centre pile or
   * nothing (null). A pile takes the first empty slot when its Ace is put
   * down and keeps it until it is cleared: the slot's index is how everyone
   * names the pile meanwhile.
   */
  slots: (CentrePile | null)[];
  /** Completed piles cleared off the table, oldest first. Each has 13 cards, King on top. Still scores. */
  tray: Card[][];
  /** Seat that called "Nertz!", or null while the round is in full swing. */
  nertzCalledBy: number | null;
  /**
   * Set when the round ended without a Nertz call, scored as it stands: 'jam' when everyone said they were stuck and
   * no card could move anywhere, at any shift of any stock; 'vote' when every connected person voted to end it.
   */
  ended?: 'jam' | 'vote';
  /**
   * Held-card grace. Empty until Nertz is called. From then on: the seats that
   * were holding a playable card at the call and may still make exactly one
   * move with it. Everyone else is frozen. The round is over once Nertz has
   * been called and this is empty again (`isOver`).
   */
  grace: number[];
}

export type RoundStage = 'dealing' | 'ready' | 'countdown' | 'play';

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
  | { k: 'move'; cardId: string; count: number; to: PileRef }
  /**
   * One card off the stock, face-down onto the waste; the third of a group (or
   * the last card of the stock) turns the group up. On an empty stock: turn
   * the waste back over into the stock.
   */
  | { k: 'flip' }
  | { k: 'stuck'; on: boolean }
  /** Vote (or stop voting) to end the round where it stands. */
  | { k: 'end'; on: boolean }
  | { k: 'nertz' }
  /** Move the completed pile in `slot` to the tray. Only for the player who placed its King, and the only thing they may do until it is done. */
  | { k: 'clear'; slot: number }
  /** A drag started on `cardId`. */
  | { k: 'hold'; cardId: string }
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
  /** A bot, or a person, that whoever deals has sent away since: their line is no longer shown on the score sheet. */
  gone?: boolean;
  /** Their faces and backs when the round ended, named as in `PlayerView`. */
  deck?: string;
  back?: string;
}

export interface RoundResult {
  /** Who called Nertz; null if the round ended without a call (`ended` says how). */
  calledBy: number | null;
  ended?: 'jam' | 'vote';
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
  name: string;
  connected: boolean;
  /** Total across finished rounds. */
  score: number;
  /** How many rounds that is the total of: the ones they were dealt into (fewer than the table has played, for someone who came later or was away). */
  rounds: number;
  isHost: boolean;
  /** Once the cards are dealt, until play opens: has said they are ready for the dealer's Start (a bot always is). */
  ready?: boolean;
  /** Without a seat, and waiting for one: it is theirs when one is free and no round is being played, in the order they asked (the order of the list). Without a seat and without this: watching by choice. */
  queued?: boolean;
  /** Set for a bot the host added (it always counts as connected); absent for a person. */
  bot?: BotLevel;
  /** The card faces this player chose (shared/protocol.ts `DECKS`, with `:night` after it for the dark ones): the cards of their deck are drawn so for everyone. A bot's are the plain ones. Absent (they have not said yet): the plain one. */
  deck?: string;
  /** The backs of this player's cards (`CARD_BACKS`, with `:bare` after it for one without its white edge), for everyone likewise. Absent: the plain one. */
  back?: string;
  /** Set if their back is drawn by lot (once for the table, at its first deal after the lot was chosen): the lot ('all', or a kind of back). `back` is then 'any' until a round is on. */
  lot?: string;
}

/**
 * The seats at a table: how many it has (`of`: the host's to set, between rounds, from `MIN_PLAYERS` to `MAX_PLAYERS`)
 * and how many of them are taken. Taken is held by someone at the table, but not by anyone gone whose cards are still in
 * the round (they keep only those). Not a house rule: what it may be set to, and who sits down when it changes, depend
 * on who is at the table. See `freeSeats` and `fewestSeats`.
 */
export interface Seats {
  of: number;
  taken: number;
}

/** Everything one client needs to render, personalised for the player `me`. */
export interface RoomView {
  code: string;
  phase: Phase;
  /** Rounds started so far (0 in the first lobby). */
  round: number;
  /** Who you are: your `PlayerView.id`. */
  me: number;
  /** Your seat, or null if you have none (watching): the same as your line of `players` says. */
  seat: number | null;
  /** Those at the table by seat; then those waiting for a seat, first to be seated first; then those just watching. */
  players: PlayerView[];
  /** The table's house rules. Only the host changes them, between rounds. */
  settings: TableSettings;
  seats: Seats;
  /**
   * Redacted current round; null in the lobby. Kept through 'results' as the
   * final table (centre slots, tray, hands), so the client can play the
   * end-of-round sequence from it.
   */
  game: GameState | null;
  /**
   * Milliseconds left in the held-card grace window at the moment this
   * snapshot was sent; null when no grace window is running. A duration, not
   * a timestamp: count it down locally from when the snapshot arrives.
   */
  graceMs: number | null;
  /**
   * Milliseconds of the deal left when this snapshot was sent (`game.stage` is
   * `dealing`); null otherwise. Like `graceMs`, a duration to count down locally.
   */
  dealMs: number | null;
  /**
   * Milliseconds of the "1, 2, 3" left when this snapshot was sent (`game.stage`
   * is `countdown`): play opens, on the word NERTZ!, when it reaches 0. Null otherwise.
   */
  startMs: number | null;
  /**
   * The round's clock: how long it had been played when this snapshot was sent (from the word NERTZ!, not counting
   * time paused), and whether it is running: count on locally while it is. It stops when the round ends, and stays
   * at what the round took. Null before the first round is under way.
   */
  clock: { ms: number; running: boolean } | null;
  /** The round is paused (by this player, an `id`): every card is hidden, no move is taken and the bots wait. Null otherwise. */
  paused: { by: number } | null;
  lastRound: RoundResult | null;
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
