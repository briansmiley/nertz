import { describe, expect, it } from 'vitest';
import { ending, stageOf, stepAtMount, unrevealed } from './stage';

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
});
