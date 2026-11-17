// A card's stacking level (its z-index). The layout says how high a card lies in its place (layout.ts, `Placed.z`);
// what the card is doing at the moment says the rest. `levelOf` is the only place the two are put together.

/** What a card is doing, as far as its level goes. */
export type Doing =
  /** Lying where the layout put it. */
  | { k: 'still' }
  /** Moving, and staying in its own pile (a work pile fanning out, a pile closing up after its top card left, a group counted off the stock): going nowhere, so it keeps its place in the pile. */
  | { k: 'shifting' }
  /** On its way to another pile, or back to its own out of a hand. */
  | { k: 'travelling' }
  /** The first half of turning face-up on the way. */
  | { k: 'turning' }
  /** Waiting in the deck before the deal, with `under` cards beneath it that are dealt after it. */
  | { k: 'deck'; under: number }
  /** In your own hand ('held') or, as reported, in someone else's ('carried'): the `i`th of the cards in it. */
  | { k: 'held' | 'carried'; i: number };

export const STILL: Doing = { k: 'still' };
export const SHIFTING: Doing = { k: 'shifting' };
export const TRAVELLING: Doing = { k: 'travelling' };
export const TURNING: Doing = { k: 'turning' };

/** A card that the layout moves: within its pile, or from `from` to another. */
export const moving = (from: string, to: string): Doing => (from === to ? SHIFTING : TRAVELLING);

/** In a player's hand: the pointer (or that player's reports) says where it is, not the layout. */
export const inHand = (d: Doing): d is Doing & { k: 'held' | 'carried' } => d.k === 'held' || d.k === 'carried';

/** Above every card lying still: in play none lies higher than 7500 (layout.ts). */
const FLYING = 10000;
/** Someone else's card in the air: over every card of the layout, lying still or flying, and under the one in your own hand. */
const CARRIED = FLYING + 7500;
const HELD = 30000;

/** The level of a card that lies at `lies` in the layout and is doing `d`. */
export function levelOf(lies: number, d: Doing): number {
  switch (d.k) {
    case 'still':
    case 'shifting':
      return lies;
    case 'travelling':
      return lies + FLYING;
    case 'turning':
      // A stack turned over shows the back of the card that was on top of it until the faces come round, and only
      // then the card that ends on top. So until then the cards keep the order they were held in, which is the other
      // way round: their order within the hand (its piles are numbered within a hundred) is mirrored.
      return lies - 2 * (lies % 100) + 99 + FLYING;
    case 'deck':
      return FLYING + d.under;
    case 'carried':
      return CARRIED + d.i;
    case 'held':
      return HELD + d.i;
  }
}
