import { describe, expect, it } from 'vitest';
import { IN_PILE, inHand, levelOf, moving, TRAVELLING, TURNING } from './level';

/** Levels the layout gives cards in play: an opponent's hand, the middle, your own hand, a work pile being looked at. */
const LYING = [1000, 1234, 5000, 5215, 6000, 6134, 7000, 7013];

describe('a card\'s level', () => {
  it('is the layout\'s while it is in its pile, lying still or shifting within it', () => {
    for (const z of LYING) expect(levelOf(z, IN_PILE)).toBe(z);
  });

  it('only a card that changes pile is travelling', () => {
    expect(moving('work 2', 'work 2')).toBe(IN_PILE);
    expect(moving('stock 0', 'stock 0')).toBe(IN_PILE);
    expect(moving('work 2', 'work 3')).toBe(TRAVELLING);
    expect(moving('stock 0', 'waste 0')).toBe(TRAVELLING);
  });

  it('travelling, a card is over everything lying still, and travelling cards keep their order', () => {
    const top = Math.max(...LYING);
    for (const z of LYING) expect(levelOf(z, TRAVELLING)).toBeGreaterThan(top);
    expect(levelOf(6031, TRAVELLING)).toBeLessThan(levelOf(6032, TRAVELLING));
  });

  it('turning over on the way, the cards of a hand are in the opposite order, and still over everything lying still', () => {
    const waste = [6030, 6031, 6032];
    const turning = waste.map((z) => levelOf(z, TURNING));
    expect(turning[0]).toBeGreaterThan(turning[1]!);
    expect(turning[1]).toBeGreaterThan(turning[2]!);
    expect(Math.min(...turning)).toBeGreaterThan(Math.max(...LYING));
  });

  it('in the deck, the cards that leave first are on top, whatever level they are dealt to', () => {
    expect(levelOf(6000, { k: 'deck', under: 3 })).toBeGreaterThan(levelOf(6090, { k: 'deck', under: 2 }));
  });

  it('a card someone else carries is over every card of the layout, flying or not; one in your own hand is over that', () => {
    const flying = Math.max(...LYING.flatMap((z) => [levelOf(z, TRAVELLING), levelOf(z, TURNING), levelOf(z, { k: 'deck', under: 52 })]));
    const carried = levelOf(1000, { k: 'carried', i: 0 });
    expect(carried).toBeGreaterThan(flying);
    expect(levelOf(1000, { k: 'carried', i: 1 })).toBeGreaterThan(carried);
    expect(levelOf(1000, { k: 'held', i: 0 })).toBeGreaterThan(levelOf(7000, { k: 'carried', i: 12 }));
    expect(inHand({ k: 'held', i: 0 }) && inHand({ k: 'carried', i: 0 })).toBe(true);
    expect(inHand(TRAVELLING)).toBe(false);
  });
});
