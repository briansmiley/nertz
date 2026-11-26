// Where the table is in its life (see `Stage`), worked out while rendering from the room and the one thing this
// window keeps of its own: how far it has got through the end of a round, and which round that was.
import type { RoomView } from '../shared/types';
import { revealed, type Stage } from './layout';

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

/** The round whose result this window has yet to show: the one being played, or the one whose end is playing out until its winner is marked. */
export const unrevealed = (stage: Stage, round: number): number | null => (revealed(stage) ? null : round);

/**
 * The seats whose hands of the round are at the table at `stage`: every one while it is played and while its end plays
 * out (whoever has gone since left their cards where they lie). Once the score sheet is up, the table is who of the
 * round is at it still: a hand is there only while whoever played it still sits where they did. (Their seat, empty or
 * someone else's by now, is no longer theirs.)
 */
export function handsAt(stage: Stage, room: RoomView): number[] {
  const seats = room.game?.players.map((g) => g.seat) ?? [];
  if (stage !== 'sheet') return seats;
  const played = (seat: number) => room.lastRound?.scores.find((s) => s.seat === seat)?.id;
  return seats.filter((seat) => room.players.some((p) => p.seat === seat && p.id === played(seat)));
}
