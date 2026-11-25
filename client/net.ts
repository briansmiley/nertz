// Connection + prediction store.
//
// The server is the only authority. We keep its last snapshot (`server`) and
// the intents we have sent that it has not yet acknowledged (`pending`). What
// is rendered is `predict(server, pending)`: the pending intents replayed over
// the snapshot with the same reducer the server runs. An intent that no longer
// applies (someone beat us to a pile or a slot) is skipped, so the card simply
// animates back - there is no rollback code anywhere. Picking a card up and
// putting it back (`hold`, `release`) are intents like any other.
import { getPrefs, lookOf, watchPrefs } from './prefs';
import { useSyncExternalStore } from 'react';
import { applyIntent, grab, refused, yetToHear } from '../shared/engine';
import type { SocialServerMsg } from '../shared/chat';
import { CLOSE_OVER, CLOSE_UPDATE, isRoomCode, PING_MS, SET_UPS, SILENT_MS, type Backs, type ClientMsg, type ServerMsg, type SetUp } from '../shared/protocol';
import type { TableSettings } from '../shared/settings';
import type { AnyCard, BotLevel, GameState, Intent, PlayerState, RoomView } from '../shared/types';

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
  const seat = room.seat ?? -1;
  let game = room.game;
  for (const p of sync.pending) {
    const result = applyIntent(game, seat, p.intent);
    game = result.ok ? unconfirmed(game, result.state, seat, p.intent) : refused(game, seat, p.intent); // as the server will see it
  }
  return game === room.game ? room : { ...room, game };
}

/**
 * A move to the middle can lose a race the client has not heard about yet. So the card it uncovers (the next on the
 * nertz pile, or the face-down card on a work pile), though its face was sent ahead, is not turned up until the server
 * says the move landed: it lies face-up with its face unknown (drawn part way over, layout.ts `Showing`), never shown
 * and then hidden again. A move between your own piles cannot be refused by anyone else, and turns it up at once.
 */
function unconfirmed(before: GameState, after: GameState, seat: number, intent: Intent): GameState {
  if (intent.k !== 'move' || intent.to.k === 'work') return after;
  const from = grab(before, seat, intent.cardId)?.from;
  const me = after.players.find((p) => p.seat === seat)!;
  const unknown = (c: AnyCard): AnyCard => ({ id: c.id, owner: c.owner, hidden: true as const });
  const swap = (p: PlayerState): GameState => ({ ...after, players: after.players.map((q) => (q === me ? p : q)) });
  if (from?.k === 'nertz') {
    const top = me.nertz.at(-1);
    return top ? swap({ ...me, nertz: [...me.nertz.slice(0, -1), unknown(top)] }) : after;
  }
  if (from?.k !== 'work') return after;
  const was = before.players.find((p) => p.seat === seat)!.work[from.i]!;
  const pile = me.work[from.i]!;
  const top = pile.cards.at(-1);
  if (!top || pile.down === was.down) return after; // nothing was turned over
  return swap({ ...me, work: me.work.map((w, i) => (i === from.i ? { ...w, cards: [...w.cards.slice(0, -1), unknown(top)] } : w)) });
}

/** A Nertz call is on the table that this window has not yet said it heard (it has not sent `heard`, or not been answered). */
export const hearsCall = (room: RoomView | null): boolean => !!room?.game && room.seat !== null && yetToHear(room.game).includes(room.seat);

/** What a socket says first: sit down at the table we know, or ask the server to open one. */
export function hello(room: string | null, name: string, token: string): ClientMsg {
  return room ? { t: 'join', room, name, token } : { t: 'create', name, token };
}

// ---------------------------------------------------------------- store

/** `updating`: reconnecting, and the line went down because the server stopped to be put up anew (it said so: `CLOSE_UPDATE`). */
export type Status = 'idle' | 'connecting' | 'online' | 'reconnecting' | 'updating';

export interface NetState {
  status: Status;
  /** Predicted room, or null when not in one. */
  room: RoomView | null;
  error: string | null;
  /** Sitting back down at the table it was at, after a reload: until it is seated, or gives up (`resume`). */
  rejoining: boolean;
}

const TOKEN_KEY = 'nertz.token';
const SEAT_KEY = 'nertz.seat';

let state: NetState = { status: 'idle', room: null, error: null, rejoining: false };
const listeners = new Set<() => void>();
/**
 * This window's session: the table it is at, or on its way to, and as whom. `room` is null until the server has told
 * us the code of the table we asked it to open. It ends only in `stop`, whichever way the window leaves.
 */
let session: { room: string | null; name: string } | null = null;
let socket: WebSocket | null = null;
let sync: Sync = freshSync;
let attempts = 0;
let retry: ReturnType<typeof setTimeout> | undefined;
/** When this window's socket last heard anything from the server (or was opened): see `SILENT_MS`. */
let heard = 0;
let watch: ReturnType<typeof setInterval> | undefined;
/** How long a window that has just come back (online again, or to the front) gives the server to answer before it reconnects. */
const PROBE_MS = 3_000;
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

