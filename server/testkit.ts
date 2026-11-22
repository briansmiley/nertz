// What the server's tests sit at a table with: a connection that records what it is sent, a room with n people in it,
// the walk from the deal to play, a websocket client for the real server, and (for signing in) Google played by a fake
// and a browser's part done by hand. For tests only: nothing outside a *.test.ts imports this.
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { expect, vi } from 'vitest';
import WebSocket from 'ws';
import type { ChatLine } from '../shared/chat';
import { yetToHear } from '../shared/engine';
import { DEAL_MS, parseClientMsg, START_MS, type ServerMsg } from '../shared/protocol';
import { seeded, wire } from '../shared/testkit';
import type { GameState, RoomView } from '../shared/types';
import { AUTH_PATH, type AccountsOptions } from './accounts';
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
  if (!msg || msg.t === 'join' || msg.t === 'create' || msg.t === 'ping') return false;
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
  /** The round whose Nertz call this window last said it heard. */
  private heardIn = -1;
  private constructor(
    readonly ws: WebSocket,
    readonly token: string,
  ) {
    ws.on('message', (data) => {
      const text = data.toString();
      this.raw.push(text);
      const msg = JSON.parse(text) as ServerMsg;
      if (msg.t === 'state') {
        this.states.push(msg);
        // A window says it has a Nertz call as soon as it does, as a browser's does (client/net.ts).
        const { game, seat, round } = msg.room;
        if (game && seat !== null && yetToHear(game).includes(seat) && this.heardIn !== round) {
          this.heardIn = round;
          this.intent({ k: 'heard' });
        }
      } else if (msg.t === 'drag') this.drags.push(msg);
      else if (msg.t === 'error') this.errors.push(msg.message);
    });
    ws.on('close', (code) => (this.closeCode = code));
    ws.on('error', () => {});
  }
  /**
   * Connects and sits down: `room` null opens a new table (the server picks the code), otherwise joins that code.
   * With `expectSeat` false it only sends the join and waits for nothing. With `cookie`, the socket opens as a browser
   * holding it would, from a page of ours (or of `origin`): signed in, if it is a session's (`Browser.cookie`).
   */
  static async open(port: number, room: string | null, name: string, token: string = randomUUID(), expectSeat = true, cookie?: string, origin = ACCOUNTS.url): Promise<Client> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, cookie ? { headers: { cookie, origin } } : {});
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
  /** Whoever comes to a table with no seat free or a round on watches until they ask for a seat: asks, and waits until they have one or are in the queue for one. */
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

// ---------------------------------------------------------------- signing in

/** Accounts as a test sets them up: the app reached at `url`, a Google client that `fakeGoogle` answers for, and a Resend key that `fakeResend` does. */
export const ACCOUNTS: AccountsOptions = {
  url: 'https://nertz.example',
  secret: 'a-secret-long-enough-for-better-auth-0123456789',
  google: { id: 'client-id', secret: 'client-secret' },
  email: { resend: 're_test', from: 'Nertz <nertz@mail.example>' },
};

/** Who Google says someone is. */
export interface Googler {
  sub: string;
  email: string;
  name: string;
  picture?: string;
}
export const ADA: Googler = { sub: 'google-123', email: 'ada@example.com', name: 'Ada Lovelace', picture: 'https://example.com/ada.png' };
export const BOB: Googler = { sub: 'google-456', email: 'bob@example.com', name: 'Bob Byte' };

/**
 * Google, played by a stub of the global `fetch` (undo it with `vi.unstubAllGlobals()`): the code it is handed back is
 * the `sub` of whoever "signed in" there (`Browser.signIn` sends it), and any other request goes where it was going.
 */
