// What the server's tests sit at a table with: a connection that records what it is sent, a room with n people in it,
// the walk from the deal to play, and a websocket client for the real server. For tests only: nothing outside a
// *.test.ts imports this.
import { randomUUID } from 'node:crypto';
import { expect, vi } from 'vitest';
import WebSocket from 'ws';
import type { ChatLine } from '../shared/chat';
import { DEAL_MS, parseClientMsg, START_MS, type ServerMsg } from '../shared/protocol';
import { seeded, wire } from '../shared/testkit';
import type { GameState, RoomView } from '../shared/types';
import { Room, type Conn, type RoomOptions } from './room';

export type Of<T extends ServerMsg['t']> = Extract<ServerMsg, { t: T }>;
export type StateMsg = Of<'state'>;
export type DragMsg = Of<'drag'>;

/** A connection that records everything it was sent, as it would arrive over the wire. */
export class FakeConn implements Conn {
  msgs: ServerMsg[] = [];
  states: StateMsg[] = [];
  drags: DragMsg[] = [];
  closed = false;
  send(msg: ServerMsg): void {
    const copy = wire(msg);
    this.msgs.push(copy);
    if (copy.t === 'state') this.states.push(copy);
    if (copy.t === 'drag') this.drags.push(copy);
  }
  close(): void {
    this.closed = true;
  }
  of<T extends ServerMsg['t']>(t: T): Of<T>[] {
    return this.msgs.filter((m): m is Of<T> => m.t === t);
  }
  /** The latest snapshot. */
  get last(): StateMsg {
    return this.states.at(-1)!;
  }
  /** The room as the latest snapshot shows it. */
  get room(): RoomView {
    return this.last.room;
  }
  /** Every chat line received, in order, history included. */
  get lines(): ChatLine[] {
    return this.of('chat').flatMap((m) => m.lines);
  }
  /** What was said among those lines (no notices from the table). */
  get said(): string[] {
    return this.lines.flatMap((l) => (l.k === 'said' ? [l.text] : []));
  }
  /** The latest switches and voice list. */
  get social(): Of<'social'> {
    return this.of('social').at(-1)!;
  }
}

/** A room that only flushes when the test says so, with `n` players joined and seated (P0, P1, ...; tokens tok-0000, tok-0001, ...). */
export function roomWith(n: number, { code = 'TEST', ...options }: RoomOptions & { code?: string } = {}): { room: Room; conns: FakeConn[] } {
  const room = new Room(code, { rng: seeded(1), schedule: () => {}, ...options });
  const conns = Array.from({ length: n }, (_, i) => {
    const conn = new FakeConn();
    expect(room.join(conn, `P${i}`, `tok-000${i}`, true)).toBeNull();
    return conn;
  });
  return { room, conns };
}

/** What a client sends, through the same validation as the real server. False if that refuses it. */
export function send(room: Room, conn: Conn, raw: unknown): boolean {
  const msg = parseClientMsg(JSON.stringify(raw));
  if (!msg || msg.t === 'join' || msg.t === 'create') return false;
  room.handle(conn, msg);
  return true;
}

/** Sits through the deal, presses the dealer's Start and sits through "1, 2, 3": play is open and the bots wake. (Fake timers.) */
export function opening(room: Room, dealer: Conn): void {
  vi.advanceTimersByTime(DEAL_MS);
  room.handle(dealer, { t: 'go' });
  vi.advanceTimersByTime(START_MS);
}

/** Starts a round and walks it to play: the deal, the dealer's Start, "1, 2, 3". Play is open, and no timer is left running. */
export function startRound(room: Room, dealer: Conn): void {
  const faked = vi.isFakeTimers();
  if (!faked) vi.useFakeTimers();
  room.handle(dealer, { t: 'start' });
  opening(room, dealer);
  if (!faked) vi.useRealTimers();
  expect(room.game!.status.at).toBe('play');
}

/**
 * Over the wire: `dealer` starts a round at `room` and it is walked to play, as `startRound` does, with only the room's
 * timers faked (the sockets keep real time). Every one of `players` has seen play open.
 */
