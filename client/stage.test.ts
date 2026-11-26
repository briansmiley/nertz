import { describe, expect, it } from 'vitest';
import { inPlay, lcg, roomOf, seats } from '../shared/testkit';
import type { PlayerView } from '../shared/types';
import { CLEAR_MS, finaleSteps, sortAt, sortMs, TIMING, washedAt } from './Finale';
import { computeLayout } from './layout';
import { ending, handsAt, stageOf, stepAtMount, unrevealed } from './stage';

describe('the stage of the table', () => {
  it('is live the moment the next round is dealt, whatever step the last one had got to', () => {
    expect(stageOf(false, 4, { round: 3, stage: 'sheet' }, false)).toBe('live');
    expect(stageOf(false, 4, { round: 3, stage: 'wash' }, false)).toBe('live');
    expect(stageOf(false, 4, null, true)).toBe('live');
  });

  it('starts the end of a round at its first step as soon as it is scored, before any step of it is kept', () => {
    expect(stageOf(true, 4, null, false)).toBe('flip');
    expect(stageOf(true, 4, { round: 3, stage: 'sheet' }, false)).toBe('flip');
    // Reduced motion: straight to the sheet.
    expect(stageOf(true, 4, { round: 3, stage: 'sheet' }, true)).toBe('sheet');
  });

  it("goes by the step kept for this round, and only this round's", () => {
    expect(stageOf(true, 4, { round: 4, stage: 'wash' }, false)).toBe('wash');
    expect(stageOf(true, 4, { round: 4, stage: 'flip' }, true)).toBe('flip');
    expect(stageOf(true, 5, { round: 4, stage: 'wash' }, false)).toBe('flip');
  });

  it('puts a window that did not watch the round end straight at the sheet, and plays the next one out', () => {
    const step = stepAtMount(true, 4);
    expect(stageOf(true, 4, step, false)).toBe('sheet');
    expect(stageOf(false, 5, step, false)).toBe('live');
    expect(stageOf(true, 5, step, false)).toBe('flip');
    expect(stepAtMount(false, 4)).toBeNull();
  });

  it('is playing out between live and the sheet', () => {
    expect(ending('live')).toBe(false);
    expect((['flip', 'spread', 'out', 'wash', 'sort', 'won'] as const).every(ending)).toBe(true);
    expect(ending('sheet')).toBe(false);
  });

  it("has the round's result still to show while it is played and while its end plays out, until its winner is marked", () => {
    expect((['live', 'flip', 'spread', 'out', 'wash', 'sort'] as const).map((s) => unrevealed(s, 4))).toEqual([4, 4, 4, 4, 4, 4]);
    expect(unrevealed('won', 4)).toBeNull();
    expect(unrevealed('sheet', 4)).toBeNull();
    // Reduced motion, a skip, or a window that did not watch the round end: at the sheet, nothing is still to show.
    expect(unrevealed(stageOf(true, 4, null, true), 4)).toBeNull();
    expect(unrevealed(stageOf(true, 4, stepAtMount(true, 4), false), 4)).toBeNull();
  });

  it('the end of a round is one schedule: its steps in order, the sorting when the canvas has washed, the sheet a hold after the winner', () => {
    for (const [tray, players, clear] of [[3, 4, false], [0, 2, false], [5, 10, true], [0, 3, true]] as const) {
      const steps = finaleSteps(tray, players, clear);
      const at = Object.fromEntries(steps) as Record<string, number>;
      expect(steps.map(([stage]) => stage)).toEqual(['spread', 'out', 'wash', 'sort', 'won', 'sheet']);
      expect(steps.map(([, ms]) => ms)).toEqual([...steps.map(([, ms]) => ms)].sort((a, b) => a - b)); // never backwards
      // The canvas counts from 'spread': it has washed, and sorted everyone's cards, when these say so.
      expect(at.sort! - at.spread!).toBe(washedAt(tray));
      expect(at.won! - at.spread!).toBe(sortAt(tray, clear) + sortMs(players));
      expect(at.wash! - at.out!).toBe(tray ? TIMING.out : 0); // (nothing in the tray: nothing to come out of it)
      expect(at.sheet! - at.won!).toBe(TIMING.hold);
      expect(sortAt(tray, true) - sortAt(tray)).toBe(CLEAR_MS);
    }
  });
});

