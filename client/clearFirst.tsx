// Clear-first, on the client. The rule itself is the engine's (`mustClear`): a
// player who put a King on a centre pile may do nothing else until they have
// carried the pile to the tray. Here is what the player is shown of it. The
// finished pile glows and gives a small nod. It says nothing until they need
// telling: they try something else (nothing moves, the pile shakes, the tray
// flashes, there is a soft tap), or a few seconds go by. Then it says "Drag to
// tray", and goes on saying it until the pile is carried. Never a modal.
import { useEffect, useState } from 'react';
import { completedBy, mustClear } from '../shared/engine';
import type { Intent, RoomView } from '../shared/types';
import { current, send as netSend } from './net';
import { home } from './sound';

/** How long a finished pile waits before it says what to do with it, if nothing else was tried first. */
export const TELL_MS = 4000;
/** Attempts closer together than this make one sound (a held Space bar, a double click). */
const QUIET_MS = 250;

const listeners = new Set<() => void>();
let sounded = 0;

/** The player tried something other than clearing their finished pile: tell whoever is showing the table. */
export function nag(): void {
  const now = Date.now();
  if (now - sounded > QUIET_MS) home();
  sounded = now;
  for (const l of listeners) l();
}

/**
 * The finished pile of their own that the player at this window has still to carry to the tray: its slot, or -1. The
 * one place the client asks. Only while the round is being played: not once it is scored, nor while it is paused.
 */
export function waitingPile(room: RoomView | null): number {
  const game = room?.game;
  if (!room || !game || room.phase !== 'playing' || room.paused || room.seat === null || !mustClear(game, room.seat)) return -1;
  return game.slots.findIndex((pile) => completedBy(pile) === room.seat);
}

/** `send` from net.ts, which refuses whatever the engine refuses; if the reason is clear-first, the player is told. (Asked of the room as it is now, not as it was last drawn.) */
export function send(intent: Intent): boolean {
  if (netSend(intent)) return true;
  if (intent.k !== 'clear' && waitingPile(current().room) >= 0) nag();
  return false;
}

export interface ClearFirst {
  /** A finished pile of yours is waiting: nothing else can be done. */
  blocked: boolean;
  /** The slot it is in, or -1. */
  slot: number;
  /** What the pile does: a nod as it is finished; then, with every try at something else, a shake (two names in turn, so that it plays again). */
  cls: string;
  /** The pile says what to do with it: something else was tried, or `TELL_MS` went by. Until it is carried. */
  told: boolean;
}

/**
 * What a waiting pile does and whether it speaks, after `tries` at something else and, if it has `waited` out
 * `TELL_MS`, that too. The one place that says when the words come.
 */
export const cue = (tries: number, waited: boolean): Pick<ClearFirst, 'cls' | 'told'> => ({ cls: tries === 0 ? ' nod' : tries % 2 ? ' nudge' : ' nudge2', told: tries > 0 || waited });

/** What the table needs to know about clear-first for the round on screen. */
export function useClearFirst(room: RoomView): ClearFirst {
  const slot = waitingPile(room);
  const waiting = slot >= 0;
  const [tries, setTries] = useState(0);
  const [waited, setWaited] = useState(false);
  useEffect(() => {
    setTries(0);
    setWaited(false);
    if (!waiting) return;
    const timer = setTimeout(() => setWaited(true), TELL_MS);
    const on = () => setTries((n) => n + 1);
    listeners.add(on);
    return () => {
      listeners.delete(on);
      clearTimeout(timer);
    };
  }, [waiting]);
  return { blocked: waiting, slot, ...(waiting ? cue(tries, waited) : { cls: '', told: false }) };
}
