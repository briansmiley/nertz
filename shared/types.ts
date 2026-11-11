// Data shapes shared by server and client. Types only: no runtime code here.
//
// Pile convention, everywhere: the TOP of a pile is the LAST array element.

import type { TableSettings } from './settings';

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
  /** Face-up; only the top is playable. */
  waste: AnyCard[];
  stuck: boolean;
  /**
   * Id of the card this player is dragging right now (the bottom card of the
   * lifted run), or null. Always a card they could pick up. Visible to everyone.
   */
  holding: string | null;
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
   * The shared middle: a fixed grid of 4 x players slots. Each entry is one
   * centre pile, Ace up to King in one suit; an empty array is an empty slot.
   * A pile of 13 is complete: it takes nothing more and stays in its slot
   * until the player who placed its King (that King's `owner`) clears it.
   */
  slots: Card[][];
  /** Completed piles cleared off the table, oldest first. Each has 13 cards, King on top. Still scores. */
  tray: Card[][];
  /** Seat that called "Nertz!", or null while the round is in full swing. */
  nertzCalledBy: number | null;
  /**
   * Held-card grace. Empty until Nertz is called. From then on: the seats that
   * were holding a playable card at the call and may still make exactly one
   * move with it. Everyone else is frozen. The round is over once Nertz has
   * been called and this is empty again (`isOver`).
   */
  grace: number[];
}

export type RoundStage = 'dealing' | 'ready' | 'countdown' | 'play';

/** Where a card can be dropped: one of your own work piles, or one specific centre slot. */
export type PileRef = { k: 'work'; i: number } | { k: 'slot'; i: number };

export type Intent =
  /**
   * Put `cardId` on exactly `to`. `count` is how many cards the sender lifted:
   * the card itself plus the run on top of it, as they saw it. If that is not
   * what lies there now (a card they thought had left came back), the move is
   * refused rather than carrying cards that were never picked up.
   */
  | { k: 'move'; cardId: string; count: number; to: PileRef }
  | { k: 'flip' }
  | { k: 'stuck'; on: boolean }
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

/** One line of the score sheet. Carries the name and total so the sheet stays right if that player leaves the table. */
export interface RoundLine extends RoundScore {
  name: string;
  /** Running total including this round. */
  total: number;
}

export interface RoundResult {
  calledBy: number;
  scores: RoundLine[];
}

export type Phase = 'lobby' | 'playing' | 'results';

/** How quick and how observant a bot is (the numbers are in server/bot.ts). */
export type BotLevel = 'slow' | 'medium' | 'fast';

export interface PlayerView {
  seat: number;
  name: string;
  connected: boolean;
  /** Total across finished rounds. */
  score: number;
  isHost: boolean;
  stuck: boolean;
  /** Set for a bot the host added (it always counts as connected); absent for a person. */
  bot?: BotLevel;
}

/** Everything one client needs to render, personalised for seat `you`. */
export interface RoomView {
  code: string;
  phase: Phase;
  /** Rounds started so far (0 in the first lobby). */
  round: number;
  you: number;
  players: PlayerView[];
  /** The table's house rules, as the next deal will read them. Only the host changes them, between rounds. */
  settings: TableSettings;
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
  lastRound: RoundResult | null;
}