describe('who is at the table between rounds', () => {
  // Four played the round. Since: whoever deals sent seat 1 away, took the bot off seat 2 and put another bot there,
  // stood seat 3 up to watch, and added a bot, which sat at seat 4.
  const game = inPlay(seats(4), lcg(7));
  const was = roomOf(game, 0);
  const lastRound = { end: { by: 'vote' as const }, scores: seats(4).map((seat) => ({ seat, id: seat, name: `p${seat}`, played: 0, nertzLeft: 0, delta: 0, total: 0, rounds: 1, calls: 0 })) };
  const players: PlayerView[] = [
    was.players[0]!,
    { ...was.players[0]!, id: 8, seat: 2, name: 'Bot Bix', isHost: false, bot: 'medium' },
    { ...was.players[3]!, seat: null },
    { ...was.players[0]!, id: 9, seat: 4, name: 'Bot Cleo', isHost: false, bot: 'medium' },
  ];
  const room = roomOf(game, 0, { phase: 'results', lastRound, players });
  const sitting = players.flatMap((p) => (p.seat === null ? [] : [p.seat]));

  it('keeps every hand of the round while it is played and while its end plays out: the cards of whoever has gone since lie where they left them', () => {
    for (const stage of ['live', 'flip', 'wash', 'sort', 'won'] as const) expect(handsAt(stage, room)).toEqual([0, 1, 2, 3]);
  });

  it('once the score sheet is up, keeps only the hands of those still sitting where they played them', () => {
    expect(handsAt('sheet', room)).toEqual([0]);
    expect(handsAt('sheet', roomOf(game, 0, { phase: 'results', lastRound }))).toEqual([0, 1, 2, 3]); // (nobody gone: everyone's)
  });

  it('lays out a place for each hand of the round still at the table then, and none for anyone gone or anyone who sat down since: they have one at the next deal', () => {
    const view = room.game!;
    const hands = view.players.filter((g) => handsAt('sheet', room).includes(g.seat));
    const L = computeLayout(1440, 900, view, 0, 'sheet', null, undefined, sitting, undefined, hands);
    expect(L.opponents.map((o) => o.seat)).toEqual([]); // (seat 2 someone else's now, seat 4 new: neither is of the round)
    expect(L.cards.filter((c) => c.pile !== 'slot' && c.pile !== 'tray').every((c) => c.card.owner === 0)).toBe(true);
    // The one who sat down since, looking on: no place of their own, they watch the table as anyone without one does.
    const theirs = computeLayout(1440, 900, view, 4, 'sheet', null, undefined, sitting, undefined, hands);
    expect([theirs.me, theirs.opponents.map((o) => o.seat)]).toEqual([null, [0]]);
    // While the round's end plays out, it is the table as the round left it, with whoever sat down since beside it.
    expect(computeLayout(1440, 900, view, 0, 'wash', null, undefined, sitting).opponents.map((o) => o.seat)).toEqual([1, 2, 3, 4]);
  });

  it('lays the table out for one alone at it (everyone else gone since: the one bot taken off), whatever the shape of the window', () => {
    const view = room.game!;
    for (const [W, H] of [[1440, 900], [390, 844], [844, 390]] as const) {
      const L = computeLayout(W, H, view, 0, 'sheet', null, undefined, [0], undefined, view.players.filter((g) => g.seat === 0));
      expect(L.opponents).toEqual([]);
      const box = L.me!.box;
      expect([L.felt.cx, L.felt.cy, L.fs, box.x, box.y, box.w, box.h, ...L.cards.flatMap((c) => [c.x, c.y, c.s])].every(Number.isFinite)).toBe(true);
      expect(L.felt.u).toBeGreaterThan(0);
    }
  });
});
