// Chat and voice state for the table we are at: the chat lines, the host's two
// switches and who is in voice, fed by the server's chat messages (never by
// snapshots); and what is open under the chat bar. It is what drives voice.ts.
import { useSyncExternalStore } from 'react';
import type { ChatLine, SocialSettings, VoiceMember } from '../shared/chat';
import { hasSeat } from '../shared/protocol';
import { current, onSocial, post, subscribe as onNet } from './net';
import { hangUp, leaveVoice, onSignal, setIce, sync } from './voice';

/** What is open under the chat bar: the line to type in, the voice slip, the slip of those watching, or nothing. */
export type Open = 'chat' | 'voice' | 'watchers' | null;

export interface SocialState extends SocialSettings {
  lines: readonly ChatLine[];
  inVoice: readonly VoiceMember[];
  /** Lines from other people that arrived while the chat was not open. */
  unread: number;
  open: Open;
  /** The lines just said (not the history a newcomer is sent), each with when it came by this window's clock: shown over the table for a while. */
  passing: readonly { line: ChatLine; at: number }[];
}

/** How long a line just said stays over the table, and how many of them at most. */
export const PASSING_MS = 9000;
const PASSING_MOST = 5;

const fresh: SocialState = { lines: [], text: true, voice: true, watchText: true, watchVoice: true, inVoice: [], unread: 0, open: null, passing: [] };
let state = fresh;
const listeners = new Set<() => void>();

function set(next: Partial<SocialState>): void {
  state = { ...state, ...next };
  for (const l of listeners) l();
}

onSocial((msg) => {
  if (msg.t === 'chat') {
    const news = msg.history ? 0 : msg.lines.filter((l) => l.k === 'said' && l.by.who !== current().room?.me).length;
    const now = Date.now();
    const passing = msg.history ? [] : [...state.passing.filter((p) => now - p.at < PASSING_MS), ...msg.lines.map((line) => ({ line, at: now }))].slice(-PASSING_MOST);
    set({ lines: msg.history ? msg.lines : [...state.lines, ...msg.lines], unread: state.open === 'chat' ? 0 : state.unread + news, passing });
  } else if (msg.t === 'social') {
    setIce(msg.ice);
    set({ text: msg.text, voice: msg.voice, watchText: msg.watchText !== false, watchVoice: msg.watchVoice !== false, inVoice: msg.inVoice });
    // (Voice switched off for those watching, and we are one of them: out, like when it is switched off for all.)
    const me = current().room;
    const shut = msg.watchVoice === false && !!me && me.seat === null;
    if (msg.voice && !shut) sync(msg.inVoice);
    else outOfVoice(false); // the host switched voice off: the microphone is released at once
  } else {
    void onSignal(msg.from, msg.data);
  }
});

// The connection and the table come and go underneath us.
let wasOnline = false;
onNet(() => {
  const net = current();
  if (!net.room) {
    outOfVoice(false);
    if (state !== fresh) set(fresh);
  } else {
    if (wasOnline && net.status !== 'online') {
      hangUp(); // the others are told we went; `sync` rejoins once the new socket is seated
      set({ inVoice: [] });
    }
    // (The last of those watching sat down: their slip has nothing to show, and must not keep the chat's lines hidden.)
    if (state.open === 'watchers' && net.room.players.every(hasSeat)) set({ open: null });
  }
  wasOnline = net.status === 'online';
});

/** Out of voice (see `leaveVoice`), and its slip put away with it. */
export function outOfVoice(tell = true): void {
  if (state.open === 'voice') set({ open: null });
  leaveVoice(tell);
}

export const say = (text: string): boolean => post({ t: 'chat', text });
export const setSocial = (change: Partial<SocialSettings>): void => void post({ t: 'social', ...change });
export const setOpen = (open: Open): void => set({ open, unread: open === 'chat' ? 0 : state.unread });

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export const useSocial = (): SocialState => useSyncExternalStore(subscribe, () => state);
