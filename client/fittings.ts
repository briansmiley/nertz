// What there is to place round the cards, as the table is now (layout.ts, `Fittings`): which buttons the chat has,
// whether the sound is off, the clock, the vote. The chat, the corner buttons and the table all ask here, so that
// the layout places exactly what is drawn.
import { useMemo } from 'react';
import type { RoomView } from '../shared/types';
import { ballot } from './actions';
import { corners, nameWidth, NO_FITTINGS, type ChatButton, type Corners, type Fittings, type Insets } from './layout';
import { usePrefs } from './prefs';
import { useSocial, type SocialState } from './social';
import { insets, useViewport } from './viewport';
import { useVoice } from './voice';

/** A button with a count on it: by how many digits the count has. */
const counted = (n: number): ChatButton => (n > 9 ? 'count2' : 'count');

/** The chat's buttons for someone at `room`, left to right, as Chat.tsx draws them. */
export function chatButtons(room: RoomView, social: Pick<SocialState, 'text' | 'voice' | 'watchText' | 'watchVoice' | 'inVoice'>, inVoice: boolean, muted = false): ChatButton[] {
  const watchers = room.players.filter((p) => p.seat === null).length;
  const watching = room.seat === null;
  const mayText = social.text && (!watching || social.watchText);
  const mayVoice = social.voice && (!watching || social.watchVoice);
  return [
    ...(mayText ? (['text'] as const) : []),
    ...(inVoice ? [counted(social.inVoice.length), 'mute' as const] : mayVoice ? [social.inVoice.length ? counted(social.inVoice.length) : ('icon' as const)] : []),
    ...(muted ? (['badge'] as const) : []),
    ...(watchers ? [counted(watchers)] : []),
  ];
}

export function fittingsOf(room: RoomView | null | undefined, social: Parameters<typeof chatButtons>[1], inVoice: boolean, muted = false): Fittings {
  if (!room) return NO_FITTINGS;
  const me = room.players.find((p) => p.id === room.me);
  // (Everyone at the table has a place round it, in the round or not: more than six, and the others stand in columns.)
  const table = room.game && room.phase !== 'lobby' ? new Set([...room.game.players.map((p) => p.seat), ...room.players.flatMap((p) => (p.seat === null ? [] : [p.seat]))]).size : 0;
  return {
    chat: chatButtons(room, social, inVoice, muted),
    clock: !!room.clock && room.phase !== 'lobby',
    seats: table,
    vote: !!ballot(room)?.pressing,
    name: me ? nameWidth(me.name, String(me.score)) : 0,
  };
}

/** The fittings of the table you are at (none: the first page). The same object for as long as nothing of it changes. */
export function useFittings(room: RoomView | null | undefined): Fittings {
  const social = useSocial();
  const voice = useVoice();
  const { muted } = usePrefs();
  const fit = fittingsOf(room, social, voice.status === 'on', muted);
  const key = JSON.stringify(fit);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => fit, [key]);
}

/** The window, and what the screen keeps of it at its edges (read again whenever the window changes: turning a phone moves its notch). */
export function useWindow(): { W: number; H: number; pad: Insets } {
  const [W, H] = useViewport();
  const pad = useMemo(() => insets(), [W, H]);
  return { W, H, pad };
}

/** Where the buttons in the corners stand in this window (layout.ts, `corners`). */
export function useCorners(room: RoomView | null | undefined): Corners {
  const { W, H, pad } = useWindow();
  const fit = useFittings(room);
  return useMemo(() => corners(W, H, pad, fit), [W, H, pad, fit]);
}
