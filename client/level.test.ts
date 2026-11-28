import { describe, expect, it } from 'vitest';
import { inPlay, lcg, seats, withPile } from '../shared/testkit';
import { computeLayout } from './layout';
import { IN_PILE, inHand, levelOf, mover, moving, whoseOf, type Doing, type Whose } from './level';

/** Levels the layout gives cards in play: an opponent's hand, the middle, your own hand, a work pile being looked at. */
const LYING = [1000, 1234, 5000, 5215, 6400, 6534, 7400, 7413];
const travelling = (by: Whose): Doing => ({ k: 'travelling', by });
const turning = (by: Whose): Doing => ({ k: 'turning', by });

describe('a card\'s level', () => {
  it('is the layout\'s while it is in its pile, lying still or shifting within it', () => {
    for (const z of LYING) expect(levelOf(z, IN_PILE)).toBe(z);
  });

  it('only a card that changes pile is travelling, and it is whoever moves it: yours, else someone else\'s, else the table\'s', () => {
    expect(moving('work 2', 'work 2', 'yours', IN_PILE)).toBe(IN_PILE);
    expect(moving('stock 0', 'stock 0', 'theirs', IN_PILE)).toBe(IN_PILE);
    expect(moving('work 2', 'work 3', 'yours', IN_PILE)).toEqual(travelling('yours'));
    expect(moving('stock 0', 'waste 0', 'theirs', IN_PILE)).toEqual(travelling('theirs'));
    expect(mover('yours', 'table')).toBe('yours');
    expect(mover('table', 'yours')).toBe('yours');
    expect(mover('theirs', 'table')).toBe('theirs');
    expect(mover('table', 'theirs')).toBe('theirs');
    expect(mover('table', 'table')).toBe('table');
  });

  it('a card laid out anew within the pile it is on its way to (the round ends as it lands) goes on travelling, by whoever was moving it', () => {
    for (const by of ['yours', 'theirs'] as const) {
      expect(moving('slot 2', 'slot 2', 'table', travelling(by))).toEqual(travelling(by));
      expect(moving('slot 2', 'slot 2', 'table', turning(by))).toEqual(travelling(by));
      // Still over everything lying still in the middle, at its new place in the pile as much as at its old one.
      expect(levelOf(5028, moving('slot 2', 'slot 2', 'table', travelling(by)))).toBeGreaterThan(Math.max(...LYING.filter((z) => z < 6000)));
    }
  });

  it('travelling, your card or the table\'s is over everything lying still, and travelling cards keep their order', () => {
    const top = Math.max(...LYING);
    for (const by of ['yours', 'table'] as const) for (const z of LYING) expect(levelOf(z, travelling(by))).toBeGreaterThan(top);
    for (const by of ['yours', 'theirs', 'table'] as const) expect(levelOf(6431, travelling(by))).toBeLessThan(levelOf(6432, travelling(by)));
    expect(levelOf(1031, travelling('theirs'))).toBeLessThan(levelOf(1032, travelling('theirs')));
  });

  it('turning over on the way, the cards of a hand are in the opposite order, and over everything lying still (but your hand, for someone else\'s)', () => {
    for (const [by, waste] of [['yours', [6430, 6431, 6432]], ['theirs', [1230, 1231, 1232]]] as const) {
      const turned = waste.map((z) => levelOf(z, turning(by)));
      expect(turned[0]).toBeGreaterThan(turned[1]!);
      expect(turned[1]).toBeGreaterThan(turned[2]!);
      expect(Math.min(...turned)).toBeGreaterThan(Math.max(...LYING.filter((z) => by === 'yours' || z < 6400)));
    }
  });

  it('in the deck, the cards that leave first are on top, whatever level they are dealt to, and a card leaving it is over those still in it', () => {
    for (const by of ['yours', 'theirs'] as const) {
      expect(levelOf(6400, { k: 'deck', under: 3, by })).toBeGreaterThan(levelOf(6490, { k: 'deck', under: 2, by }));
      const lies = by === 'yours' ? 6400 : 1000;
      expect(levelOf(lies, travelling(by))).toBeGreaterThan(levelOf(lies, { k: 'deck', under: 51, by }));
    }
  });

  it('a card in your own hand is over everything; one someone else carries is over every card of theirs on its way', () => {
    const flying = Math.max(...LYING.flatMap((z) => (['yours', 'theirs', 'table'] as const).flatMap((by) => [levelOf(z, travelling(by)), levelOf(z, turning(by)), levelOf(z, { k: 'deck', under: 52, by })])));
    expect(levelOf(1000, { k: 'held', i: 0 })).toBeGreaterThan(flying);
    const carried = levelOf(1000, { k: 'carried', i: 0 });
    expect(levelOf(1000, { k: 'carried', i: 1 })).toBeGreaterThan(carried);
    expect(Math.max(...LYING.flatMap((z) => [levelOf(z, travelling('theirs')), levelOf(z, turning('theirs'))]))).toBeLessThan(carried);
    expect(inHand({ k: 'held', i: 0 }) && inHand({ k: 'carried', i: 0 })).toBe(true);
    expect(inHand(travelling('yours'))).toBe(false);
  });

  it('someone else\'s card in the air, carried or on its way, never covers your own hand, and is over every other card lying still: 2 to 10 at the table', () => {
    // (Seven at the table at 1174x1043: a card a bot dragged out of the column of hands on the left came over yours.)
    for (let n = 2; n <= 10; n++) {
      const game = withPile(inPlay(seats(n), lcg(n)), 1, 0, 'H', 3);
      for (const [W, H] of [[1174, 1043], [1280, 800], [852, 393], [393, 665]] as const) {
        for (const peek of [null, 2]) {
          const L = computeLayout(W, H, game, 0, 'live', peek);
          const where = `${n} players, ${W}x${H}${peek === null ? '' : ', looking at a pile'}`;
          const yours = L.cards.filter((c) => whoseOf(c) === 'yours').map((c) => c.z);
          const others = L.cards.filter((c) => whoseOf(c) !== 'yours').map((c) => c.z);
          // Their card in the air is on its way to a place in their hand or in the middle, or is in their hand or their deck.
          const theirs = L.cards.find((c) => whoseOf(c) === 'theirs')!.z;
          const aloft = [
            ...others.flatMap((z) => [levelOf(z, travelling('theirs')), levelOf(z, turning('theirs'))]),
            ...Array.from({ length: 13 }, (_, i) => levelOf(theirs, { k: 'carried', i })),
            ...Array.from({ length: 52 }, (_, under) => levelOf(theirs, { k: 'deck', under, by: 'theirs' })),
          ];
          expect(Math.max(...aloft), where).toBeLessThan(Math.min(...yours));
          expect(Math.min(...aloft), where).toBeGreaterThan(Math.max(...others));
        }
      }
    }
  });
});
