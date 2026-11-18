// Chat and voice state for the table we are at: the chat lines, the host's four
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
  /** The notice that a round is over, kept out of `lines` and `passing` while the table here has yet to show how it ended (see `setUnrevealed`). */
  held: ChatLine | null;
}

/** How long a line just said stays over the table, and how many of them at most. */
export const PASSING_MS = 9000;
const PASSING_MOST = 5;

const fresh: SocialState = { lines: [], text: true, voice: true, watchText: true, watchVoice: true, inVoice: [], unread: 0, open: null, passing: [], held: null };
let state = fresh;
/** The round whose result the table in this window has yet to show; null with no table. */
let unrevealed: number | null = null;
const listeners = new Set<() => void>();

function set(next: Partial<SocialState>): void {
  state = { ...state, ...next };
  for (const l of listeners) l();
}

onSocial((msg) => {
  if (msg.t === 'chat') {
    // A round is told over the moment it is, which is before the table here has played out its end: it waits for that.
    const held = msg.history ? (msg.lines.find((l) => l.id === state.held?.id) ?? null) : (msg.lines.find((l) => l.k === 'over' && l.round === unrevealed) ?? state.held);
    const lines = msg.lines.filter((l) => l.id !== held?.id);
    const news = msg.history ? 0 : lines.filter((l) => l.k === 'said' && l.by.who !== current().room?.me).length;
    const now = Date.now();
    const passing = msg.history ? [] : [...state.passing.filter((p) => now - p.at < PASSING_MS), ...lines.map((line) => ({ line, at: now }))].slice(-PASSING_MOST);
    set({ lines: msg.history ? lines : [...state.lines, ...lines], unread: state.open === 'chat' ? 0 : state.unread + news, passing, held });
  } else if (msg.t === 'social') {
    setIce(msg.ice);
    set({ text: msg.text, voice: msg.voice, watchText: msg.watchText, watchVoice: msg.watchVoice, inVoice: msg.inVoice });
    sync(msg.inVoice);
  } else if (msg.t === 'outOfVoice') {
    outOfVoice(false); // the host's switches keep us out: the microphone is released at once
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

/**
 * The table here has shown the result of every round but `round` (`unrevealed` in stage.ts; null without a table). A
 * notice held back for another round is let through: in its place among the lines, and over the table from now.
 */
export function setUnrevealed(round: number | null): void {
  unrevealed = round;
  const { held } = state;
  if (!held || (held.k === 'over' && held.round === round)) return;
  const now = Date.now();
  set({
    held: null,
    lines: [...state.lines, held].sort((a, b) => a.id - b.id),
    passing: [...state.passing.filter((p) => now - p.at < PASSING_MS), { line: held, at: now }].slice(-PASSING_MOST),
  });
}

export const say = (text: string): boolean => post({ t: 'chat', text });
export const setSocial = (change: Partial<SocialSettings>): void => void post({ t: 'social', ...change });
export const setOpen = (open: Open): void => set({ open, unread: open === 'chat' ? 0 : state.unread });

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export const currentSocial = (): SocialState => state;
export const useSocial = (): SocialState => useSyncExternalStore(subscribe, currentSocial);
