// Connection + prediction store.
//
// The server is the only authority. We keep its last snapshot (`server`) and
// the intents we have sent that it has not yet acknowledged (`pending`). What
// is rendered is `predict(server, pending)`: the pending intents replayed over
// the snapshot with the same reducer the server runs. An intent that no longer
// applies (someone beat us to a pile or a slot) is skipped, so the card simply
// animates back - there is no rollback code anywhere. Picking a card up and
// putting it back (`hold`, `release`) are intents like any other.
import { choiceAt, getPrefs, watchPrefs } from './prefs';
import { useSyncExternalStore } from 'react';
import { applyIntent, refused } from '../shared/engine';
import type { SocialServerMsg } from '../shared/chat';
import type { Back, ClientMsg, ServerMsg } from '../shared/protocol';
import type { TableSettings } from '../shared/settings';
import type { BotLevel, Intent, RoomView } from '../shared/types';

// ---------------------------------------------------------------- pure reconciliation

export interface Pending {
  seq: number;
  intent: Intent;
}

/** Everything that belongs to ONE websocket connection. A new socket starts from `freshSync`. */
export interface Sync {
  /** Highest snapshot rev seen on this connection. */
  rev: number;
  server: RoomView | null;
  /** Sent, not yet acknowledged; ascending seq. */
  pending: readonly Pending[];
  /** Last seq handed out. */
  seq: number;
}

export const freshSync: Sync = { rev: -1, server: null, pending: [], seq: 0 };

/** A snapshot arrived: adopt it unless it is older than what we have, and drop the intents it answers. */
export function onSnapshot(sync: Sync, msg: { rev: number; ack: number; room: RoomView }): Sync {
  if (msg.rev < sync.rev) return sync;
  return { ...sync, rev: msg.rev, server: msg.room, pending: sync.pending.filter((p) => p.seq > msg.ack) };
}

/** We are about to send `intent`: give it the next seq and remember it until it is acknowledged. */
export function onSend(sync: Sync, intent: Intent): Sync {
  const seq = sync.seq + 1;
  return { ...sync, seq, pending: [...sync.pending, { seq, intent }] };
}

/** The room to render: pending intents replayed over the server snapshot, skipping any that no longer apply. */
export function predict(sync: Sync): RoomView | null {
  const room = sync.server;
  if (!room || room.phase !== 'playing' || !room.game) return room;
  let game = room.game;
  for (const p of sync.pending) {
    const result = applyIntent(game, room.seat ?? -1, p.intent);
    game = result.ok ? result.state : refused(game, room.seat ?? -1, p.intent); // as the server will see it
  }
  return game === room.game ? room : { ...room, game };
}

/** What a socket says first: sit down at the table we know, or ask the server to open one. */
export function hello(room: string | null, name: string, token: string): ClientMsg {
  return room ? { t: 'join', room, name, token } : { t: 'create', name, token };
}

// ---------------------------------------------------------------- store

export type Status = 'idle' | 'connecting' | 'online' | 'reconnecting';

export interface NetState {
  status: Status;
  /** Predicted room, or null when not in one. */
  room: RoomView | null;
  error: string | null;
}

/** Server close code: this seat was taken over by a newer connection with the same token. */
const CLOSE_REPLACED = 4000;
const TOKEN_KEY = 'nertz.token';

let state: NetState = { status: 'idle', room: null, error: null };
const listeners = new Set<() => void>();
/** `room` is null until the server has told us the code of the table we asked it to open. */
let session: { room: string | null; name: string } | null = null;
let socket: WebSocket | null = null;
let sync: Sync = freshSync;
let attempts = 0;
let retry: ReturnType<typeof setTimeout> | undefined;
let memoryToken: string | undefined;

function set(next: Partial<NetState>): void {
  state = { ...state, ...next };
  for (const l of listeners) l();
}

/**
 * Per-window identity. sessionStorage, not localStorage: two windows of one
 * browser are two players, while a reload keeps its seat.
 */
function token(): string {
  const make = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
  try {
    let t = sessionStorage.getItem(TOKEN_KEY);
    if (!t) sessionStorage.setItem(TOKEN_KEY, (t = make()));
    return t;
  } catch {
    return (memoryToken ??= make());
  }
}

