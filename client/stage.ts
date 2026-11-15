// Where the table is in its life (see `Stage`), worked out while rendering from the room and the one thing this
// window keeps of its own: how far it has got through the end of a round, and which round that was.
import type { Stage } from './layout';

/** The step of the end of round this window is at, and the round it is of: a step of any other round means nothing. */
export interface Step {
  round: number;
  stage: Stage;
}

/** A window that comes to the table once the round is scored (a reload, a latecomer) did not watch it end: it starts at the sheet. */
export const stepAtMount = (results: boolean, round: number): Step | null => (results ? { round, stage: 'sheet' } : null);

/**
 * Live while the round is not scored. Once it is: the step this window has got to of that round's end or, before it
 * has taken one, the first (the sheet straight away, for anyone who prefers reduced motion).
 */
export function stageOf(results: boolean, round: number, step: Step | null, calm: boolean): Stage {
  if (!results) return 'live';
  if (step?.round === round) return step.stage;
  return calm ? 'sheet' : 'flip';
}

/** The end of a round is playing out. */
export const ending = (stage: Stage): boolean => stage !== 'live' && stage !== 'sheet';
