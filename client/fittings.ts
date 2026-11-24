// What there is to place round the cards, as the table is now (layout.ts, `Fittings`): which buttons the chat has,
// whether the sound is off, the clock, the vote. The chat, the corner buttons and the table all ask here, so that
// the layout places exactly what is drawn.
import { useMemo } from 'react';
import type { PlayerView, RoomView } from '../shared/types';
import { ballot } from './actions';
import { corners, nameWidth, NO_FITTINGS, type ChatButton, type Corners, type Fittings } from './layout';
import { usePrefs } from './prefs';
import { useSocial, type SocialState } from './social';
import { useWindow } from './viewport';
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
  return {
    chat: chatButtons(room, social, inVoice, muted),
    clock: !!room.clock && room.phase !== 'lobby',
    vote: !!ballot(room)?.pressing,
    name: me ? lineWidth(room, me) : 0,
  };
}

/**
 * How wide your own line is written: your name and the total the table shows beside it (Table.tsx, `total`). At the
 * end of a round that is the total before the round's points, then after them: the line is as wide as the wider.
 */
function lineWidth(room: RoomView, me: PlayerView): number {
  const l = room.phase === 'results' ? room.lastRound?.scores.find((s) => s.seat === me.seat) : undefined;
  return l ? Math.max(nameWidth(l.name, String(l.total - l.delta)), nameWidth(l.name, String(l.total))) : nameWidth(me.name, String(me.score));
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

/** Where the buttons in the corners stand in this window (layout.ts, `corners`). */
export function useCorners(room: RoomView | null | undefined): Corners {
  const { W, H, pad } = useWindow();
  const fit = useFittings(room);
  return useMemo(() => corners(W, H, pad, fit), [W, H, pad, fit]);
}
