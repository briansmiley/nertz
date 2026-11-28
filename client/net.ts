// Connection + prediction store.
//
// The server is the only authority. We keep its last snapshot (`server`) and
// the intents we have sent that it has not yet acknowledged (`pending`). What
// is rendered is `predict(server, pending)`: the pending intents replayed over
// the snapshot with the same reducer the server runs. An intent that no longer
// applies (someone beat us to a pile or a slot) is skipped, so the card simply
// animates back - there is no rollback code anywhere. Picking a card up and
// putting it back (`hold`, `release`) are intents like any other.
//
// A draw comes as one step, its group on the waste and the time it was made.
// What is on screen deals it out card by card on this window's own clock
// (`dealOut`, `dealtBy`): no snapshot sets the pace.
import { calm, getPrefs, lookOf, setPrefs, watchPrefs } from './prefs';
import { wire, type Line } from './line';
import { local, type Carried } from './local';
import { rebuild } from './rebuild';
import { MOTION } from './layout';
import { useSyncExternalStore } from 'react';
import { alone, applyIntent, covered, grab, isHidden, isLive, landsAt, refused, yetToHear } from '../shared/engine';
import type { SocialServerMsg } from '../shared/chat';
import { CLOSE_OVER, CLOSE_UPDATE, hasSeat, isRoomCode, PING_MS, SET_UPS, SILENT_MS, STOCK_CARD_MS, type Backs, type ClientMsg, type ServerMsg, type SetUp } from '../shared/protocol';
import type { AnyCard, BotLevel, GameState, Intent, PlayerState, RoomView } from '../shared/types';
import type { Kept } from '../server/room';

// ---------------------------------------------------------------- pure reconciliation

export interface Pending {
  seq: number;
  intent: Intent;
  /** What the round's clock read here when it was sent (`roundNow`): a draw is timed by it. */
  at: number;
}

/** Everything that belongs to ONE connection (a `Line`). A new one starts from `freshSync`. */
export interface Sync {
  /** Highest snapshot rev seen on this connection. */
  rev: number;
  server: RoomView | null;
  /** Sent, not yet acknowledged; ascending seq. */
  pending: readonly Pending[];
  /** Last seq handed out. */
  seq: number;
  /**
   * While the round's clock runs: how far ahead of this window's own (`performance.now`) it reads, going by the
   * snapshot of this round that got here quickest. So it is reckoned steadily whatever the network does to the
   * snapshots after, never runs backwards, and is never ahead of the server's. Null while it is stopped.
   */
  lead: number | null;
}

export const freshSync: Sync = { rev: -1, server: null, pending: [], seq: 0, lead: null };

/** A snapshot arrived (at `heardAt` by this window's clock): adopt it unless it is older than what we have, and drop the intents it answers. */
export function onSnapshot(sync: Sync, msg: { rev: number; ack: number; room: RoomView }, heardAt = performance.now()): Sync {
  if (msg.rev < sync.rev) return sync;
  const lead = msg.room.clock?.running ? msg.room.clock.ms - heardAt : null;
  const had = sync.server?.round === msg.room.round ? sync.lead : null;
  return { ...sync, rev: msg.rev, server: msg.room, pending: sync.pending.filter((p) => p.seq > msg.ack), lead: lead !== null && had !== null ? Math.max(lead, had) : lead };
}

/** What the round's clock reads (`RoomView.clock`) as this window reckons it, `at` by its own clock. */
export const roundNow = (sync: Sync, at = performance.now()): number => (sync.lead !== null ? at + sync.lead : (sync.server?.clock?.ms ?? 0));

/**
 * `intent` as it is sent from what is on screen, `room`: a take of the card under your own group in flight here (or
 * still gliding onto it) names that draw (`callsOff`), so the server calls it off though the group is down by its
 * clock by the time it gets there (this window has it down a round trip later, and the glide after).
 */