/** Somebody sniped somebody (the server says so, to everyone): told to the table (client/Table.tsx). Returns the way to stop listening. */
type SnipeMsg = Extract<ServerMsg, { t: 'snipe' }>;
const snipeListeners = new Set<(msg: SnipeMsg) => void>();
export const onSnipe = (fn: (msg: SnipeMsg) => void): (() => void) => {
  snipeListeners.add(fn);
  return () => void snipeListeners.delete(fn);
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
/** Tells the table my cards' faces and backs, if it has not been told just that already. A back by lot is drawn by the table, once: at its first deal after the lot was chosen. */
function tell(): void {
  const look = lookOf(getPrefs());
  const now = JSON.stringify(look);
  if (now !== toldDeck && post({ t: 'deck', look })) toldDeck = now;
}
watchPrefs(tell);

/** Sends one message if the socket is open. Game intents go through `send` instead. */
export function post(msg: ClientMsg): boolean {
  if (socket?.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(msg));
  return true;
}

/** The table named in the address, if any: the link someone was sent, or the table this window is at. */
export function roomInUrl(): string {
  const code = (new URLSearchParams(location.search).get('room') ?? '').trim().toUpperCase();
  return isRoomCode(code) ? code : '';
}

/**
 * Whether this window has the aids for trying things out: in development, and wherever the server says it has its own on
 * (`RoomView.testing`: locally and on previews). Start then asks for the set-up the address names; Shift+D and Shift+N work.
 */
export const testing = (room: RoomView | null): boolean => import.meta.env.DEV || !!room?.testing;

/** The set-up deal the address names (`?deal=aces`), which Start asks for where `testing` is on. */
function setUpInUrl(): SetUp | undefined {
  if (typeof location === 'undefined') return undefined;
  const name = new URLSearchParams(location.search).get('deal');
  return SET_UPS.find((s) => s === name);
}

/**
 * What survives a reload: from the window's first snapshot of a table until its session ends, sessionStorage says
 * where it sits and as whom, and the address names the table (a link to share). Written and cleared here alone.
 */
function keep(seat: { room: string; name: string } | null): void {
  try {
    if (seat) sessionStorage.setItem(SEAT_KEY, JSON.stringify(seat));
    else sessionStorage.removeItem(SEAT_KEY);
  } catch {
    // storage unavailable: a reload just lands at home
  }
  if (typeof history === 'undefined') return;
  const setUp = setUpInUrl(); // (kept in the address, so that it holds across a reload)
  const query = [seat && `room=${seat.room}`, setUp && `deal=${setUp}`].filter(Boolean).join('&');
  history.replaceState(null, '', query ? `/?${query}` : '/');
}

/** On page load: if this window was at the table in the address, it sits back down. */
export function resume(): void {
  let seat: { room?: unknown; name?: unknown } | null;
  try {
    seat = JSON.parse(sessionStorage.getItem(SEAT_KEY) ?? 'null') as typeof seat;
  } catch {
    return; // storage unavailable (or not ours): home
  }
  const room = roomInUrl();
  if (room && seat?.room === room && typeof seat.name === 'string') (join(room, seat.name), set({ rejoining: true }));
}

/** The one way out of a session: leaving, sent away, replaced, refused. */
function stop(error: string | null): void {
  clearTimeout(retry);
  clearInterval(watch);
  session = null;
  keep(null);
  const old = socket;
  socket = null;
  old?.close();
  sync = freshSync;
  timed(null);
  set({ status: 'idle', room: null, error, rejoining: false });
  void renew(); // (the table may be gone because the server was put up anew: then so is this page)
}

/**
 * A window left open over a deploy still runs the page it loaded, against a server that has moved on: it draws and
 * plays by the old one. Whenever this window is at no table (it has just left one, or come back to the front), it
 * asks for the page again, and if that names another script than the one running, loads it. At a table it does so
 * only once it is `back` there from an update the server stopped for: the reload sits back down (`resume`).
 */
async function renew(back = false): Promise<void> {
  const free = (): boolean => back || (!state.room && !session);
  if (typeof document === 'undefined' || !free()) return;
  const mine = document.querySelector<HTMLScriptElement>('script[src*="/assets/"]')?.getAttribute('src');
  if (!mine) return; // not a built page (development)
  try {
    const page = await (await fetch('/', { cache: 'no-store' })).text();
    const theirs = /src="([^"]*\/assets\/[^"]+\.js)"/.exec(page)?.[1];
    if (theirs && theirs !== mine && free()) location.reload();
  } catch {
    // offline: next time
  }
}
// Back in front: at a table, is the line still up (`probe`)? At none, is this still the page the server serves?
if (typeof document !== 'undefined') document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && (probe(), void renew()));

