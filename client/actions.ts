// What can be done to the table, as opposed to your own settings (Settings.tsx): during a round, pause it or
// unpause it, vote to end it, restart it, stand up from it for now; between rounds, reset it; at any time, leave. Each has one rule here for whether it is open to you now; the menu
// (Menu.tsx), the pause key, the card over a paused table and the "End round" button at the table all ask it here. One that
// cannot be undone is asked first (`press`), wherever it was pressed: the menu or the score sheet.
import { useSyncExternalStore } from 'react';
import { dragsOn, endVote, hasOpened, inRound, isLive, plays, seatedPeople } from '../shared/engine';
import type { RoomView } from '../shared/types';
import { send } from './clearFirst';
import { leave, pause, reach, redeal, resetTable, sit, useReach } from './net';

const meOf = (room: RoomView) => room.players.find((p) => p.id === room.me);

/** Can you pause the round right now? While it is live, if you are in it. */
export function canPause(room: RoomView | null | undefined): boolean {
  const g = room?.game;
  return !!room && !room.paused && !!g && isLive(g) && inRound(g, room.seat);
}

/** Can you unpause it? If you are in it, or deal (watching or not). */
export function canResume(room: RoomView): boolean {
  return !!room.paused && !!room.game && (inRound(room.game, room.seat) || !!meOf(room)?.isHost);
}

/**
 * Standing up from your cards, or sitting back down: from the deal until Nertz is called, if you play at the table.
 * From Start it is for now: standing, you are as good as away; you sit back down by saying so, or by playing; and at
 * the round's end you watch. Before Start you watch at once, and take a seat again as anyone watching does.
 * Null if neither is open to you; otherwise whether you are standing.
 */
export function standing(room: RoomView): boolean | null {
  const me = meOf(room);
  return mayStand() && room.phase === 'playing' && !!room.game && (isLive(room.game) || !hasOpened(room.game)) && !!me && plays(me) && !me.bot ? !!me.standing : null;
}

/**
 * Is there any standing up from a table here, to watch it or for now? Only where others can come to it (client/net.ts
 * `Reach`): alone with bots there is nobody to watch, and nobody the round is played on for. The one rule, for the
 * menu, the lobby and the score sheet.
 */
export const mayStand = (): boolean => reach().others;
export const useMayStand = (): boolean => useReach().others;

/** Can you deal the round over? Whoever deals, at any point of a round. */
export const canRedeal = (room: RoomView): boolean => room.phase === 'playing' && !!room.game && !!meOf(room)?.isHost;

/** Can you start the table over (every score to nothing, back to before round 1)? Whoever deals, on the score sheet. */
export const canReset = (room: RoomView): boolean => room.phase === 'results' && !!meOf(room)?.isHost;

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

export type ActionId = 'pause' | 'resume' | 'vote' | 'redeal' | 'reset' | 'stand' | 'leave';

export interface TableAction {
  id: ActionId;
  label: string;
  /** A count beside it: the vote's tally. */
  tally?: string;
  /** Yours is in (the vote): pressed again, it is taken back. */
  on?: boolean;
  /** It cannot be undone, so it is asked first (`Sure`). */
  sure?: boolean;
  /** Not yet open: it opens once the round is live. Shown, faded, and pressing it does nothing. */
  coming?: boolean;
}

/** The action, if it is open to you now (there, and not just coming). */
export const openAction = (room: RoomView, id: ActionId): TableAction | undefined => tableActions(room).find((t) => t.id === id && !t.coming);

/**
 * Pause and the vote are coming to you: from the deal until the round is live, while you are dealt in and have a say
 * (the same say `ballot` asks of you once it is live).
 */
function roundComing(room: RoomView): boolean {
  const g = room.game;
  return room.phase === 'playing' && !!g && !hasOpened(g) && room.seat !== null && inRound(g, room.seat) && seatedPeople(room.players).includes(room.seat);
}

/**
 * The table's actions as the menu lists them, in its order. Each is open to you now, or coming (in the list, not yet to be
 * pressed: Pause and End round before Start), or not there. Leaving is always one, and open.
 */
export function tableActions(room: RoomView): TableAction[] {
  const vote = ballot(room);
  const up = standing(room);
  const coming = roundComing(room);
  return [
    canPause(room) ? { id: 'pause' as const, label: 'Pause' } : coming && { id: 'pause' as const, label: 'Pause', coming: true },
    canResume(room) && { id: 'resume' as const, label: 'Resume game' },
    // (With a say of your own alone, the one human at the table, there is nothing to count.)
    vote ? { id: 'vote' as const, label: 'End round', ...(vote.voters > 1 && { tally: `${vote.voted}/${vote.voters}` }), on: vote.mine } : coming && { id: 'vote' as const, label: 'End round', coming: true },
    canRedeal(room) && { id: 'redeal' as const, label: 'Restart round', sure: true },
    canReset(room) && { id: 'reset' as const, label: 'Reset table', sure: true },
    up !== null && { id: 'stand' as const, label: up ? 'Sit back down' : 'Stand up', on: up },
    // (Whoever leaves in the middle of a round does not come back to their cards: they lie there, and are scored.)
    { id: 'leave' as const, label: 'Leave table', sure: true },
  ].filter((a) => !!a);
}

/** What the pause key presses now: Pause or Resume game, whichever the menu has open to you; neither, nothing. */
export function pauseKeyAction(room: RoomView | null | undefined): 'pause' | 'resume' | null {
  if (!room) return null;
  return openAction(room, 'pause') ? 'pause' : openAction(room, 'resume') ? 'resume' : null;
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
    case 'reset':
      return resetTable();
    case 'stand':
      return sit(!!standing(room));
    case 'leave':
      return leave();
  }
}

/** The action waiting on its question (`press`), if one is. */
let asked: ActionId | null = null;
const askers = new Set<() => void>();
function ask(id: ActionId | null): void {
  if (id === asked) return;
  asked = id;
  for (const l of askers) l();
}

/** Pressed: done at once, or asked first if it cannot be undone. Not open to you now (coming, or not there): nothing. */
export function press(id: ActionId, room: RoomView): void {
  const a = openAction(room, id);
  if (!a) return;
  if (a.sure) ask(id);
  else perform(id, room);
}

/** The answer to the question: yes does it (if it is still open to you), either way the question goes. */
export function answer(yes: boolean, room: RoomView): void {
  const id = asked;
  ask(null);
  if (yes && id && openAction(room, id)) perform(id, room);
}

/** The action being asked about, while it is still open to you (once the table has moved on from it, the question goes too). */
export function useAsked(room: RoomView): TableAction | null {
  const id = useSyncExternalStore(
    (l) => (askers.add(l), () => askers.delete(l)),
    () => asked,
  );
  return (id && openAction(room, id)) || null;
}
