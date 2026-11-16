// The sound of each player's cards sorted out to them at the end of a round: one shot per card up to a cap, none for
// none, timed by the very schedule the canvas draws the cards' flights to.
import { describe, expect, it } from 'vitest';
import type { Card, GameState, RoundScore } from '../shared/types';
import { frameAt, gatherOrder, LAND_MS, sortAt, sortings, TIMING, type Mover, type Plan } from './Finale';
import { ALLOTMENT_CAP, allotment, RIFFLE_GAP_MS } from './soundEvents';

const card = (owner: number, i: number): Card => ({ id: `${owner}.${i}`, owner, suit: 'S', rank: (i % 13) + 1 });
const cards = (owner: number, n: number): Card[] => Array.from({ length: n }, (_, i) => card(owner, i));

/** Three players: seat 0 got 9 cards to the middle (5 still in a slot, 4 in a finished pile), seat 1 got 2, seat 2 none. */
const game = {
  players: [{ seat: 0 }, { seat: 1 }, { seat: 2 }],
  slots: [{ cards: [...cards(0, 5), ...cards(1, 2)] }, null],
  tray: [cards(0, 9).slice(5)],
} as unknown as GameState;
const scores: RoundScore[] = [
  { seat: 0, played: 9, nertzLeft: 0, delta: 9 },
  { seat: 1, played: 2, nertzLeft: 3, delta: -4 },
  { seat: 2, played: 0, nertzLeft: 5, delta: -10 },
];

describe('the sorting schedule', () => {
  it('gathers the lowest score first and the best last', () => {
    expect(gatherOrder([9, -4, -10])).toEqual([2, 1, 0]);
    expect(gatherOrder([1, 1, 0])).toEqual([1, 2, 0]);
  });

  it("lands each player's own cards, in their turn", () => {
    const [a, b, c] = sortings(game, scores, false);
    expect([a!.lands.length, b!.lands.length, c!.lands.length]).toEqual([9, 2, 0]);
    const from = sortAt(1, false);
    expect(b!.lands[0]).toBe(from + 1 * TIMING.sortEach + LAND_MS); // second to be gathered
    expect(a!.lands[0]).toBe(from + 2 * TIMING.sortEach + LAND_MS); // the best, last
    expect(a!.lands).toEqual([...a!.lands].sort((x, y) => x - y));
    expect(a!.lands.at(-1)! - a!.lands[0]!).toBeLessThan(TIMING.sortEach);
    // On a phone the table is cleared first: everything later by just that much.
    const [phone] = sortings(game, scores, true);
    expect(phone!.lands[0]! - a!.lands[0]!).toBe(sortAt(1, true) - from);
  });

  it('is when the canvas puts each card down on its pile', () => {
    const [sorted] = sortings(game, scores, false);
    const of = 9;
    const pile = { seat: 0, x: 0, y: 0, w: 40, h: 56, total: of, label: { x: 0, y: 0, w: 1, h: 1 }, side: 'below' as const };
    const movers = Array.from({ length: of }, (_, k): Mover => ({ id: `${k}`, owner: 0, x: 0, y: 0, angle: 0, radius: 0, spin: 0, delay: 0, tray: false, pile: 0, k, of, tilt: 0, rot0: 0 }));
    const plan = { area: { x: 0, y: 0, w: 100, h: 100 }, movers, sortAt: sortAt(1, false), piles: [pile], w: 40, h: 56, scale: 1, cx: 50, cy: 50, rx: 10, ry: 10 } as unknown as Plan;
    sorted!.lands.forEach((t, k) => {
      expect(frameAt(plan, 'sort', t - 1, 0, [2]).landed[0]).toBe(k);
      expect(frameAt(plan, 'sort', t, 0, [2]).landed[0]).toBe(k + 1);
    });
  });
});

describe("the sound of a player's cards arriving", () => {
  const [nine, two, none] = sortings(game, scores, false).map((s) => s.lands);

  it('is one shot per card, up to the cap, and nothing for no cards', () => {
    for (const how of ['landings', 'riffle', 'swish'] as const) {
      expect(allotment(nine!, how)).toHaveLength(ALLOTMENT_CAP);
      expect(allotment(two!, how)).toHaveLength(2);
      expect(allotment(none!, how)).toEqual([]);
    }
  });

  it('lands with the cards: every card while there are few, the first and the last and between them evenly when there are more', () => {
    expect(allotment(two!, 'landings')).toEqual(two);
    const shots = allotment(nine!, 'landings');
    expect(shots[0]).toBe(nine![0]);
    expect(shots.at(-1)).toBe(nine!.at(-1));
    for (const t of shots) expect(nine).toContain(t);
    expect(allotment(nine!, 'swish')).toEqual(shots);
  });

  it('as a riffle, starts as the first card lands', () => {
    expect(allotment(nine!, 'riffle')).toEqual(Array.from({ length: ALLOTMENT_CAP }, (_, i) => nine![0]! + i * RIFFLE_GAP_MS));
  });
});