/** You beat someone to a pile (the server says so, to you alone): told to the table (client/Table.tsx). Returns the way to stop listening. */
const sniperListeners = new Set<(of: number) => void>();
export const onSniper = (fn: (of: number) => void): (() => void) => {
  sniperListeners.add(fn);
  return () => void sniperListeners.delete(fn);
};

/** Chat and voice messages go to whoever asked for them (client/social.ts); this store only knows the game. */
const socialListeners = new Set<(msg: SocialServerMsg) => void>();
export const onSocial = (fn: (msg: SocialServerMsg) => void): void => void socialListeners.add(fn);

/** Reports of where another player's held card is go to the table (client/Table.tsx). Returns the way to stop listening. */
type DragMsg = Extract<ServerMsg, { t: 'drag' }>;
const dragListeners = new Set<(msg: DragMsg) => void>();
export function onDrag(fn: (msg: DragMsg) => void): () => void {
  dragListeners.add(fn);
  return () => void dragListeners.delete(fn);
}

// A change of deck in the settings is passed on to the table.
let toldDeck: string | null = null;
/** Tells the table my cards' faces and backs (the backs chosen for this table, if any were: `choiceAt`), if it has not been told just that already. A back by lot is drawn by the table, once: at its first deal after the lot was chosen. */
function tell(): void {
  const { deck, night, bare } = getPrefs();
  const { back, random } = choiceAt(state.room?.code ?? session?.room);
  const now = `${deck} ${back} ${night} ${bare} ${random}`;
  if (now !== toldDeck && post({ t: 'deck', deck, back, night, bare, lot: random })) toldDeck = now;
}
watchPrefs(tell);

/** Sends one message if the socket is open. Game intents go through `send` instead. */
export function post(msg: ClientMsg): boolean {
  if (socket?.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(msg));
  return true;
}

function stop(error: string | null): void {
  clearTimeout(retry);
  session = null;
  const old = socket;
  socket = null;
  old?.close();
  sync = freshSync;
  set({ status: 'idle', room: null, error });
  void renew(); // (the table may be gone because the server was put up anew: then so is this page)
}

/**
 * A window left open over a deploy still runs the page it loaded, against a server that has moved on: it draws and
 * plays by the old one. Whenever this window is at no table (it has just left one, or come back to the front), it
 * asks for the page again, and if that names another script than the one running, loads it.
 */
async function renew(): Promise<void> {
  if (typeof document === 'undefined' || state.room || session) return;
  const mine = document.querySelector<HTMLScriptElement>('script[src*="/assets/"]')?.getAttribute('src');
  if (!mine) return; // not a built page (development)
  try {
    const page = await (await fetch('/', { cache: 'no-store' })).text();
    const theirs = /src="([^"]*\/assets\/[^"]+\.js)"/.exec(page)?.[1];
    if (theirs && theirs !== mine && !state.room && !session) location.reload();
  } catch {
    // offline: next time
  }
}
if (typeof document !== 'undefined') document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && void renew());

function connect(): void {
  if (!session) return;
  const ws = new WebSocket(`${location.origin.replace(/^http/, 'ws')}/ws`);
  socket = ws;
  sync = freshSync; // seq, pending and rev all belong to the connection
  ws.onopen = () => {
    if (socket === ws && session) {
      post(hello(session.room, session.name, token()));
      toldDeck = null;
      tell(); // my cards' faces and backs, for everyone at the table
    }
  };
  ws.onmessage = (e) => {
    if (socket !== ws) return;
    let msg: ServerMsg;
    try {
      msg = JSON.parse(String(e.data)) as ServerMsg;
    } catch {
      return;
    }
    if (msg.t === 'state') {
      attempts = 0;
      if (session) session.room = msg.room.code; // a reconnect rejoins this table instead of opening another
      sync = onSnapshot(sync, msg);
      set({ status: 'online', room: predict(sync), error: null });
      tell(); // (a table just opened has its code only now, and a choice of backs made at a table goes by it)
    } else if (msg.t === 'error') {
      // Before the first snapshot an error means we were refused (no such table, table full); afterwards it is only a complaint.
      if (sync.server) set({ error: msg.message });
      else stop(msg.message);
    } else if (msg.t === 'removed') {
      stop('You were removed from the table by whoever deals.');
    } else if (msg.t === 'sniper') {
      for (const fn of sniperListeners) fn(msg.of);
    } else if (msg.t === 'drag') {
      for (const fn of dragListeners) fn(msg);
    } else {
      for (const fn of socialListeners) fn(msg);
    }
  };
  ws.onclose = (e) => {
    if (socket !== ws) return;
    socket = null;
    if (e.code === CLOSE_REPLACED) return stop('This seat was opened in another tab.');
    // Unacknowledged intents died with the connection: show the plain snapshot until we are back.
    sync = { ...sync, pending: [] };
    const room = sync.server ?? state.room;
    set({ status: 'reconnecting', room, error: room ? null : 'Cannot reach the game server. Still trying…' });
    retry = setTimeout(connect, Math.min(5000, 250 * 2 ** attempts++));
  };
}