const social = (msg: SocialServerMsg): void => {
  for (const fn of socialListeners) fn(msg);
};

/** What each message from the server does, by its type: one that is in `ServerMsg` and not here does not compile. */
const receive: { [T in ServerMsg['t']]: (msg: Extract<ServerMsg, { t: T }>) => void } = {
  state: (msg) => {
    attempts = 0;
    const updated = state.status === 'updating';
    if (session && !state.room) {
      session.room = msg.room.code; // a reconnect rejoins this table instead of opening another
      keep({ room: session.room, name: session.name });
    }
    sync = onSnapshot(sync, msg);
    set({ status: 'online', room: predict(sync), error: null, rejoining: false });
    // Nertz has been called, and this window has it now: the table is told at once, for the round waits to hear it
    // (a card taken up before this went is in hand at the call; one after it, too late).
    if (hearsCall(state.room)) send({ k: 'heard' });
    if (updated) void renew(true);
  },
  error: (msg) => set({ error: msg.message }),
  snipe: (msg) => {
    for (const fn of snipeListeners) fn(msg);
  },
  drag: (msg) => {
    for (const fn of dragListeners) fn(msg);
  },
  chat: social,
  social,
  signal: social,
  outOfVoice: social,
  pong: (msg) => {
    if (msg.at !== undefined) heardBack(msg.at);
  },
};

function connect(): void {
  if (!session) return;
  const ws = new WebSocket(`${location.origin.replace(/^http/, 'ws')}/ws`);
  socket = ws;
  heard = Date.now();
  sync = freshSync; // seq, pending and rev all belong to the connection
  ws.onopen = () => {
    if (socket === ws && session) {
      post(hello(session.room, session.name, token()));
      toldDeck = null;
      tell(); // my cards' faces and backs, for everyone at the table
      if (getPrefs().ping) ping(); // (and the time to the server, at once rather than at the next look)
    }
  };
  ws.onmessage = (e) => {
    if (socket !== ws) return;
    heard = Date.now();
    let msg: ServerMsg;
    try {
      msg = JSON.parse(String(e.data)) as ServerMsg;
    } catch {
      return;
    }
    if (Object.hasOwn(receive, msg.t)) (receive[msg.t] as (msg: ServerMsg) => void)(msg);
  };
  ws.onclose = (e) => {
    if (socket !== ws) return;
    if (e.code === CLOSE_OVER) return stop(e.reason);
    dropped(e.code === CLOSE_UPDATE);
  };
}

/**
 * The line is down: the socket said it closed, or it has gone silent (`SILENT_MS`), which is all a window is told of a
 * line that died while it was off the network. Either way the socket is done with, and the window reconnects; its seat
 * is waiting for it. `update`: the server closed it to be put up anew, which the window says until it is back.
 */
function dropped(update = false): void {
  const old = socket;
  socket = null;
  if (old) {
    old.onopen = old.onmessage = old.onclose = null; // (a silent socket may say it closed much later, or never)
    old.close();
  }
  // Unacknowledged intents died with the connection: show the plain snapshot until we are back.
  sync = { ...sync, pending: [] };
  timed(null);
  const room = sync.server ?? state.room;
  set({ status: update || state.status === 'updating' ? 'updating' : 'reconnecting', room, error: room ? null : 'Cannot reach the game server. Still trying…' });
  clearTimeout(retry);
  retry = setTimeout(connect, Math.min(5000, 250 * 2 ** attempts++));
}

/**
 * Every `PING_MS` while there is a session: a line silent for `SILENT_MS` is dropped. Anything the server sends says the
 * line is up, so only one that has been quiet since the last look is asked to answer: during play it never is.
 */
function check(): void {
  if (!session || !socket) return; // (no socket: a reconnect is on its way)
  const quiet = Date.now() - heard;
  if (quiet > SILENT_MS) return dropped();
  if (quiet >= PING_MS || getPrefs().ping) ping();
}

/**
 * The window is back on the network, or back in front: its socket may have died meanwhile without a word. An open one
 * has `PROBE_MS` to answer a ping; with none, a reconnect waiting out its backoff goes now.
 */
function probe(): void {
  if (!session) return;
  if (!socket) {
    clearTimeout(retry);
    attempts = 0;
    return connect();
  }
  if (socket.readyState !== WebSocket.OPEN) return; // (still connecting: `check` sees to it)
  const ws = socket;
  const asked = Date.now();
  ping();
  setTimeout(() => socket === ws && heard < asked && dropped(), PROBE_MS);
}
if (typeof window !== 'undefined') window.addEventListener('online', probe);

function open(room: string | null, name: string): void {
  if (session) stop(null);
  session = { room, name };
  attempts = 0;
  set({ status: 'connecting', error: null });
  connect();
  watch = setInterval(check, PING_MS);
}

