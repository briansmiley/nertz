// Chat and voice state for the table we are at: the chat lines, the host's two
// switches and who is in voice. Fed by the server's chat messages (never by
// snapshots), and it is what drives voice.ts.
import { useSyncExternalStore } from 'react';
import type { ChatLine, SocialSettings, VoiceMember } from '../shared/chat';
import { current, onSocial, post, subscribe as onNet } from './net';
import { hangUp, leaveVoice, onSignal, sync } from './voice';

export interface SocialState extends SocialSettings {
  lines: readonly ChatLine[];
  inVoice: readonly VoiceMember[];
  /** Lines from other people that arrived while the panel was closed. */
  unread: number;
  open: boolean;
}

const fresh: SocialState = { lines: [], text: true, voice: true, inVoice: [], unread: 0, open: false };
let state = fresh;
const listeners = new Set<() => void>();

function set(next: Partial<SocialState>): void {
  state = { ...state, ...next };
  for (const l of listeners) l();
}

onSocial((msg) => {
  if (msg.t === 'chat') {
    const news = msg.history ? 0 : msg.lines.filter((l) => l.seat !== current().room?.you).length;
    set({ lines: msg.history ? msg.lines : [...state.lines, ...msg.lines], unread: state.open ? 0 : state.unread + news });
  } else if (msg.t === 'social') {
    set({ text: msg.text, voice: msg.voice, inVoice: msg.inVoice });
    if (msg.voice) sync(msg.inVoice);
    else leaveVoice(false); // the host switched voice off: the microphone is released at once
  } else {
    void onSignal(msg.from, msg.data);
  }
});

// The connection and the table come and go underneath us.
let wasOnline = false;
onNet(() => {
  const net = current();
  if (!net.room) {
    leaveVoice(false);
    if (state !== fresh) set(fresh);
  } else if (wasOnline && net.status !== 'online') {
    hangUp(); // the others are told we went; `sync` rejoins once the new socket is seated
    set({ inVoice: [] });
  }
  wasOnline = net.status === 'online';
});

export const say = (text: string): boolean => post({ t: 'chat', text });
export const setSocial = (change: Partial<SocialSettings>): void => void post({ t: 'social', ...change });
export const setOpen = (open: boolean): void => set({ open, unread: 0 });

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export const useSocial = (): SocialState => useSyncExternalStore(subscribe, () => state);