export function fakeGoogle(people: readonly Googler[] = [ADA, BOB]): void {
  const real = globalThis.fetch;
  // A JWT nobody signed: what Google's token endpoint answers with is read, not verified (it came over TLS from Google).
  const idToken = (claims: object): string => `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.x`;
  vi.stubGlobal('fetch', (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith('https://oauth2.googleapis.com/token')) return real(input, init);
    const who = people.find((p) => p.sub === new URLSearchParams(String(init?.body)).get('code'));
    if (!who) return Response.json({ error: 'invalid_grant' }, { status: 400 });
    const id_token = idToken({ iss: 'https://accounts.google.com', aud: ACCOUNTS.google!.id, email_verified: true, exp: Math.floor(Date.now() / 1000) + 3600, ...who });
    return Response.json({ access_token: 'at', id_token, token_type: 'Bearer', expires_in: 3600, scope: 'openid email profile' });
  }) as typeof fetch);
}

/** An email Resend was asked to send. */
export interface Sent {
  from: string;
  to: string[];
  subject: string;
  text: string;
}

/**
 * Resend, played by a stub of the global `fetch` over whatever it is now (undo it with `vi.unstubAllGlobals()`): each
 * email asked for lands in the list given back, and is taken, unless `refuse` says otherwise.
 */
export function fakeResend({ refuse = false } = {}): Sent[] {
  const sent: Sent[] = [];
  const before = globalThis.fetch;
  vi.stubGlobal('fetch', (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url !== 'https://api.resend.com/emails') return before(input, init);
    if (refuse) return Response.json({ message: 'no' }, { status: 422 });
    sent.push(JSON.parse(String(init?.body)) as Sent);
    return Response.json({ id: 'e1' });
  }) as typeof fetch);
  return sent;
}

/** The code in the last email sent to `to`. */
export const codeIn = (sent: readonly Sent[], to: string): string => /\b(\d{6})\b/.exec([...sent].reverse().find((m) => m.to.includes(to))?.subject ?? '')![1]!;

/** A browser's part, done by hand: cookies kept between requests, sent from the app's own pages, redirects not followed. */
export class Browser {
  private readonly kept = new Map<string, string>();
  constructor(private readonly port: number) {}
  /** The cookies it holds, as a request sends them. */
  get cookie(): string {
    return [...this.kept].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  /** GET `path`; or with `body`, POST it as JSON, or as it is for bytes (or `method` it, from `origin`). */
  async ask(path: string, body?: object, { method = body ? 'POST' : 'GET', origin = ACCOUNTS.url }: { method?: string; origin?: string } = {}): Promise<Response> {
    const res = await fetch(`http://localhost:${this.port}${path}`, {
      method,
      redirect: 'manual',
      headers: { cookie: this.cookie, origin, ...(body ? { 'content-type': body instanceof Uint8Array ? 'application/octet-stream' : 'application/json' } : {}) },
      ...(body ? { body: body instanceof Uint8Array ? new Uint8Array(body) : JSON.stringify(body) } : {}),
    });
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(';');
      const eq = pair!.indexOf('=');
      const [name, value] = [pair!.slice(0, eq), pair!.slice(eq + 1)];
      if (/max-age=0/i.test(line) || !value) this.kept.delete(name);
      else this.kept.set(name, value);
    }
    return res;
  }
  /** Off to Google and back as `who` (needs `fakeGoogle`). Gives where Google was sent to, and the answer on coming back. */
  async signIn(who: Googler = ADA, from = '/'): Promise<{ google: URL; back: Response }> {
    const { url } = (await (await this.ask(`${AUTH_PATH}/sign-in/social`, { provider: 'google', callbackURL: from, errorCallbackURL: from })).json()) as { url: string };
    const google = new URL(url);
    const back = await this.ask(`${AUTH_PATH}/callback/google?code=${who.sub}&state=${encodeURIComponent(google.searchParams.get('state')!)}`);
    return { google, back };
  }
}

/** The rows of a table of the database in `file`, read from beside whatever server has it open. */
export function rows(file: string, table: string): Record<string, unknown>[] {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare(`select * from ${table}`).all() as Record<string, unknown>[];
  } finally {
    db.close();
  }
}
