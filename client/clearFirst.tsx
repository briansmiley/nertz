// Clear-first, on the client. The rule itself is the engine's (`mustClear`): a
// player who put a King on a centre pile may do nothing else until they have
// carried the pile to the tray. Here is only what the player is shown when they
// try anyway: nothing moves, the pile gives a nudge, the tray flashes, a short
// notice appears by the pile and there is a soft tap. Never a modal.
import { useEffect, useState } from 'react';
import { CLEAR_FIRST, completedBy, mustClear } from '../shared/engine';
import type { GameState, Intent } from '../shared/types';
import type { Rect } from './layout';
import { current, send as netSend } from './net';
import { home } from './sound';

/** How long the notice stays after the last attempt. */
const NOTICE_MS = 2200;
/** Attempts closer together than this make one sound (a held Space bar, a double click). */
const QUIET_MS = 250;
/** Half the notice's width, near enough: it is kept that far from either side of the window. */
const HALF = 150;

const listeners = new Set<() => void>();
let sounded = 0;

/** The player tried something other than clearing their finished pile: tell whoever is showing the table. */
export function nag(): void {
  const now = Date.now();
  if (now - sounded > QUIET_MS) home();
  sounded = now;
  for (const l of listeners) l();
}

/** Is the player we are rendering held up by a finished pile of their own right now? */
function blocked(): boolean {
  const room = current().room;
  return !!room?.game && room.phase === 'playing' && room.game.stage === 'play' && mustClear(room.game, room.you);
}

/** `send` from net.ts, which refuses whatever the engine refuses; if the reason is clear-first, the player is told. */
export function send(intent: Intent): boolean {
  if (netSend(intent)) return true;
  if (intent.k !== 'clear' && blocked()) nag();
  return false;
}

export interface ClearFirst {
  /** A finished pile of `you` is waiting: nothing else can be done. */
  blocked: boolean;
  /** The slot it is in, or -1. */
  slot: number;
  /** '' until the player tries something else; then a class that alternates with every attempt, so the nudge plays again. */
  cls: string;
  /** The notice is up. */
  shown: boolean;
}

/** What the table needs to know about clear-first for the round on screen. */
export function useClearFirst(game: GameState, you: number): ClearFirst {
  const slot = game.stage === 'play' && mustClear(game, you) ? game.slots.findIndex((pile) => completedBy(pile) === you) : -1;
  const waiting = slot >= 0;
  const [tries, setTries] = useState(0);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    setTries(0);
    setShown(false);
    if (!waiting) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const on = () => {
      setTries((n) => n + 1);
      setShown(true); // one notice, however often they try: its clock just starts again
      clearTimeout(timer);
      timer = setTimeout(() => setShown(false), NOTICE_MS);
    };
    listeners.add(on);
    return () => {
      listeners.delete(on);
      clearTimeout(timer);
    };
  }, [waiting]);
  return { blocked: waiting, slot, cls: !waiting || tries === 0 ? '' : tries % 2 ? ' nudge' : ' nudge2', shown: waiting && shown };
}

/** The notice, just above the waiting pile `rect` (below it when the pile is at the top of the window). */
export function ClearNotice({ must, rect }: { must: ClearFirst; rect: Rect | undefined }) {
  if (!must.shown || !rect) return null;
  const below = rect.y < 56;
  return (
    <p className={`clearfirst${below ? ' below' : ''}`} role="status" style={{ left: Math.max(HALF, Math.min(window.innerWidth - HALF, rect.x + rect.w / 2)), top: below ? rect.y + rect.h + 8 : rect.y - 8 }}>
      {CLEAR_FIRST}
    </p>
  );
}
