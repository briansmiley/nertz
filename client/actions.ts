// What can be done to the table during a round, as opposed to your own settings (Settings.tsx): pause it or carry
// on, vote to end it, deal it again, leave. Each has one rule here for whether it is open to you now; the menu
// (Menu.tsx), the P key, the card over a paused table and the "End round" button at the table all ask it here.
import { dragsOn, endVote, isLive, seatedPeople } from '../shared/engine';
import type { RoomView } from '../shared/types';
import { send } from './clearFirst';
import { leave, pause, redeal } from './net';

const meOf = (room: RoomView) => room.players.find((p) => p.id === room.me);

/** Can you pause the round right now? While it is live, if you were dealt in. */
export function canPause(room: RoomView | null | undefined): boolean {
  const g = room?.game;
  return !!room && !room.paused && !!g && isLive(g) && g.players.some((p) => p.seat === room.seat);
}

/** Can you carry on from a pause? Whoever paused, the dealer, or anyone once whoever paused is away. */
export function canResume(room: RoomView): boolean {
  if (!room.paused) return false;
  const by = room.players.find((p) => p.id === room.paused!.by);
  return room.paused.by === room.me || !!meOf(room)?.isHost || !by?.connected;
}

/** Can you deal the round over? Whoever deals, at any point of a round. */
export const canRedeal = (room: RoomView): boolean => room.phase === 'playing' && !!room.game && !!meOf(room)?.isHost;

export interface Ballot {
  /** How many have a say, and how many of them have voted. */
  voters: number;
  voted: number;
  /** You have. */
  mine: boolean;
  /** The round drags on, or someone has voted already: the vote stands at the table, beside "I'm stuck". */
  pressing: boolean;
}

/**
 * The vote to end the round, as you may cast it: null unless the round is live (paused or not: the server takes the vote
 * through a pause) and you have a say in it (dealt in, and still at your cards). The tally is the engine's (`endVote`), the same one the server ends
 * the round by.
 */
export function ballot(room: RoomView): Ballot | null {
  const game = room.game;
  if (!game || !isLive(game)) return null;
  const people = seatedPeople(room.players);
  const me = game.players.find((p) => p.seat === room.seat);
  if (!me || !people.includes(me.seat)) return null;
  const tally = endVote(game, people);
  return { ...tally, mine: !!me.ending, pressing: dragsOn(game) || tally.voted > 0 };
}

export type ActionId = 'pause' | 'resume' | 'vote' | 'redeal' | 'leave';

export interface TableAction {
  id: ActionId;
  label: string;
  /** A count beside it: the vote's tally. */
  tally?: string;
  /** Yours is in (the vote): pressed again, it is taken back. */
  on?: boolean;
  /** It cannot be undone, so it is asked twice: what the second press says. */
  sure?: string;
}

/** The actions open to you now, in the order the menu lists them. None unless a round is being played. */
export function tableActions(room: RoomView): TableAction[] {
  if (room.phase !== 'playing' || !room.game) return [];
  const vote = ballot(room);
  return [
    canPause(room) && { id: 'pause' as const, label: 'Pause' },
    canResume(room) && { id: 'resume' as const, label: 'Carry on' },
    vote && { id: 'vote' as const, label: 'End round', tally: `${vote.voted}/${vote.voters}`, on: vote.mine },
    canRedeal(room) && { id: 'redeal' as const, label: 'Deal again', sure: 'Really deal again?' },
    // (Whoever leaves in the middle of a round does not come back to their cards: they lie there, and are scored.)
    { id: 'leave' as const, label: 'Leave table', sure: 'Really leave?' },
  ].filter((a) => !!a);
}

/** Does it. (Each is refused by the server too, by its own rule, if the table has changed since.) */
export function perform(id: ActionId, room: RoomView): void {
  switch (id) {
    case 'pause':
      return pause(true);
    case 'resume':
      return pause(false);
    case 'vote':
      return void send({ k: 'end', on: !ballot(room)?.mine });
    case 'redeal':
      return redeal();
    case 'leave':
      return leave();
  }
}
