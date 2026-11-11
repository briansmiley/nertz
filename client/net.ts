// Connection + prediction store.
//
// The server is the only authority. We keep its last snapshot (`server`) and
// the intents we have sent that it has not yet acknowledged (`pending`). What
// is rendered is `predict(server, pending)`: the pending intents replayed over
// the snapshot with the same reducer the server runs. An intent that no longer
// applies (someone beat us to a foundation) is skipped, so the card simply
// animates back - there is no rollback code anywhere.
import { useSyncExternalStore } from 'react';
import { applyIntent } from '../shared/engine';
import type { ClientMsg, ServerMsg } from '../shared/protocol';
import type { Intent, RoomView } from '../shared/types';

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
    const result = applyIntent(game, room.you, p.intent);
    if (result.ok) game = result.state;
  }
  return game === room.game ? room : { ...room, game };
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
let session: { room: string; name: string } | null = null;
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

function post(msg: ClientMsg): boolean {
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
}

function connect(): void {
  if (!session) return;
  const { room, name } = session;
  const ws = new WebSocket(`${location.origin.replace(/^http/, 'ws')}/ws`);
  socket = ws;
  sync = freshSync; // seq, pending and rev all belong to the connection
  ws.onopen = () => {
    if (socket === ws) post({ t: 'join', room, name, token: token() });
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
      sync = onSnapshot(sync, msg);
      set({ status: 'online', room: predict(sync), error: null });
    } else if (msg.t === 'error') {
      // Before the first snapshot an error means the join was refused; afterwards it is only a complaint.
      if (sync.server) set({ error: msg.message });
      else stop(msg.message);
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

export function join(room: string, name: string): void {
  stop(null);
  session = { room, name };
  attempts = 0;
  set({ status: 'connecting' });
  connect();
}

export function leave(): void {
  post({ t: 'leave' });
  stop(null);
}

export function start(): void {
  post({ t: 'start' });
}

/**
 * Plays an intent: applied locally at once, sent to the server, reconciled
 * when its ack comes back. Returns false (and sends nothing) if it is not
 * legal in the state we are looking at.
 */
export function send(intent: Intent): boolean {
  const room = state.room;
  if (socket?.readyState !== WebSocket.OPEN || !room?.game || room.phase !== 'playing') return false;
  if (!applyIntent(room.game, room.you, intent).ok) return false;
  sync = onSend(sync, intent);
  post({ t: 'intent', seq: sync.seq, intent });
  set({ room: predict(sync) });
  return true;
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export const useNet = (): NetState => useSyncExternalStore(subscribe, () => state);
