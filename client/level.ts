// A card's stacking level (its z-index). The layout says how high a card lies in its place (layout.ts, `Placed.z`);
// what the card is doing at the moment, and whose it is, say the rest. `levelOf` is the only place they are put together.
import type { Placed } from './layout';

/**
 * Whose a card is while it is somewhere: in your own hand, in someone else's, or the table's (the middle and the tray).
 * A card in the air is whoever moves it: yours if it is in your hand or on its way to or from it; else someone else's
 * if it is in theirs or on its way to or from it; else the table's (a finished pile on its way to the tray).
 */
export type Whose = 'yours' | 'theirs' | 'table';

/** Whose the place a card lies in is, as the layout has it. */
export const whoseOf = (c: Pick<Placed, 'mine' | 'pile'>): Whose => (c.mine ? 'yours' : c.pile === 'slot' || c.pile === 'tray' ? 'table' : 'theirs');

/** Who a card going from a place that is `from`'s to one that is `to`'s is moved by. */
export const mover = (from: Whose, to: Whose): Whose => (from === 'yours' || to === 'yours' ? 'yours' : from === 'theirs' || to === 'theirs' ? 'theirs' : 'table');

/** What a card is doing, as far as its level goes. */
export type Doing =
  /**
   * In its pile: lying where the layout put it, or moving within the pile (a work pile fanning out, a pile closing up
   * after its top card left, a group counted off the stock). Going nowhere, it keeps its place in the pile.
   */
  | { k: 'pile' }
  /** On its way to another pile, or back to its own out of a hand; `turning`: in the first half of turning face-up on the way. */
  | { k: 'travelling' | 'turning'; by: Whose }
  /** Waiting in the deck before the deal, with `under` cards beneath it that are dealt after it. */
  | { k: 'deck'; under: number; by: Whose }
  /** In your own hand ('held') or, as reported, in someone else's ('carried'): the `i`th of the cards in it. */
  | { k: 'held' | 'carried'; i: number };

export const IN_PILE: Doing = { k: 'pile' };

/** A card that the layout moves from the place `from` to the place `to`, moved by `by`: within its pile, or travelling to another. */
export const moving = (from: string, to: string, by: Whose): Doing => (from === to ? IN_PILE : { k: 'travelling', by });

/** In a player's hand: the pointer (or that player's reports) says where it is, not the layout. */
export const inHand = (d: Doing): d is Doing & { k: 'held' | 'carried' } => d.k === 'held' || d.k === 'carried';

/**
 * Where a card in the air is stacked, by whose it is.
 *
 * Yours, and the table's: over every card lying in its place (in play none lies higher than 7600, layout.ts), at the
 * level it is going to lie at plus `flying`; one in your hand over all of that. A deck waits at `deck`, each card by
how many are dealt after it.
 *
 * Someone else's: over everyone else's hands and the middle, which lie under 6000, and under your own hand, which lies
 * at 6400 and up (layout.ts `OWN_Z`). Your hand is what you are playing: a card on its way from someone else's never
 * hides it. That band has room only for a card's place within its pile (`within`), not for the whole of where it lies.
 */
const AIR = { yours: { deck: 10000, flying: 10000, hand: 30000 }, theirs: { deck: 6000, flying: 6060, hand: 6260 } } as const;
/** A card's place within its hand, or within its pile in the middle: the layout numbers each hand's cards, and each pile's, within 200 of where that hand or pile starts. */
const within = (lies: number): number => lies % 200;

/** The level of a card that lies at `lies` in the layout and is doing `d`. */
export function levelOf(lies: number, d: Doing): number {
  if (d.k === 'pile') return lies;
  if (inHand(d)) return (d.k === 'held' ? AIR.yours : AIR.theirs).hand + d.i;
  const air = d.by === 'theirs' ? AIR.theirs : AIR.yours;
  const at = d.by === 'theirs' ? within(lies) : lies;
  switch (d.k) {
    case 'travelling':
      return air.flying + at;
    case 'turning':
      // A stack turned over shows the back of the card that was on top of it until the faces come round, and only
      // then the card that ends on top. So until then the cards keep the order they were held in, which is the other
      // way round: their order within the hand (its piles are numbered within a hundred) is mirrored.
      return air.flying + at - 2 * (at % 100) + 99;
    case 'deck':
      return air.deck + d.under; // (under 52: a card leaving the deck is over those still in it)
  }
}
