// A bot's card in the air. People's held cards reach everyone else as drag
// reports (DragAt in protocol.ts) sent by their own window; a bot has no
// window, so the server makes the reports up: a short, eased path from the
// card's pile to where the bot is putting it, in the same two frames a
// person's window would use. Pure: room.ts sends the frames on a timer.
import type { DragAt } from './protocol';
import type { GameState, Intent, PileRef } from './types';

/**
 * Gaps in an opponent's hand, in card widths: between work piles (`gap`), and
 * between the nertz pile, the work piles and the stock (`wide`). client/layout.ts
 * draws other players' hands with these, so a bot's card moving along its row
 * lands where the window draws the pile.
 */
export const OPP = { gap: 0.14, wide: 0.42 } as const;

/** How long a bot's card is in the air, ms: a move along its own row, and one out to the middle. */
export const FLIGHT_MS = { row: 300, centre: 650 } as const;
/** How much of a bot's way to the middle is the hop out of its hand to the felt's edge; the rest is the felt. */
const OUT = 0.25;
/** How often the made-up reports go out (a dragging window reports at DRAG_HZ, 18 a second). */
export const FLIGHT_STEP_MS = 55;

/** Where a pile of a hand starts along its row, in card widths from the nertz pile's left edge. */
function rowX(pile: 'nertz' | 'work' | 'waste', i = 0): number {
  const work = 1 + OPP.wide;
  if (pile === 'nertz') return 0;
  if (pile === 'work') return work + i * (1 + OPP.gap);
  const stock = work + 4 + 3 * OPP.gap + OPP.wide;
  return stock + 1 + OPP.gap;
}

/** Which of a player's piles a card is in (for where it starts along the row). */
function source(state: GameState, seat: number, cardId: string): number | null {
  const p = state.players.find((q) => q.seat === seat);
  if (!p) return null;
  if (p.nertz.at(-1)?.id === cardId) return rowX('nertz');
  if (p.waste.at(-1)?.id === cardId) return rowX('waste');
  const i = p.work.findIndex((w) => w.cards.some((c) => c.id === cardId));
  return i < 0 ? null : rowX('work', i);
}

/** The point of the felt a move to the middle is going to, in table space; null for a move along the row. */
function target(state: GameState, to: PileRef): { x: number; y: number } | null {
  if (to.k === 'felt') return { x: to.x, y: to.y };
  if (to.k === 'slot') return state.slots[to.i]?.at ?? null;
  return null;
}

const ease = (t: number) => t * t * (3 - 2 * t);
const r3 = (v: number) => Math.round(v * 1000) / 1000;

/**
 * The reports for a bot moving a card, one per FLIGHT_STEP_MS, the last over
 * the place it lands. Empty when there is nothing to show (not a move, or a
 * card it does not have). Read by the window as it reads a person's:
 * - out to the middle: `p` is the place all along (so the window picks that
 *   pile), `w` goes 0 to 2 (out to the felt's edge, and on to the place) and
 *   the card lifts a little out of the hand (`h`) as it goes;
 * - along its own row (to a work pile): `h` slides it the width of piles
 *   between, with a small hop, and `p` is off the felt so it never lingers there.
 */
export function flightFrames(state: GameState, seat: number, intent: Intent): DragAt[] {
  if (intent.k !== 'move') return [];
  const from = source(state, seat, intent.cardId);
  if (from === null) return [];
  const there = target(state, intent.to);
  const ms = there ? FLIGHT_MS.centre : FLIGHT_MS.row;
  const n = Math.max(2, Math.round(ms / FLIGHT_STEP_MS));
  const frames: DragAt[] = [];
  for (let k = 1; k <= n; k++) {
    const e = ease(k / n);
    if (there) {
      frames.push({ id: intent.cardId, w: r3(e < OUT ? e / OUT : 1 + (e - OUT) / (1 - OUT)), h: [0, r3(0.5 * e)], p: [r3(there.x), r3(there.y)] });
    } else {
      const to = intent.to.k === 'work' ? rowX('work', intent.to.i) : from;
      frames.push({ id: intent.cardId, w: 0, h: [r3((to - from) * e), r3(0.35 * Math.sin(Math.PI * e))], p: [0, 50] });
    }
  }
  return frames;
}
