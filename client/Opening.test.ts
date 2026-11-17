import { describe, expect, it } from 'vitest';
import { START_BEAT_MS, START_MS } from '../shared/protocol';
import { deal, finishDeal } from '../shared/engine';
import { lcg, roomOf } from '../shared/testkit';
import type { RoomView } from '../shared/types';
import { beatAt, notReady, pressStart } from './Opening';

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

describe('who the dealer is waiting on', () => {
  const waiting = finishDeal(deal([0, 1, 2, 3], lcg(5)));
  const room = (ready: number[], extra: Partial<RoomView> = {}): RoomView => {
    const base = roomOf(waiting, 0);
    return { ...base, players: base.players.map((p) => (ready.includes(p.seat!) ? { ...p, ready: true } : p)), ...extra };
  };

  it('is everyone dealt in but the dealer who has not said ready; bots arrive ready, as the server says', () => {
    expect(notReady(room([])).map((p) => p.seat)).toEqual([1, 2, 3]);
    expect(notReady(room([2])).map((p) => p.seat)).toEqual([1, 3]);
    expect(notReady(room([1, 2, 3]))).toEqual([]);
  });

  it('does not wait on someone who is away: they cannot say ready, so Start never warns about them', () => {
    const r = room([1]);
    const away = { ...r, players: r.players.map((p) => (p.seat === 3 ? { ...p, connected: false } : p)) };
    expect(notReady(away).map((p) => p.seat)).toEqual([2]);
  });

  it('is nobody before the table waits or after it has started, and does not count someone who was not dealt in', () => {
    const r = room([]);
    expect(notReady({ ...r, game: { ...r.game!, status: { at: 'countdown' } } })).toEqual([]);
    expect(notReady({ ...r, game: null })).toEqual([]);
    const sitting = { ...r.players[3]!, seat: 7 };
    expect(notReady({ ...r, players: [...r.players.slice(0, 3), sitting] }).map((p) => p.seat)).toEqual([1, 2]);
  });
});

describe('a press of Start', () => {
  it('goes at once when nobody is waited on', () => {
    expect(pressStart(0, null, 1000)).toBe('go');
    expect(pressStart(0, 900, 1000)).toBe('go');
  });

  it('with someone not ready only warns, and the next press goes ahead', () => {
    expect(pressStart(2, null, 1000)).toBe('warn');
    expect(pressStart(2, 1000, 3000)).toBe('go');
  });

  it('is not two presses for a double click or a held key: the warning has to have been up a moment', () => {
    expect(pressStart(2, 1000, 1100)).toBe('same');
    expect(pressStart(2, 1000, 1399)).toBe('same');
    expect(pressStart(2, 1000, 1400)).toBe('go');
  });
});
