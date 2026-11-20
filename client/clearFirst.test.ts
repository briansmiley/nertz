import { describe, expect, it } from 'vitest';
import { pile, roomOf, table } from '../shared/testkit';
import type { GameState } from '../shared/types';
import { cue, waitingPile } from './clearFirst';

/** A King on the pile in slot 1: seat 0's own, on its own pile. */
const waiting = (): GameState => table([{}, {}], { slots: [pile('H3', 1), pile('S13', 0)] });

describe('a finished pile of yours is waiting', () => {
  it('names the slot of the pile whose King you placed, while the round is being played', () => {
    expect(waitingPile(roomOf(waiting(), 0))).toBe(1);
  });

  it('is nobody else\'s business: not the other player\'s, nor a watcher\'s', () => {
    expect(waitingPile(roomOf(waiting(), 1))).toBe(-1);
    expect(waitingPile(roomOf(waiting(), 0, { seat: null }))).toBe(-1);
  });

  it('nothing waits where there is no finished pile, no round, or no room', () => {
    expect(waitingPile(roomOf(table([{}, {}], { slots: [pile('H3', 1), pile('S12', 0)] }), 0))).toBe(-1);
    expect(waitingPile(roomOf(waiting(), 0, { game: null }))).toBe(-1);
    expect(waitingPile(null)).toBe(-1);
  });

  it('nothing waits once Nertz is called, once the round is scored, while it is paused, or before play has opened', () => {
    expect(waitingPile(roomOf({ ...waiting(), status: { at: 'grace', calledBy: 1 } }, 0))).toBe(-1);
    expect(waitingPile(roomOf(waiting(), 0, { phase: 'results' }))).toBe(-1);
    expect(waitingPile(roomOf(waiting(), 0, { paused: { by: 1 } }))).toBe(-1);
    expect(waitingPile(roomOf({ ...waiting(), status: { at: 'countdown' } }, 0))).toBe(-1);
  });

  it('nods as it is finished and says nothing; says "Drag to tray" once something else is tried, or it has waited, and shakes afresh at every try', () => {
    expect(cue(0, false)).toEqual({ cls: ' nod', told: false });
    expect(cue(0, true)).toEqual({ cls: ' nod', told: true });
    expect(cue(1, false)).toEqual({ cls: ' nudge', told: true });
    expect(cue(2, false).cls).not.toBe(cue(1, false).cls);
    expect(cue(3, true)).toEqual(cue(1, false));
  });
});
