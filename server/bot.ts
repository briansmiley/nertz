// A very basic Nertz bot. Pure: no IO, no clock, RNG injected. It is handed the
// same redacted view a human in its seat is sent and answers with one ordinary
// intent, or nothing. The Room owns the timers and submits the intent through
// the same path as a human's, so the engine may still refuse it (a lost race):
// the bot then simply looks again later.
import { completedBy, DRAW_COUNT, faceUp, feltFree, isHidden, isLive, legalDrops, type Rng } from '../shared/engine';
import { feltHw, type Pt } from '../shared/table';
import type { AnyCard, BotLevel, GameState, Intent, PileRef } from '../shared/types';

/** A level is exactly two numbers: the mean pause between looks, and the chance of noticing a move on one look. */
export const BOTS: Record<BotLevel, { delayMs: number; observance: number }> = {
  slow: { delayMs: 3200, observance: 0.6 },
  medium: { delayMs: 2200, observance: 0.75 },
  fast: { delayMs: 1400, observance: 0.9 },
};

/**
 * A bigger table is harder to keep an eye on, for a bot as for a person: there are more piles in the middle to watch
 * and more hands moving. For every player beyond two, a bot's pause between looks is this much longer (`delay`, as a
 * share of its level's), and its miss rate grows (`miss`: added to an exponent on the observance, so a careful bot
 * loses less than a careless one). At two players a bot is exactly its level.
 */
export const CROWD = { delay: 0.05, miss: 0.07 } as const;

/** A bot of `level` at a table where `players` were dealt in: its mean pause and its chance of noticing a move. */
export function botAt(level: BotLevel, players: number): { delayMs: number; observance: number } {
  const extra = Math.max(0, players - 2);
  const base = BOTS[level];
  return { delayMs: base.delayMs * (1 + CROWD.delay * extra), observance: base.observance ** (1 + CROWD.miss * extra) };
}

/** Moves with its own nertz card are noticed more reliably (at these levels the miss chance is about halved)... */
const NERTZ_FOCUS = 0.5;
/** ...and plays to the middle from the waste or a work pile a bit less. Both are exponents on the observance. */
const CENTRE_FOCUS = 1.25;

/** What a bot carries from one look to the next. */
export interface BotMemory {
  /** Draws off the stock (and turns of the waste) since its last real move. Not counted while it is flagged stuck, so a reshuffle starts a fresh count. */
  draws: number;
  /** Its last run move between work piles (the bottom card of the run and the pile it left), so it is never undone. */
  last: { cardId: string; from: number } | null;
}

export const freshMemory = (): BotMemory => ({ draws: 0, last: null });

const top = <T>(pile: readonly T[]): T | undefined => pile[pile.length - 1];

/**
 * One look at the table. Rules in priority order; every candidate move is
 * noticed with a probability, and the highest-priority noticed one is taken. While its draw is in flight it does
 * nothing but a and b: it waits to see what comes up (the Room has it look again when the group is up).
 *
 *   a. carry one of its finished centre piles to the tray (always noticed: until it has, the engine lets it do nothing else)
 *   b. nertz pile empty: call Nertz (always noticed)
 *   c. nertz top to the middle (it scores there, and is off the nertz pile all the same)
 *   d. nertz top to a work pile (an empty pile only if it builds down nowhere)
 *   e. waste top or a work pile's top to the middle
 *      (an Ace, in c or e, is always noticed: nobody deals past an Ace)
 *   f. a work pile's whole face-up run onto another pile, if that turns over a face-down card or empties the pile
 *   g. waste top onto a work pile it builds down on
 *   h. draw off the stock (always noticed); after a whole fruitless cycle, say "stuck" instead
 *
 * Returns the intent and the memory to keep IF the intent is accepted, or null
 * when there is nothing to do: play has not opened, the round is called, it is
 * not in it, or it cannot see its own face-up cards.
 */
