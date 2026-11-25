import { describe, expect, it } from 'vitest';
import { START_BEAT_MS, START_MS } from '../shared/protocol';
import { deal, finishDeal } from '../shared/engine';
import { lcg, roomOf } from '../shared/testkit';
import type { RoomView } from '../shared/types';
import { type Ask, askAfter, beatAt, notReady, pressStart, readyCount } from './Opening';

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

describe('the tally under the names', () => {
  const waiting = roomOf(finishDeal(deal([0, 1, 2, 3], lcg(5))), 0).players.filter((p) => !p.isHost);

  it('counts who has said ready out of everyone waiting on the dealer', () => {
    expect(readyCount(waiting)).toEqual({ ready: 0, of: 3 });
    expect(readyCount(waiting.map((p) => (p.seat === 2 ? { ...p, ready: true } : p)))).toEqual({ ready: 1, of: 3 });
  });

  it('leaves out someone away, as Start does: it is full exactly when nobody is waited on', () => {
    const away = waiting.map((p) => (p.seat === 3 ? { ...p, connected: false } : p.seat === 1 ? { ...p, standing: true as const } : { ...p, ready: true }));
    expect(readyCount(away)).toEqual({ ready: 1, of: 1 });
    expect(readyCount(waiting.map((p) => ({ ...p, connected: false, ready: true })))).toEqual({ ready: 0, of: 0 });
  });
});

describe('a press of Start', () => {
  const asked = (at: number): Ask => ({ at, on: [2, 3] });

  it('goes at once when nobody is waited on', () => {
    expect(pressStart(0, null, 1000)).toBe('go');
    expect(pressStart(0, asked(900), 1000)).toBe('go');
  });

  it('with someone not ready only asks, and the next press goes ahead', () => {
    expect(pressStart(2, null, 1000)).toBe('ask');
    expect(pressStart(2, asked(1000), 3000)).toBe('go');
  });

  it('is not two presses for a double click or a held key: the warning has to have been up a moment', () => {
    expect(pressStart(2, asked(1000), 1100)).toBe('same');
    expect(pressStart(2, asked(1000), 1399)).toBe('same');
    expect(pressStart(2, asked(1000), 1400)).toBe('go');
  });
});

describe('a Start the dealer has asked for, as the ones not ready change', () => {
  const ask: Ask = { at: 1000, on: [2, 3] };

  it('goes once the last of them is ready, or has left: everyone still there is', () => {
    expect(askAfter(ask, [])).toBe('go');
    expect(askAfter({ at: 1000, on: [2] }, [])).toBe('go');
  });

  it('stands while they only get fewer, waiting on those who are left: someone saying ready never ends it', () => {
    expect(askAfter(ask, [3])).toEqual({ at: 1000, on: [3] });
    expect(askAfter(ask, [2])).toEqual({ at: 1000, on: [2] });
    expect(askAfter(ask, [3, 2])).toEqual({ at: 1000, on: [3, 2] });
  });

  it('is ended by anyone newly not ready: sat down since, or took back a ready they had said', () => {
    expect(askAfter(ask, [2, 3, 4])).toBeNull();
    expect(askAfter(ask, [4])).toBeNull();
  });

  it('is ended by one it waited on saying ready and taking it back: it no longer waits on them', () => {
    const left = askAfter(ask, [3]) as Ask;
    expect(askAfter(left, [2, 3])).toBeNull();
    expect(askAfter(left, [2])).toBeNull();
  });
});
