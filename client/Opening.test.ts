import { describe, expect, it } from 'vitest';
import { START_BEAT_MS, START_MS } from '../shared/protocol';
import { beatAt } from './Opening';

describe('the opening count', () => {
  it('says 1, 2, 3, one beat each, from the duration left; a window that arrives late starts on the right number', () => {
    expect(beatAt(START_MS)).toBe(1);
    expect(beatAt(START_MS - START_BEAT_MS + 1)).toBe(1);
    expect(beatAt(START_MS - START_BEAT_MS)).toBe(2);
    expect(beatAt(START_BEAT_MS + 1)).toBe(2);
    expect(beatAt(START_BEAT_MS)).toBe(3);
    expect(beatAt(1)).toBe(3);
    // The local clock ran out before the snapshot that opens play arrived: it stays on 3, the word is the server's.
    expect(beatAt(0)).toBe(3);
    expect(beatAt(START_MS + 50)).toBe(1);
  });
});