export function chooseIntent(view: GameState, seat: number, memory: BotMemory, rng: Rng, observance = 1): { intent: Intent; memory: BotMemory } | null {
  const me = view.players.find((p) => p.seat === seat);
  if (!me || !isLive(view)) return null;
  const nertz = top(me.nertz);
  const waste = top(me.waste);
  // Cards that are face-up in play but hidden in this view: the table is not open yet. Look again later.
  if ([nertz, ...(me.dealt > 0 ? [] : [waste]), ...me.work.map((w) => top(w.cards))].some((c) => c && isHidden(c))) return null;

  const noticed = (focus = 1): boolean => rng() < observance ** focus;
  /** Nobody overlooks an Ace: it always goes out to the middle. */
  const ace = (card: AnyCard): boolean => !isHidden(card) && card.rank === 1;
  const acted = (intent: Intent, last: BotMemory['last'] = null) => ({ intent, memory: { draws: 0, last } });
  const move = (card: AnyCard, to: PileRef, count = 1): Intent => ({ k: 'move', cardId: card.id, count, to });
  const drops = (card: AnyCard) => legalDrops(view, seat, card.id);
  /** The work pile a single card should go to: one it builds down on, else an empty one. */
  const workFor = (card: AnyCard): Extract<PileRef, { k: 'work' }> | undefined => {
    const piles = drops(card).filter((to): to is Extract<PileRef, { k: 'work' }> => to.k === 'work');
    return piles.find((to) => me.work[to.i]!.cards.length > 0) ?? piles[0];
  };
  /**
   * A place in the middle that takes the card: any of them, if several do. An
   * Ace starts its pile anywhere there is room: of a handful of places it
   * glances at all over the felt, the clear one nearest the middle; and if none
   * of those is clear, wherever the engine says there is room.
   */
  const slotFor = (card: AnyCard): PileRef | undefined => {
    const slots = drops(card).filter((to) => to.k !== 'work');
    const any = slots.length > 1 ? slots[Math.min(slots.length - 1, Math.floor(rng() * slots.length))] : slots[0];
    if (any?.k !== 'felt') return any;
    let best: Pt = any;
    let nearest = Infinity;
    for (let look = 0; look < 5; look++) {
      // (To the thousandth, as it goes over the wire: the place that is checked is the very place that is asked for.)
      const at = { x: Math.round((rng() * 2 - 1) * feltHw(view.players.length) * 1000) / 1000, y: Math.round((rng() * 2 - 1) * 1000) / 1000 };
      const d = Math.hypot(at.x / feltHw(view.players.length), at.y);
      if (d < nearest && feltFree(view, at)) [best, nearest] = [at, d];
    }
    return { k: 'felt', x: best.x, y: best.y };
  };

  // a
  const finished = view.slots.findIndex((pile) => completedBy(pile) === seat);
  if (finished >= 0) return acted({ k: 'clear', slot: finished });
  // b
  if (!nertz) return acted({ k: 'nertz' });
  if (me.dealt > 0) return null;
  // c
  const out = slotFor(nertz);
  if (out && (ace(nertz) || noticed(NERTZ_FOCUS))) return acted(move(nertz, out));
  // d
  const home = workFor(nertz);
  if (home && noticed(NERTZ_FOCUS)) return acted(move(nertz, home));
  // e
  for (const card of [waste, ...me.work.map((w) => top(w.cards))]) {
    const to = card && slotFor(card);
    if (to && (ace(card) || noticed(CENTRE_FOCUS))) return acted(move(card, to));
  }
  // f: only a whole face-up run can uncover or empty anything. Uncovering first.
  const runs = me.work.map((pile, i) => ({ i, down: pile.down, cards: faceUp(pile) })).filter((r) => r.cards.length > 0);
  for (const { i, cards } of runs.sort((a, b) => b.down - a.down)) {
    const first = cards[0]!;
    // Onto an empty pile it uncovers but empties nothing; the engine refuses a whole pile going to an empty one.
    const to = workFor(first);
    if (!to) continue;
    if (memory.last?.cardId === first.id && memory.last.from === to.i) continue; // never undo its own last move
    if (noticed()) return acted(move(first, to, cards.length), { cardId: first.id, from: i });
  }
  // g: only where it builds down. Empty piles are kept for the nertz card.
  const shelf = waste && drops(waste).find((to) => to.k === 'work' && me.work[to.i]!.cards.length > 0);
  if (shelf && noticed()) return acted(move(waste, shelf));
  // h
  if (me.stuck) return me.stock.length + me.waste.length > 0 ? { intent: { k: 'draw' }, memory } : null;
  // From any point, this many draws (one per group, and one to turn the waste over) bring the stock and waste back to
  // the same state: every waste top has been seen.
  const cycle = Math.ceil(me.stock.length / DRAW_COUNT) + Math.ceil(me.waste.length / DRAW_COUNT) + 1;
  if (memory.draws >= cycle || cycle === 1) return { intent: { k: 'stuck', on: true }, memory: { ...memory, draws: 0 } };
  return { intent: { k: 'draw' }, memory: { ...memory, draws: memory.draws + 1 } };
}
