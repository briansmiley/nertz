// Data shapes shared by server and client. Types only: no runtime code here.
//
// Pile convention, everywhere: the TOP of a pile is the LAST array element.

export type Suit = 'S' | 'H' | 'D' | 'C';

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
  /** Always exactly 4 piles, each a descending alternating-colour run. */
  work: AnyCard[][];
  /** Face-down. */
  stock: AnyCard[];
  /** Face-up; only the top is playable. */
  waste: AnyCard[];
  stuck: boolean;
}

/** A shared centre pile, Ace up to King in one suit. Its id is the id of its Ace. */
export interface Foundation {
  id: string;
  suit: Suit;
  cards: Card[];
}

/** One round. The server holds it with every card known; clients get it via `viewFor`. */
export interface GameState {
  players: PlayerState[];
  foundations: Foundation[];
  /** Seat that called "Nertz!"; once set the round is over and every intent is rejected. */
  nertzCalledBy: number | null;
}

export type PileRef = { k: 'work'; i: number } | { k: 'foundation'; id: string } | { k: 'newFoundation' };

export type Intent =
  | { k: 'move'; cardId: string; to: PileRef }
  | { k: 'flip' }
  | { k: 'stuck'; on: boolean }
  | { k: 'nertz' };

export interface RoundScore {
  seat: number;
  /** Own cards in the foundations (+1 each). */
  foundation: number;
  /** Cards left in own nertz pile (-2 each). */
  nertzLeft: number;
  /** foundation - 2 * nertzLeft */
  delta: number;
}

export interface RoundResult {
  calledBy: number;
  scores: RoundScore[];
}

export type Phase = 'lobby' | 'playing' | 'results';

export interface PlayerView {
  seat: number;
  name: string;
  connected: boolean;
  /** Total across finished rounds. */
  score: number;
  isHost: boolean;
  stuck: boolean;
}

/** Everything one client needs to render, personalised for seat `you`. */
export interface RoomView {
  code: string;
  phase: Phase;
  /** Rounds started so far (0 in the first lobby). */
  round: number;
  you: number;
  players: PlayerView[];
  /** Redacted current round; null in the lobby. May stay set during 'results' to show the final table. */
  game: GameState | null;
  lastRound: RoundResult | null;
}