export async function startOver(room: Room, dealer: Client, players: readonly Client[]): Promise<void> {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    dealer.send({ t: 'start' });
    await vi.waitFor(() => expect(room.phase).toBe('playing'));
    vi.advanceTimersByTime(DEAL_MS);
    dealer.send({ t: 'go' });
    await vi.waitFor(() => expect(room.game!.status.at).not.toBe('ready'));
    vi.advanceTimersByTime(START_MS);
    expect(room.game!.status.at).toBe('play');
    await vi.waitFor(() => players.forEach((p) => expect(p.game.status.at).toBe('play')));
  } finally {
    vi.useRealTimers();
  }
}

/** A websocket client of the real server that records everything it is sent. */
export class Client {
  states: StateMsg[] = [];
  drags: DragMsg[] = [];
  errors: string[] = [];
  raw: string[] = [];
  seq = 0;
  closeCode: number | null = null;
  private constructor(
    readonly ws: WebSocket,
    readonly token: string,
  ) {
    ws.on('message', (data) => {
      const text = data.toString();
      this.raw.push(text);
      const msg = JSON.parse(text) as ServerMsg;
      if (msg.t === 'state') this.states.push(msg);
      else if (msg.t === 'drag') this.drags.push(msg);
      else if (msg.t === 'error') this.errors.push(msg.message);
    });
    ws.on('close', (code) => (this.closeCode = code));
    ws.on('error', () => {});
  }
  /**
   * Connects and sits down: `room` null opens a new table (the server picks the code), otherwise joins that code.
   * With `expectSeat` false it only sends the join and waits for nothing.
   */
  static async open(port: number, room: string | null, name: string, token: string = randomUUID(), expectSeat = true): Promise<Client> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise((ok, fail) => ws.once('open', ok).once('error', fail));
    const client = new Client(ws, token);
    client.send(room === null ? { t: 'create', name, token } : { t: 'join', room, name, token });
    if (expectSeat) await vi.waitFor(() => expect(client.states.length).toBeGreaterThan(0));
    if (expectSeat && room !== null) await client.sit();
    return client;
  }
  send(msg: unknown): void {
    this.ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
  }
  /** Whoever comes to a table watches until they ask for a seat: asks, and waits until they have one or are in the queue for one. */
  async sit(): Promise<void> {
    this.send({ t: 'sit', on: true });
    await vi.waitFor(() => expect(this.last.room.seat !== null || !!this.last.room.players.find((p) => p.id === this.last.room.me)?.queued).toBe(true));
  }
  intent(intent: unknown): number {
    this.send({ t: 'intent', seq: this.seq, intent });
    return this.seq++;
  }
  /** Sends the intent and waits until the server has answered it. */
  async did(intent: unknown): Promise<StateMsg> {
    const seq = this.intent(intent);
    await vi.waitFor(() => expect(this.last.ack).toBeGreaterThanOrEqual(seq));
    return this.last;
  }
  drag(id: string, x = 0.1, y = 0.2): void {
    this.send({ t: 'drag', id, w: 0.5, h: [1, 1], p: [x, y] });
  }
  /** Everything the server has sent so far has arrived: an error is answered in order, after all that came before. */
  async synced(): Promise<void> {
    const n = this.errors.length;
    this.send('?');
    await vi.waitFor(() => expect(this.errors.length).toBeGreaterThan(n));
  }
  get last(): StateMsg {
    return this.states.at(-1)!;
  }
  get game(): GameState {
    return this.last.room.game!;
  }
  get seat(): number {
    return this.last.room.seat ?? -1;
  }
  get code(): string {
    return this.last.room.code;
  }
  /** Says goodbye and waits for the socket to close. */
  async close(): Promise<void> {
    await this.ended(() => this.ws.close());
  }
  /** Drops the socket without a word, as a lost connection does, and waits for it to close. */
  async drop(): Promise<void> {
    await this.ended(() => this.ws.terminate());
  }
  private async ended(how: () => void): Promise<void> {
    if (this.ws.readyState === WebSocket.CLOSED) return;
    const closed = new Promise((ok) => this.ws.once('close', ok));
    how();
    await closed;
  }
}