function open(room: string | null, name: string): void {
  stop(null);
  session = { room, name };
  attempts = 0;
  set({ status: 'connecting' });
  connect();
}

/** Opens a new table. The server picks its code; it arrives as `room.code` in the first snapshot. */
export const create = (name: string): void => open(null, name);

/** Sits down at an existing table. A code nobody opened comes back as `error`. */
export const join = (room: string, name: string): void => open(room, name);

export function leave(): void {
  post({ t: 'leave' });
  stop(null);
}

export function start(): void {
  post({ t: 'start' });
}

/** The dealer's Start, once the cards are dealt: "1, 2, 3, Nertz!". The server ignores it from anyone else, or at any other time. */
export const go = (): void => void post({ t: 'go' });

/** Once the cards are dealt: say you are ready for Start (or not after all). */
export const ready = (on: boolean): void => void post({ t: 'ready', on });

/** Ask for a seat (on), or give up your seat or your place in the queue and just watch (off): yourself, or as whoever deals the person `id`. */
export const takeSeat = (on: boolean, id?: number): void => void post({ t: 'sit', on, ...(id === undefined ? {} : { id }) });

export const pause = (on: boolean): void => void post({ t: 'pause', on });

/** In the lobby: take another colour (a seat nobody has). */
export const sit = (seat: number): void => void post({ t: 'seat', seat });
export const addBot = (level: BotLevel): void => void post({ t: 'addBot', level });
export const nameBot = (seat: number, name: string): void => void post({ t: 'botName', seat, name });
export const kick = (id: number): void => void post({ t: 'kick', id });
/** Whoever deals: the table is the person `id`'s from now on. */
export const passHost = (id: number): void => void post({ t: 'host', id });
export const removeBot = (seat: number): void => void post({ t: 'removeBot', seat });
/** Whoever deals, between rounds: everyone back to nothing, and the table back in its lobby. */
export const redeal = (): void => void post({ t: 'redeal' });
export const resetTable = (): void => void post({ t: 'reset' });
/** Whoever deals: the back a bot plays with. */
export const botBack = (seat: number, to: { back?: Back; lot?: string | null }): void => void post({ t: 'botBack', seat, ...to });

/** Host only, between rounds; the server ignores it otherwise. The change comes back in the next snapshot. */
export function setTableSettings(patch: Partial<TableSettings>): void {
  post({ t: 'settings', patch });
}

/**
 * Plays an intent: applied locally at once, sent to the server, reconciled
 * when its ack comes back. Returns false (and sends nothing) if it is not
 * legal in the state we are looking at, or if this connection has not had its
 * first snapshot yet (just reconnected: what is on screen is the table as it
 * was before the drop, and there is nothing to predict over).
 */
export function send(intent: Intent): boolean {
  const room = state.room;
  if (socket?.readyState !== WebSocket.OPEN || !sync.server || !room?.game || room.phase !== 'playing') return false;
  if (room.seat === null || !applyIntent(room.game, room.seat, intent).ok) return false;
  sync = onSend(sync, intent);
  post({ t: 'intent', seq: sync.seq, intent });
  set({ room: predict(sync) });
  return true;
}

export const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** The store as it is right now (what `useNet` renders). */
export const current = (): NetState => state;

export const useNet = (): NetState => useSyncExternalStore(subscribe, current);
