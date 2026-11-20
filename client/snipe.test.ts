import { describe, expect, it } from 'vitest';
import { heard, type Snipe, type SnipeWord } from './snipe';

const words = (...ws: SnipeWord[]): Snipe | null => ws.reduce<Snipe | null>(heard, null);

describe('a snipe on the felt', () => {
  it('one card that beats two to its pile names them both, in the order they were told of, and comes again for the second', () => {
    expect(words({ by: 0, of: 2, card: '0:S5' })).toEqual({ card: '0:S5', by: 0, of: [2], n: 1 });
    expect(words({ by: 0, of: 2, card: '0:S5' }, { by: 0, of: 4, card: '0:S5' })).toEqual({ card: '0:S5', by: 0, of: [2, 4], n: 2 });
    expect(words({ by: 0, of: 2, card: '0:S5' }, { by: 0, of: 4, card: '0:S5' }, { by: 0, of: 1, card: '0:S5' })?.of).toEqual([2, 4, 1]);
  });

  it('another card\'s snipe is a notice of its own, whoever it is between', () => {
    expect(words({ by: 0, of: 2, card: '0:S5' }, { by: 0, of: 4, card: '0:H9' })).toEqual({ card: '0:H9', by: 0, of: [4], n: 2 });
    expect(words({ by: 0, of: 2, card: '0:S5' }, { by: 3, of: 0, card: '3:D7' })).toEqual({ card: '3:D7', by: 3, of: [0], n: 2 });
  });

  it('the same seat told of twice for one card is named once, and the notice still comes again', () => {
    expect(words({ by: 0, of: 2, card: '0:S5' }, { by: 0, of: 4, card: '0:S5' }, { by: 0, of: 2, card: '0:S5' })).toEqual({ card: '0:S5', by: 0, of: [4, 2], n: 3 });
  });
});