export function named(room: RoomView | null, intent: Intent): Intent {
  const me = room?.game?.players.find((p) => p.seat === room.seat);
  if ((intent.k !== 'hold' && intent.k !== 'move') || !me?.draw || covered(me)?.id !== intent.cardId) return intent;
  return { ...intent, callsOff: me.draw.at };
}

/** We are about to send `intent`: give it the next seq and remember it until it is acknowledged. */
export function onSend(sync: Sync, intent: Intent, at = roundNow(sync)): Sync {
  const seq = sync.seq + 1;
  return { ...sync, seq, pending: [...sync.pending, { seq, intent, at }] };
}

/** The room to render: pending intents replayed over the server snapshot, skipping any that no longer apply. */
export function predict(sync: Sync): RoomView | null {
  const room = sync.server;
  if (!room || room.phase !== 'playing' || !room.game) return room;
  const seat = room.seat ?? -1;
  let game = room.game;
  for (const p of sync.pending) {
    const result = applyIntent(game, seat, p.intent, p.at);
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

const unknown = (c: AnyCard): AnyCard => ({ id: c.id, owner: c.owner, hidden: true as const });

/**
 * A hand as it is drawn while its group is in flight (`PlayerState.draw`), `now` by the round's clock. The group came
 * in one step, and is dealt out here: its cards counted off the stock one at a time, STOCK_CARD_MS apart from `from`
 * (when the first left, here: `dealOut`), face-down. `draw.off` is how many are off so far, and the rest lie on the
 * stock yet. Its time come and its cards all off here a step (`downAt`), the group is down: the hand as it is, its
 * cards gliding onto the waste and turning up (`draw.down`, for as long as that takes: `glideMs`), while the card
 * they are covering can still be taken; then with no draw. Not before its faces are here, though: those of your own
 * draw come in the server's answer to it.
 */
export function dealtBy(p: PlayerState, now: number, from: number): PlayerState {
  if (!p.draw) return p;
  const group = p.waste.slice(-p.draw.n);
  const down = downAt(p.draw, from);
  if (now >= down && !group.some(isHidden)) return now >= down + glideMs() ? { ...p, draw: null } : { ...p, draw: { n: p.draw.n, at: p.draw.at, down: true } };
  const off = Math.min(p.draw.n, Math.max(1, Math.floor((now - from) / STOCK_CARD_MS) + 1));
  return { ...p, stock: [...p.stock, ...group.slice(off).reverse().map(unknown)], waste: [...p.waste.slice(0, -p.draw.n), ...group.slice(0, off).map(unknown)], draw: { ...p.draw, off } };
}

/** How long a group that is down takes here to glide onto the waste and turn up (client/Table.tsx: a card's move and its turn, together). */
export const glideMs = (): number => (calm() ? 0 : Math.max(MOTION.move, MOTION.flip) * 1000);

/** When a group whose cards began to leave the stock here at `from` is down here: at its own time (`landsAt`), and not before its last card has been off a step. */
const downAt = (draw: NonNullable<PlayerState['draw']>, from: number): number => Math.max(landsAt(draw), from + draw.n * STOCK_CARD_MS);

/**
 * How far this window has dealt out the groups in flight: what it needs to go on dealing them at its own pace,
 * whenever the snapshots come (`dealOut`). A new connection is no longer `looking`; leaving the table starts afresh.
 */
export interface Dealing {
  /**
   * By seat, the group this window is dealing out: its first card, and when its cards began to leave the stock here, by
   * the round's clock as it now reads. That is when this window first had the draw, however late its snapshot came (and
   * your own draw's cards do not start over when the server answers it); only a window that was not `looking` when the
   * draw was made (it has just sat back down) goes by the draw's own time, and finds the cards due by then already off.
   * It is put forward with the clock whenever a quicker snapshot puts that forward (`led`). So the cards leave a step
   * apart by this window's own clock, whatever the network does.
   */
  flights: ReadonlyMap<number, { card: string; at: number }>;
  /** `Sync.lead` when the room was last dealt out. */
  led: number | null;
  /** This connection has had the table on screen: a draw first seen from now on is seen as it is made. */
  looking: boolean;
  /** What the round's clock read when the groups in flight were last dealt on: they stay there once the round is not live (a group in flight at a call stays as it lies, until the round is over and it is back on the stock). */
  at: number | null;
}

export const freshDealing: Dealing = { flights: new Map(), led: null, looking: false, at: null };

/**
 * The room to put on screen `at` (this window's clock): the `predict`ed one, each group in flight dealt out as far as
 * the round's clock has it here (`dealtBy`). With it, the dealing as it now stands, and how long until it must be dealt
 * out again (its next card is due, or it lands), or null if nothing is due while the round's clock runs.
 */
export function dealOut(dealing: Dealing, sync: Sync, at = performance.now()): { dealing: Dealing; room: RoomView | null; wait: number | null } {
  const gained = sync.lead !== null && dealing.led !== null ? sync.lead - dealing.led : 0;
  const led = sync.lead;
  const room = predict(sync);
  const game = room?.game;
  if (!room || !game) return { dealing: { ...dealing, flights: new Map(), led, at: null }, room, wait: null };
  const live = isLive(game);
  const now = live || dealing.at === null ? roundNow(sync, at) : dealing.at;
  const flights = new Map(dealing.flights);
  let due = Infinity;
  const players = game.players.map((p) => {
    if (!p.draw) return flights.delete(p.seat), p;
    const card = p.waste[p.waste.length - p.draw.n]!.id;
    const had = flights.get(p.seat);
    const flight = had?.card !== card ? { card, at: dealing.looking ? now : p.draw.at } : live ? { card, at: had.at + gained } : had;
    flights.set(p.seat, flight);
    const seen = dealtBy(p, now, flight.at);
    const off = seen.draw?.off;
    if (off !== undefined) due = Math.min(due, off < p.draw.n ? flight.at + off * STOCK_CARD_MS : downAt(p.draw, flight.at));
    if (seen.draw?.down) due = Math.min(due, downAt(p.draw, flight.at) + glideMs());
    return seen;
  });
  const wait = live && sync.lead !== null && due > now && due < Infinity ? due - now : null;
  return {
    dealing: { flights, led, looking: sync.server !== null, at: now },
    room: players.every((p, i) => p === game.players[i]) ? room : { ...room, game: { ...game, players } },
    wait,
  };
}

/** A Nertz call is on the table that this window has not yet said it heard (it has not sent `heard`, or not been answered). */
export const hearsCall = (room: RoomView | null): boolean => !!room?.game && room.seat !== null && yetToHear(room.game).includes(room.seat);

/** What a socket says first: sit down at the table we know, or ask the server to open one. */
export function hello(room: string | null, name: string, token: string): ClientMsg {
  return room ? { t: 'join', room, name, token } : { t: 'create', name, token };
}

// ---------------------------------------------------------------- store

/**
 * `rejoining`: connecting, to sit back down at the table it was at, after a reload (`resume`), until it is seated or
 * gives up. `updating`: reconnecting, and the line went down because the server stopped to be put up anew (it said so:
 * `CLOSE_UPDATE`).
 */
export type Status = 'idle' | 'connecting' | 'rejoining' | 'online' | 'reconnecting' | 'updating';

export interface NetState {
  status: Status;
  /** Predicted room, or null when not in one. */
  room: RoomView | null;
  error: string | null;
  /**
   * This window plays offline: its tables are its own (client/local.ts), with bots and nobody else, and nothing is
   * asked of the game server. At no table it is what the settings say (`Prefs.offline`); at one, whether the table is
   * the window's own: opened so, or taken offline since (`carry`), until it is left. Never set: reckoned (`offline`)
   * each time the state is.
   */
  offline: boolean;
}

const TOKEN_KEY = 'nertz.token';
const SEAT_KEY = 'nertz.seat';

/**
 * This window's session: the table it is at, or on its way to, and as whom. `room` is null until the server has told
 * us the code of the table we asked it to open. It ends only in `end`: whichever way the window leaves (`stop`), or as another takes its place (`open`).
 * `local`: the table is this window's own, and so is its line: the settings said offline as the session began, or the
 * table was taken offline since (`carry`, the one place that happens). Never the other way: once local, until it ends.
 * `company`: the bots a table it asks the server to open is opened with (`playOnline`).
 */
let session: { room: string | null; name: string; local: boolean; company?: readonly Bot[] } | null = null;
/** A bot as it sits at one table, to be seated so at another. */
type Bot = Pick<Extract<ClientMsg, { t: 'addBot' }>, 'level' | 'name' | 'backs'>;
/** `NetState.offline` as it is now: the session's way, and with none the settings'. */
const offline = (): boolean => session?.local ?? getPrefs().offline;
let state: NetState = { status: 'idle', room: null, error: null, offline: offline() };
const listeners = new Set<() => void>();
let socket: Line | null = null;
let sync: Sync = freshSync;
/** The last snapshot of the session's table, whichever line brought it: what is left of the table when the line is lost (`takeOffline`). */
let last: RoomView | null = null;
let dealing: Dealing = freshDealing;
let step: ReturnType<typeof setTimeout> | undefined;
let attempts = 0;
let retry: ReturnType<typeof setTimeout> | undefined;
/** When this window's socket last heard anything from the server (or was opened): see `SILENT_MS`. */
let heard = 0;
let watch: ReturnType<typeof setInterval> | undefined;
/** How long a window that has just come back (online again, or to the front) gives the server to answer before it reconnects. */
const PROBE_MS = 3_000;
let memoryToken: string | undefined;

function set(next: Partial<Omit<NetState, 'offline'>> = {}): void {
  state = { ...state, ...next, offline: offline() };
  for (const l of listeners) l();
}

/**
 * Puts the room on screen as it is now, each group in flight dealt out as far as this window has it (`dealOut`). And
 * again when its next card is due, or it lands: the pace is this window's own, whenever the snapshots come.
 */
function show(next: Partial<Omit<NetState, 'offline'>> = {}): void {
  clearTimeout(step);
  const out = dealOut(dealing, sync);
  dealing = out.dealing;
  if (out.wait !== null) step = setTimeout(show, out.wait);
  set({ ...next, room: out.room });
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
// Offline or not is the settings' to say while this window is at no table (`NetState.offline`): where they say
// otherwise than the window has it, it goes by them. On its way to a table it has not got to (a server that cannot be
// reached, which is when offline is wanted; or one it was at before a reload) it gives that up for what they say.
// At a table, Offline switched on (in another window: here it is `playOffline`) takes the table along if it can be
// (`takeOffline`); otherwise it is what it is until it is left.
watchPrefs(() => {
  if (getPrefs().offline === state.offline) return;
  if (state.room) return void (getPrefs().offline && takeOffline());
  if (session) return stop(null);
  set();
  peek(); // (back online: the server may have been put up anew meanwhile)
});

/** Sends one message if the line is open. Game intents go through `send` instead. */
export function post(msg: ClientMsg): boolean {
  if (!socket?.open) return false;
  socket.send(JSON.stringify(msg));
  return true;
}

/** The table named in the address, if any: the link someone was sent, or the table this window is at. */
export function roomInUrl(): string {
  const code = (new URLSearchParams(location.search).get('room') ?? '').trim().toUpperCase();
  return isRoomCode(code) ? code : '';
}

/**
 * Whether this window has the aids for trying things out: wherever the server says it has its own on (`RoomView.testing`:
 * locally and on previews). Start then asks for the set-up the address names; Shift+D and Shift+N work.
 */
export const testing = (room: RoomView | null): boolean => !!room?.testing;

/** The set-up deal the address names (`?deal=aces`), which Start asks for where `testing` is on. */
function setUpInUrl(): SetUp | undefined {
  if (typeof location === 'undefined') return undefined;
  const name = new URLSearchParams(location.search).get('deal');
  return SET_UPS.find((s) => s === name);
}

/**
 * What survives a reload: from the window's first snapshot of a table until its session ends, sessionStorage says
 * where it sits and as whom, and the address names the table (a link to share). Written and cleared here alone. Only
 * `room` is the session's: anything else in the address (a set-up deal) stays as it was.
 * Not for a table of this window's own (`session.local`): it is gone with the page, and nobody else can come to it.
 */
function keep(seat: { room: string; name: string } | null): void {
  try {
    if (seat) sessionStorage.setItem(SEAT_KEY, JSON.stringify(seat));
    else sessionStorage.removeItem(SEAT_KEY);
  } catch {
    // storage unavailable: a reload just lands at home
  }
  if (typeof history === 'undefined') return;
  const query = new URLSearchParams(location.search);
  if (seat) query.set('room', seat.room);
  else query.delete('room');
  history.replaceState(null, '', query.size ? `/?${query}` : '/');
}

/** On page load: if this window was at the table in the address, it sits back down. */
export function resume(): void {
  let seat: { room?: unknown; name?: unknown } | null;
  try {
    seat = JSON.parse(sessionStorage.getItem(SEAT_KEY) ?? 'null') as typeof seat;
  } catch {
    return peek(); // storage unavailable (or not ours): home
  }
  const room = roomInUrl();
  if (room && seat?.room === room && typeof seat.name === 'string') open(room, seat.name, 'rejoining');
  else peek(); // (the boot this page was served by, to know a later one by)
}

/** The one way out of a session but another taking its place (`open`): leaving, sent away, refused. Home at once. */
function stop(error: string | null): void {
  end();
  show({ status: 'idle', error });
  renew(); // (the table may be gone because the server was put up anew: then so is this page)
}

/** The session is over, its line and all it had of the table with it. What is on screen is left to whoever ends it: `stop` goes home, `open` keeps it until its own table is there. */
function end(): void {
  clearTimeout(retry);
  clearInterval(watch);
  if (!session?.local) keep(null);
  session = null;
  const old = socket;
  socket = null;
  old?.close();
  sync = freshSync;
  last = null;
  dealing = freshDealing;
  timed(null);
}

/**
 * A window left open over a deploy still runs the page it loaded, against a server that has moved on: it draws and
 * plays by the old one. Every socket is first told which start of the server it reached (`welcome`: `boot`), and the
 * first this page hears is the one it belongs to. Another one since means the server was put up anew, so the page is
 * loaded again whenever this window is at no table. At a table it is only once it is `back` there from an update the
 * server stopped for: the reload sits back down (`resume`). The same one again was only the line dropping.
 */
let boot: string | null = null;
let stale = false;
function renew(back = false): void {
  if (stale && (back || (!state.room && !session))) location.reload();
}
function booted(id: string): void {
  boot ??= id;
  stale ||= id !== boot;
  renew();
}
/** A window at no table holds no socket: it opens one only to hear the server's boot, and closes it on the answer. (Offline it asks nothing.) */
function peek(): void {
  if (session || typeof document === 'undefined' || !reach().server) return;
  const ws = new WebSocket(`${location.origin.replace(/^http/, 'ws')}/ws`);
  ws.onmessage = (e) => {
    ws.close();
    try {
      const msg = JSON.parse(String(e.data)) as ServerMsg;
      if (msg.t === 'welcome') booted(msg.boot);
    } catch {
      // not the server's: next time
    }
  };
}
/**
 * Gone from in front (another tab, the screen off), the round at a table of this window's own is paused: there is
 * nobody else it is played on for, and the bots would play on. Asked as the window goes, and of every snapshot that
 * comes while it is gone: a round not yet live then (its cards being dealt, "1, 2, 3") is paused as soon as it is.
 */
function rest(): void {
  const room = state.room;
  if (!session?.local || typeof document === 'undefined' || document.visibilityState !== 'hidden') return;
  if (room?.game && isLive(room.game) && !room.paused) pause(true);
}
// Back in front: at a table, is the line still up (`probe`)? At none, is this still the server this page was served by?
if (typeof document !== 'undefined')
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') (probe(), peek());
    else rest();
  });

const social = (msg: SocialServerMsg): void => {
  for (const fn of socialListeners) fn(msg);
};

/** What each message from the server does, by its type: one that is in `ServerMsg` and not here does not compile. */
const receive: { [T in ServerMsg['t']]: (msg: Extract<ServerMsg, { t: T }>) => void } = {
  state: (msg) => {
    attempts = 0;
    const updated = state.status === 'updating';
    if (session && !last) {
      session.room = msg.room.code; // a reconnect rejoins this table instead of opening another
      if (!session.local) keep({ room: session.room, name: session.name });
    }
    sync = onSnapshot(sync, msg);
    last = sync.server;
    show({ status: 'online', error: null });
    // Nertz has been called, and this window has it now: the table is told at once, for the round waits to hear it
    // (a card taken up before this went is in hand at the call; one after it, too late).
    if (hearsCall(state.room)) send({ k: 'heard' });
    rest();
    if (updated) renew(true);
  },
  welcome: (msg) => booted(msg.boot),
  carried: (msg) => carry(msg.kept),
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

function connect(carried?: Carried): void {
  if (!session) return;
  const line: Line = (session.local ? local(carried) : wire)({
    open: () => {
      if (socket !== line || !session) return;
      post(hello(session.room, session.name, token()));
      if (!session.room) for (const bot of session.company ?? []) post({ t: 'addBot', ...bot });
      toldDeck = null;
      tell(); // my cards' faces and backs, for everyone at the table
      if (getPrefs().ping) ping(); // (and the time to the server, at once rather than at the next look)
    },
    message: (text) => {
      if (socket !== line) return;
      heard = Date.now();
      let msg: ServerMsg;
      try {
        msg = JSON.parse(text) as ServerMsg;
      } catch {
        return;
      }
      if (Object.hasOwn(receive, msg.t)) (receive[msg.t] as (msg: ServerMsg) => void)(msg);
    },
    close: (code, reason) => {
      if (socket !== line) return;
      if (code === CLOSE_OVER) return stop(reason);
      dropped(code === CLOSE_UPDATE);
    },
  });
  socket = line;
  heard = Date.now();
  sync = freshSync; // seq, pending and rev all belong to the connection
  dealing = { ...dealing, looking: false };
}

/**
 * The line is down: the socket said it closed, or it has gone silent (`SILENT_MS`), which is all a window is told of a
 * line that died while it was off the network. Either way the socket is done with, and the window reconnects; its seat
 * is waiting for it. `update`: the server closed it to be put up anew, which the window says until it is back.
 */
function dropped(update = false): void {
  const old = socket;
  socket = null;
  old?.close();
  // Unacknowledged intents died with the connection: show the plain snapshot until we are back, its groups in flight
  // as far as this window has dealt them (one that is down here stays down), and no further.
  sync = { ...sync, pending: [] };
  timed(null);
  const status = update || state.status === 'updating' ? 'updating' : 'reconnecting';
  // (Not yet at its table, a session is not at one it replaced either: that goes with the line.)
  if (sync.server || !last) show({ status, error: last ? null : 'Cannot reach the game server. Still trying…' });
  else set({ status, error: null });
  clearTimeout(step);
  clearTimeout(retry);
  retry = setTimeout(() => connect(), Math.min(5000, 250 * 2 ** attempts++));
}

/**
 * Play offline, wherever it is pressed (actions.ts, and each card that says the server cannot be reached). At a table:
 * the table goes offline with you, if it can (`takeOffline`). At none: the settings say Offline, which also gives up a
 * table the window was on its way to (the `watchPrefs` above).
 */
export function playOffline(): void {
  if (state.room) takeOffline();
  else setPrefs({ offline: true });
}

/** Can the table `room` be left for one like it on the server (`playOnline`)? One of this window's own, before its first deal: a game begun offline stays offline. */
export const returnable = (room: RoomView | null, r: Reach = reach()): boolean => !r.others && room?.phase === 'lobby';

/**
 * Play online. At no table: the settings say so. In the lobby of a table of this window's own (`returnable`): that
 * table is left, the settings say Online, and the server is asked for a new one under the same name, with the same
 * bots (how quick, what called, their backs). The one way from offline to online at a table; there is none once it
 * has dealt.
 */
export function playOnline(): void {
  const room = state.room;
  if (!room) return setPrefs({ offline: false });
  if (!session || !returnable(room)) return;
  const company = room.players.flatMap((p) => (p.bot && hasSeat(p) ? [{ level: p.bot, name: p.name, backs: p.look.backs }] : []));
  const { name } = session;
  setPrefs({ offline: false });
  open(null, name, 'connecting', false, company);
}

/** At no table, and the server cannot be reached for the one asked for (a new one, or one come to by its code). */
export const unreachable = (net: Pick<NetState, 'room' | 'status'>): boolean => !net.room && (net.status === 'reconnecting' || net.status === 'updating');

/** Can the table `room` be taken offline (`takeOffline`)? One others could come to (`Reach`), with nobody in the room but you and bots. */
export const portable = (room: RoomView | null, r: Reach = reach()): boolean => r.others && !!room && alone(room);

/**
 * Takes the table this window is at offline, to be played on in the window itself, if it can be (`portable`). While the
 * line is up the server is asked for it (`carry`), and hands it over exactly as it is (`carried`), or, someone having
 * come meanwhile, does not. With the line down (reconnecting, or the server stopped for an update) the table is put
 * back together from the last snapshot this window had (client/rebuild.ts): what it had sent and not heard back about
 * is not in it.
 */
export function takeOffline(): void {
  if (!session || session.local || !last || !alone(last)) return;
  if (state.status === 'online' && post({ t: 'carry' })) return;
  carry(rebuild(last, token()));
}

/**
 * The one place a session becomes the window's own: its table, as `kept`, is behind a line of this window's from here
 * on (client/local.ts), and it sits back down there as who it was. Nothing of it is for a reload any more, the settings
 * say Offline, and it never goes back: it is an offline table like one opened so, its rounds on nobody's record.
 */
function carry(kept: Kept): void {
  if (!session || session.local) return;
  const paused = last?.paused?.by === 'player';
  clearTimeout(retry);
  socket?.close();
  socket = null;
  timed(null);
  keep(null);
  session = { room: kept.code, name: session.name, local: true };
  set({ status: 'connecting', error: null }); // (not `online` out of `reconnecting`: the line is not back, the table is here)
  setPrefs({ offline: true });
  connect({ kept, paused });
}

/**
 * Every `PING_MS` while there is a session: a line silent for `SILENT_MS` is dropped. Anything the server sends says the
 * line is up, so only one that has been quiet since the last look is asked to answer: during play it never is.
 */
function check(): void {
  if (!session || !socket) return; // (no socket: a reconnect is on its way)
  if (session.local) return; // (a table of this window's own has no line to die: quiet for however long, a window frozen in the background, it is there)
  const quiet = Date.now() - heard;
  if (quiet > SILENT_MS) return dropped();
  if (quiet >= PING_MS || getPrefs().ping) ping();
}

/**
 * The window is back on the network, or back in front: its socket may have died meanwhile without a word. An open one
 * has `PROBE_MS` to answer a ping; with none, a reconnect waiting out its backoff goes now.
 */
function probe(): void {
  if (!session || session.local) return;
  if (!socket) {
    clearTimeout(retry);
    attempts = 0;
    return connect();
  }
  if (!socket.open) return; // (still connecting: `check` sees to it)
  const ws = socket;
  const asked = Date.now();
  ping();
  setTimeout(() => socket === ws && heard < asked && dropped(), PROBE_MS);
}
if (typeof window !== 'undefined') window.addEventListener('online', () => (relink(), probe(), peek()));

/**
 * `local`: at a table of this window's own. Only a table it opens can be: one that is there already (come to by its code,
 * or sat back down at after a reload) is the server's. A session it replaces at a table (`playOnline`) leaves that table on
 * screen as it was until the new one's first snapshot takes its place, or the line is lost on the way (`dropped`): never
 * the home page in between.
 */
function open(room: string | null, name: string, status: 'connecting' | 'rejoining' = 'connecting', local = false, company?: readonly Bot[]): void {
  if (session) end();
  session = { room, name, local, ...(company && { company }) };
  attempts = 0;
  if (!state.room) set({ status, error: null });
  connect();
  watch = setInterval(check, PING_MS);
}

/** Opens a new table. The server picks its code; it arrives as `room.code` in the first snapshot. */
/** Offline (the settings say), the table is this window's own, and is there at once. */
export const create = (name: string): void => open(null, name, 'connecting', getPrefs().offline);

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

/** Whoever deals, at any time: the table off the home page's list (on), or back on it (off). */
export const setUnlisted = (on: boolean): void => void post({ t: 'unlisted', on });

/**
 * Would `send` play this intent right now? Not if it is not legal in the state
 * we are looking at, or if this connection has not had its first snapshot yet
 * (just reconnected: what is on screen is the table as it was before the drop,
 * and there is nothing to predict over).
 */
export function playable(intent: Intent): boolean {
  const room = state.room;
  if (!socket?.open || !sync.server || !room?.game || room.phase !== 'playing') return false;
  return room.seat !== null && applyIntent(room.game, room.seat, intent).ok;
}

/**
 * Plays an intent: applied locally at once, sent to the server, reconciled
 * when its ack comes back. Returns false (and sends nothing) if it is not
 * `playable`.
 */
export function send(taken: Intent): boolean {
  const intent = named(state.room, taken);
  if (!playable(intent)) return false;
  sync = onSend(sync, intent);
  post({ t: 'intent', seq: sync.seq, intent });
  show();
  return true;
}

export const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** The store as it is right now (what `useNet` renders). */
export const current = (): NetState => state;

export const useNet = (): NetState => useSyncExternalStore(subscribe, current);
/**
 * What this window can reach, which is what there is to show for it. The two things offline is the lack of:
 * `others`: anyone else can come to its table (so the table has a code and a link, can be come to by one, is listed or
 * private, has seats to count and to stand up from, chat, voice, a host, and a line whose time is worth showing);
 * `server`: the game server can be asked (who is signed in, their page and record, feedback, whether the page is new).
 * Derived from the store's state and nothing else: whoever shows or asks something goes by this, never by the setting.
 */
export interface Reach {
  others: boolean;
  server: boolean;
}
const ONLINE: Reach = { others: true, server: true };
const OFFLINE: Reach = { others: false, server: false };
export const reachOf = (net: Pick<NetState, 'offline'>): Reach => (net.offline ? OFFLINE : ONLINE);
export const reach = (): Reach => reachOf(state);
export const useReach = (): Reach => reachOf(useNet());

// ---------------------------------------------------------------- the network

/**
 * Could this window come to the game server, were it to ask? Not without a network, which the browser says
 * (`navigator.onLine`, kept in step by its `online` and `offline` events; no browser, or one that does not say, has
 * one). That is all a window playing offline knows of it: it asks nothing of the server. The one rule it makes: Play
 * online (actions.ts) is not open without. A window that plays online is not asked this: its line says (`Status`), and
 * what it is offered is Play offline, which is always open.
 */
const network = (): boolean => typeof navigator === 'undefined' || navigator.onLine !== false;
let linked = network();
const linkListeners = new Set<() => void>();
function relink(): void {
  const now = network();
  if (now === linked) return;
  linked = now;
  for (const l of linkListeners) l();
}
if (typeof window !== 'undefined') window.addEventListener('offline', relink); // (and `online`, with what else it does: above)
export const connected = (): boolean => linked;
export const useConnected = (): boolean =>
  useSyncExternalStore(
    (l) => (linkListeners.add(l), () => linkListeners.delete(l)),
    connected,
  );

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