/** Opens a new table. The server picks its code; it arrives as `room.code` in the first snapshot. */
export const create = (name: string): void => open(null, name);

/** Sits down at an existing table. A code nobody opened is refused: the server closes with CLOSE_OVER and the reason. */
export const join = (room: string, name: string): void => open(room, name);

export function leave(): void {
  post({ t: 'leave' });
  stop(null);
}

export function start(): void {
  const setUp = testing(state.room) ? setUpInUrl() : undefined;
  post(setUp ? { t: 'start', deal: setUp } : { t: 'start' });
}

/** The dealer's Start, once the cards are dealt: "1, 2, 3, Nertz!". The server ignores it from anyone else, or at any other time. */
export const go = (): void => void post({ t: 'go' });

/** Once the cards are dealt: say you are ready for Start (or not after all). */
export const ready = (on: boolean): void => void post({ t: 'ready', on });

/** Ask for a seat (on), or give up your seat or your place in the queue and just watch (off): yourself, or as whoever deals the person `id`. */
export const sit = (on: boolean, id?: number): void => void post({ t: 'sit', on, ...(id === undefined ? {} : { id }) });

export const pause = (on: boolean): void => void post({ t: 'pause', on });

/** In the lobby: take another colour (a seat nobody has). */
export const pickSeat = (seat: number): void => void post({ t: 'seat', seat });
export const addBot = (level: BotLevel): void => void post({ t: 'addBot', level });
export const nameBot = (seat: number, name: string): void => void post({ t: 'botName', seat, name });
export const kick = (id: number): void => void post({ t: 'kick', id });
/** Whoever deals: the table is the person `id`'s from now on. */
export const passHost = (id: number): void => void post({ t: 'host', id });
export const removeBot = (seat: number): void => void post({ t: 'removeBot', seat });
/** Whoever deals, at any point of a round: the round dealt over, unscored, to everyone who is here now. */
export const redeal = (): void => void post({ t: 'redeal' });
/** Whoever deals, between rounds: everyone back to nothing, and the table back in its lobby. */
export const resetTable = (): void => void post({ t: 'reset' });
/** Whoever deals: the back a bot plays with. */
export const botBack = (seat: number, backs: Backs): void => void post({ t: 'botBack', seat, backs });

/** Host only, between rounds: one seat more or fewer. A step, not a number, so that taps quicker than the snapshots each count. */
export const setSeats = (step: 1 | -1): void => void post({ t: 'seats', step });

/** Host only, between rounds; the server ignores it otherwise. The change comes back in the next snapshot. */
export function setTableSettings(patch: Partial<TableSettings>): void {
  post({ t: 'settings', patch });
}

/**
 * Would `send` play this intent right now? Not if it is not legal in the state
 * we are looking at, or if this connection has not had its first snapshot yet
 * (just reconnected: what is on screen is the table as it was before the drop,
 * and there is nothing to predict over).
 */
export function playable(intent: Intent): boolean {
  const room = state.room;
  if (socket?.readyState !== WebSocket.OPEN || !sync.server || !room?.game || room.phase !== 'playing') return false;
  return room.seat !== null && applyIntent(room.game, room.seat, intent).ok;
}

/**
 * Plays an intent: applied locally at once, sent to the server, reconciled
 * when its ack comes back. Returns false (and sends nothing) if it is not
 * `playable`.
 */
export function send(intent: Intent): boolean {
  if (!playable(intent)) return false;
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

// ---------------------------------------------------------------- round trip

/**
 * The time the last ping took to the server and back, in ms; null when there is no line (or no answer yet). Every ping
 * carries this window's clock as it went (`at`), and the pong hands it back: a pong times its own ping, whichever that
 * was. Pings go every `PING_MS` while the time is shown (`Prefs.ping`), and otherwise only to a quiet line.
 */
let rtt: number | null = null;
const rttListeners = new Set<() => void>();

function timed(next: number | null): void {
  if (next === rtt) return;
  rtt = next;
  for (const l of rttListeners) l();
}

function ping(): void {
  post({ t: 'ping', at: performance.now() });
}

/** A pong came back with the `at` of its ping. */
function heardBack(at: number): void {
  const ms = performance.now() - at;
  if (ms >= 0) timed(ms);
}

// Turned on: a reading at once, not at the next look.
let pingShown = getPrefs().ping;
watchPrefs(() => {
  const now = getPrefs().ping;
  if (now && !pingShown) ping();
  pingShown = now;
});

const watchRtt = (l: () => void) => {
  rttListeners.add(l);
  return () => void rttListeners.delete(l);
};
/** The round trip as it is right now (what `useRtt` renders). */
export const rttNow = (): number | null => rtt;
export const useRtt = (): number | null => useSyncExternalStore(watchRtt, rttNow);
