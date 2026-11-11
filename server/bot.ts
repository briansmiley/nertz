// A very basic Nertz bot. Pure: no IO, no clock, RNG injected. It is handed the
// same redacted view a human in its seat is sent and answers with one ordinary
// intent, or nothing. The Room owns the timers and submits the intent through
// the same path as a human's, so the engine may still refuse it (a lost race):
// the bot then simply looks again later.
import { completedBy, feltFree, isHidden, legalDrops, type Rng } from '../shared/engine';
import { TABLE, type Pt } from '../shared/table';
import type { AnyCard, BotLevel, GameState, Intent, PileRef } from '../shared/types';

/** A level is exactly two numbers: the mean pause between looks, and the chance of noticing a move on one look. */
export const BOTS: Record<BotLevel, { delayMs: number; observance: number }> = {
  slow: { delayMs: 3200, observance: 0.6 },
  medium: { delayMs: 2200, observance: 0.75 },
  fast: { delayMs: 1400, observance: 0.9 },
};

/** Moves with its own nertz card are noticed more reliably (at these levels the miss chance is about halved)... */
const NERTZ_FOCUS = 0.5;
/** ...and plays to the middle from the waste or a work pile a bit less. Both are exponents on the observance. */
const CENTRE_FOCUS = 1.25;

/**
 * Dealing a card off the stock is a small thing next to looking the table over: the look after a card it dealt comes
 * after this fraction of its usual pause. Three cards (one group) cost one and a half pauses, where a flip of three
 * used to cost one, and a fast bot gets through the stock about as quickly as a quick hand dragging card by card.
 */
export const DEAL_PACE = 0.5;

/** What a bot carries from one look to the next. */
export interface BotMemory {
  /** Cards dealt off the stock (and turns of the waste) since its last real move. Not counted while it is flagged stuck, so a reshuffle starts a fresh count. */
  flips: number;
  /** Its last run move between work piles (the bottom card of the run and the pile it left), so it is never undone. */
  last: { cardId: string; from: number } | null;
}

export const freshMemory = (): BotMemory => ({ flips: 0, last: null });

const top = <T>(pile: readonly T[]): T | undefined => pile[pile.length - 1];

/**
 * One look at the table. Rules in priority order; every candidate move is
 * noticed with a probability, and the highest-priority noticed one is taken:
 *
 *   a. carry one of its finished centre piles to the tray (always noticed: until it has, the engine lets it do nothing else)
 *   b. nertz pile empty: call Nertz (always noticed)
 *   c. nertz top to a work pile (an empty pile only if it builds down nowhere)
 *   d. nertz top to the middle
 *   e. waste top or a work pile's top to the middle
 *   f. a work pile's whole face-up run onto another pile, if that turns over a face-down card or empties the pile
 *   g. waste top onto a work pile it builds down on
 *   h. deal one card off the stock (always noticed; three looks make a group); after a whole fruitless cycle, say "stuck" instead
 *
 * Returns the intent and the memory to keep IF the intent is accepted, or null
 * when there is nothing to do: play has not opened, the round is called, it is
 * not in it, or it cannot see its own face-up cards.
 */
export function chooseIntent(view: GameState, seat: number, memory: BotMemory, rng: Rng, observance = 1): { intent: Intent; memory: BotMemory } | null {
  const me = view.players.find((p) => p.seat === seat);
  if (!me || view.stage !== 'play' || view.nertzCalledBy !== null) return null;
  const nertz = top(me.nertz);
  const waste = me.dealt > 0 ? undefined : top(me.waste); // a group is half-dealt: the waste's top is face-down and out of play
  // Cards that are face-up in play but hidden in this view: the table is not open yet. Look again later.
  if ([nertz, waste, ...me.work.map(top)].some((c) => c && isHidden(c))) return null;

  const noticed = (focus = 1): boolean => rng() < observance ** focus;
  const acted = (intent: Intent, last: BotMemory['last'] = null) => ({ intent, memory: { flips: 0, last } });
  const move = (card: AnyCard, to: PileRef, count = 1): Intent => ({ k: 'move', cardId: card.id, count, to });
  const drops = (card: AnyCard) => legalDrops(view, seat, card.id);
  /** The work pile a single card should go to: one it builds down on, else an empty one. */
  const workFor = (card: AnyCard): Extract<PileRef, { k: 'work' }> | undefined => {
    const piles = drops(card).filter((to): to is Extract<PileRef, { k: 'work' }> => to.k === 'work');
    return piles.find((to) => me.work[to.i]!.length > 0) ?? piles[0];
  };
  /**
   * A place in the middle that takes the card. An Ace fits every empty slot:
   * any of them. On a table without marked places it starts its pile anywhere
   * there is room: of a handful of places it glances at all over the felt, the
   * clear one nearest the middle; and if none of those is clear, wherever the
   * engine says there is room.
   */
  const slotFor = (card: AnyCard): PileRef | undefined => {
    const slots = drops(card).filter((to) => to.k !== 'work');
    const any = slots.length > 1 ? slots[Math.min(slots.length - 1, Math.floor(rng() * slots.length))] : slots[0];
    if (any?.k !== 'felt') return any;
    let best: Pt = any;
    let nearest = Infinity;
    for (let look = 0; look < 5; look++) {
      // (To the thousandth, as it goes over the wire: the place that is checked is the very place that is asked for.)
      const at = { x: Math.round((rng() * 2 - 1) * TABLE.hw * 1000) / 1000, y: Math.round((rng() * 2 - 1) * 1000) / 1000 };
      const d = Math.hypot(at.x / TABLE.hw, at.y);
      if (d < nearest && feltFree(view, at)) [best, nearest] = [at, d];
    }
    return { k: 'felt', x: best.x, y: best.y };
  };

  // a
  const finished = view.slots.findIndex((pile) => completedBy(pile) === seat);
  if (finished >= 0) return acted({ k: 'clear', slot: finished });
  // b
  if (!nertz) return acted({ k: 'nertz' });
  // c
  const home = workFor(nertz);
  if (home && noticed(NERTZ_FOCUS)) return acted(move(nertz, home));
  // d
  const out = slotFor(nertz);
  if (out && noticed(NERTZ_FOCUS)) return acted(move(nertz, out));
  // e
  for (const card of [waste, ...me.work.map(top)]) {
    const to = card && slotFor(card);
    if (to && noticed(CENTRE_FOCUS)) return acted(move(card, to));
  }
  // f: only a whole face-up run can uncover or empty anything. Uncovering first.
  const runs = me.work.map((pile, i) => ({ i, down: me.down[i]!, cards: pile.slice(me.down[i]!) })).filter((r) => r.cards.length > 0);
  for (const { i, cards } of runs.sort((a, b) => b.down - a.down)) {
    const first = cards[0]!;
    // Onto an empty pile it uncovers but empties nothing; the engine refuses a whole pile going to an empty one.
    const to = workFor(first);
    if (!to) continue;
    if (memory.last?.cardId === first.id && memory.last.from === to.i) continue; // never undo its own last move
    if (noticed()) return acted(move(first, to, cards.length), { cardId: first.id, from: i });
  }
  // g: only where it builds down. Empty piles are kept for the nertz card.
  const shelf = waste && drops(waste).find((to) => to.k === 'work' && me.work[to.i]!.length > 0);
  if (shelf && noticed()) return acted(move(waste, shelf));
  // h
  if (me.stuck) return me.stock.length + me.waste.length > 0 ? { intent: { k: 'flip' }, memory } : null;
  // From any point, this many flips (one per card, and one to turn the waste over) bring the stock and waste back to
  // the same state: every waste top has been seen.
  const cycle = me.stock.length + me.waste.length + 1;
  if (memory.flips >= cycle || cycle === 1) return { intent: { k: 'stuck', on: true }, memory: { ...memory, flips: 0 } };
  return { intent: { k: 'flip' }, memory: { ...memory, flips: memory.flips + 1 } };
}
