// The whole backend: one Node process, every room in memory. HTTP serves the
// built client (when dist/ exists), /healthz, the home page's list of /tables, signing in (/api/auth: server/accounts.ts), one's own profile and who one follows (/profile: server/profile.ts), records (/stats: server/stats.ts), and for an admin how much the game is played (/usage, the same);
// websockets on /ws carry the game. What outlives the process is in one database (server/db.ts), if there is one: the game runs without.
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import WebSocket, { WebSocketServer } from 'ws';
import { CLOSE_OVER, HEAR_MS, MAX_MESSAGE_BYTES, parseClientMsg, randomRoomCode, STOCK_CARD_MS, type ServerMsg } from '../shared/protocol';
import type { OpenTables } from '../shared/types';
import type { Account } from '../shared/types';
import { accountsFromEnv, AUTH_PATH, openAccounts, type AccountsOptions } from './accounts';
import { FOLLOWING_PATH, PICTURE_PATH, PROFILE_PATH, profileHandler } from './profile';
import { openPictures, PICTURES_PATH } from './pictures';
import { dataFromEnv, openDb } from './db';
import { openReports } from './reports';
import { openRounds } from './rounds';
import { STATS_PATH, statsHandler, USAGE_PATH, usageHandler } from './stats';
import { feedbackHandler, type FeedbackOptions } from './feedback';
import { guard } from './guard';
import { Room, type Conn, type RoomOptions } from './room';

const ROOM_TTL_MS = 10 * 60_000; // a room with no connections lives this long
const LOBBY_TTL_MS = 60_000; // ...unless it never dealt a round: an abandoned lobby holds nothing worth keeping
const SWEEP_MS = 60_000;
const HEARTBEAT_MS = 30_000;
const MAX_ROOMS = 2000;
const MAX_LISTED = 20; // tables on the home page's list: those where something happened last
const MAX_BUFFERED_BYTES = 1 << 20; // a client this far behind on snapshots is dropped
const FLIP_SLACK_MS = 100; // two cards sent STOCK_CARD_MS apart may arrive a little closer together than that
const RATE_PER_SECOND = 60; // sustained messages per connection; far above what a hand can do
// The burst has to hold a whole table joining voice at once: to each of five others an offer and a
// dozen or two candidates, on top of the reports of a card being carried. (At 3 seconds of 40 a table of six could
// run a connection out of allowance in the middle of setting voice up: it was closed, and a pair was left deaf.)
const RATE_BURST_SECONDS = 10;
/** The most a request about signing in may carry. */
const MAX_AUTH_BODY_BYTES = 16 << 10;
/** Close code (policy violation) for a connection that floods the server. */
export const CLOSE_FLOOD = 1008;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
};

export interface NertzServer {
  port: number;
  /** Whether rounds are kept: a database was asked for, and opened. */
  kept: boolean;
  /** Whether anyone can sign in: accounts were asked for, and opened. */
  accounts: boolean;
  rooms: Map<string, Room>;
  /** Deletes rooms that have had no connections for their TTL (shorter for a table that never dealt). Runs on a timer; exposed for tests. */
  sweep(now?: number): void;
  close(): Promise<void>;
}

export interface ServerOptions {
  /** 0 picks a free port. */
  port?: number;
  /** Directory holding the built client. */
  dist?: string;
  /** Messages per second one connection may sustain before it is closed. */
  rate?: number;
  /** Least time between two cards one person deals off their stock (ms). Defaults to a little under the client's pace. */
  flipMs?: number;
  /** The longest a Nertz call waits to reach the others' windows (see `RoomOptions.hearMs`). Defaults to HEAR_MS. */
  hearMs?: number;
  /** How every table deals a round (see `RoomOptions.deal`): the engine's, unless a test rigs the hands. */
  deal?: RoomOptions['deal'];
  /** Where bug reports are passed on to (server/feedback.ts): defaults to what the environment says. They are kept in the database, if there is one. */
  feedback?: FeedbackOptions;
  /** The database's file (server/db.ts), or ':memory:': what outlives the process is kept there. Without one, nothing is kept. */
  data?: string | null;
  /** How people sign in (server/accounts.ts). Without it, or without a database, nobody can. */
  accounts?: AccountsOptions | null;
}

export async function startServer(options: ServerOptions = {}): Promise<NertzServer> {
  const dist = resolve(options.dist ?? fileURLToPath(new URL('../dist', import.meta.url)));
  const rate = options.rate ?? RATE_PER_SECOND;
  const flipMs = options.flipMs ?? STOCK_CARD_MS - FLIP_SLACK_MS;
  const hearMs = options.hearMs ?? HEAR_MS;
  const rooms = new Map<string, Room>();
  const idleSince = new Map<Room, number>();
  const forget = (room: Room): void => {
    if (rooms.get(room.code) === room) rooms.delete(room.code);
    idleSince.delete(room);
    room.close(); // its deal or grace timer must not outlive it
  };

  /** Call when a connection has gone from `room`: forget it at once if nobody is seated, else start its idle clock. */
  const released = (room: Room): void => {
    if (room.connected > 0) return;
    if (room.empty) {
      forget(room);
    } else if (!idleSince.has(room)) {
      idleSince.set(room, Date.now());
    }
  };

  /** A table code nobody holds. Only the server hands out codes, so two tables can never share one. */
  const freshCode = (): string => {
    for (;;) {
      const code = randomRoomCode();
      if (!rooms.has(code)) return code;
    }
  };

  const sweep = (now = Date.now()): void => {
    for (const [room, since] of idleSince) {
      if (now - since < (room.phase === 'lobby' ? LOBBY_TTL_MS : ROOM_TTL_MS)) continue;
      forget(room);
    }
  };

  // ---------------------------------------------------------------- http

  // The game needs none of what is kept: whatever goes wrong opening it (a volume that cannot be written, a file that
  // is no database) is said in the log, and the game runs without.
  const db = await attempt('nothing is kept: the database could not be opened', () => (options.data ? openDb(options.data) : null));
  const accounts = await attempt('accounts are off: they could not be opened', () => (db && options.accounts ? openAccounts(db, options.accounts) : null));
  const rounds = db && openRounds(db);
  /** Where a page of ours is served from: only a socket opened from there is signed in as anyone (a page of some other site's, in a browser of someone signed in here, opens one as a guest). */
  const home = options.accounts?.url;
  /** Screenshots sent with reports are files here, beside the database (nowhere, for a database in memory). */
  const reportDir = options.data && options.data !== ':memory:' ? join(dirname(options.data), 'reports') : null;
  const reports = db && openReports(db, { dir: reportDir });
  /** Pictures people put up of themselves, likewise (server/pictures.ts). */
  const pictures = reportDir ? openPictures(join(dirname(reportDir), 'pictures')) : null;
  const feedback = feedbackHandler(options.feedback, { reports, who: accounts?.who });
  const stats = accounts && rounds && statsHandler({ accounts, rounds });
  const usage = accounts && rounds && usageHandler({ accounts, rounds });
  /** Who each open socket is signed in as: what its cookie said as it opened, for as long as it is open and the account is there. */
  const signed = new Map<WebSocket, Account>();
  /** An account is gone: its sockets are nobody's from now on, and so is whoever sits at a table as it. */
  const gone = (account: string): void => {
    for (const [ws, as] of signed) if (as.id === account) signed.delete(ws);
    rooms.forEach((room) => room.forgetAccount(account));
  };
  /** An account has changed (its page made private, its picture): its sockets are it as it now is, and so is whoever sits at a table as it. */
  const changed = (account: Account): void => {
    for (const [ws, as] of signed) if (as.id === account.id) signed.set(ws, account);
    rooms.forEach((room) => room.reaccount(account));
  };
  const profile = db && accounts && home ? profileHandler({ db, accounts, rounds, reports, pictures, home, gone, changed }) : null;
  /** What every table is told to do with a round that has ended. */
  const record: RoomOptions['record'] = rounds ? (round) => guard('keeping a round', () => rounds.keep(round)) : undefined;
  const http = createServer((req, res) => {
    try {
      const path = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
      if (path === '/healthz') {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        // `games`: tables someone is at that have dealt (in a round or between rounds). A deploy to main waits for none.
        const games = [...rooms.values()].filter((room) => room.connected > 0 && room.phase !== 'lobby').length;
        res.end(JSON.stringify({ ok: true, rooms: rooms.size, connections: wss.clients.size, games }));
      } else if (path === '/tables') {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8', allow: 'GET, HEAD' });
          return void res.end('Method not allowed');
        }
        // Only tables someone is at just now: one left behind is kept for a while for whoever was there, not for anyone else.
        const open = [...rooms.values()].filter((room) => room.connected > 0);
        const body: OpenTables = {
          open: open.length,
          tables: open
            .sort((a, b) => b.changedAt - a.changedAt)
            .slice(0, MAX_LISTED)
            .map((room) => room.summary()),
        };
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(req.method === 'HEAD' ? undefined : JSON.stringify(body));
      } else if (path === STATS_PATH || path.startsWith(`${STATS_PATH}/`)) {
        if (!stats) return void res.writeHead(404, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end('null');
        stats(req, res).catch((err: unknown) => {
          console.error('stats', err); // (the database gone wrong, or closed under us: an answer, not a crash)
          if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
          res.end('null');
        });
      } else if (path === USAGE_PATH) {
        if (!usage) return void res.writeHead(404, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end('null');
        usage(req, res).catch((err: unknown) => {
          console.error('usage', err);
          if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
          res.end('null');
        });
      } else if (path.startsWith(`${PICTURES_PATH}/`)) {
        if (!pictures) return void res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not found');
        pictures.serve(path, req, res);
      } else if (path === PROFILE_PATH || path === PICTURE_PATH || path === FOLLOWING_PATH || path.startsWith(`${FOLLOWING_PATH}/`)) {
        if (!profile) return void res.writeHead(404, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end('null');
        profile(req, res, path).catch((err: unknown) => {
          console.error('profile', err);
          if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
          res.end('null');
        });
      } else if (path === '/feedback') {
        feedback(req, res).catch(() => {
          if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
          res.end('{"ok":false}');
        });
      } else if (path.startsWith(`${AUTH_PATH}/`)) {
        // With no accounts set up there is nothing here: the client takes the 404 to mean nobody can sign in.
        if (!accounts) return void res.writeHead(404, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end('null');
        // What is said here is a few hundred bytes. Better Auth would read a body of any size: one too big, or of no stated size, is not read at all.
        const stated = req.headers['content-length'];
        const body = req.method !== 'GET' && req.method !== 'HEAD';
        if (body && (stated === undefined ? req.headers['transfer-encoding'] !== undefined : !(Number(stated) <= MAX_AUTH_BODY_BYTES))) {
          return void res.writeHead(413, { 'content-type': 'application/json', connection: 'close' }).end('null');
        }
        accounts.handle(req, res).catch(() => {
          if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
          res.end('null');
        });
      } else {
        serveStatic(dist, path, req, res);
      }
    } catch {
      if (!res.headersSent) res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('Bad request');
    }
  });

  // ---------------------------------------------------------------- websockets

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
  const alive = new WeakSet<WebSocket>();

  http.on('upgrade', (req, socket, head) => {
    if (req.url?.split('?')[0] !== '/ws') return socket.destroy();
    const open = (account: Account | null): void => wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, account));
    // Who a socket is signed in as is what its cookie says as it opens, and stays so for as long as it is open (`signed`).
    if (!accounts || !req.headers.cookie || req.headers.origin !== home) return open(null);
    const gone = (): void => void socket.destroy(); // (a socket that fails while we ask must not be an error nobody listens for)
    socket.on('error', gone);
    void accounts.who(req.headers).then((account) => {
      socket.off('error', gone);
      open(account);
    });
  });

  wss.on('connection', (ws: WebSocket, account: Account | null) => {
    alive.add(ws);
    if (account) signed.set(ws, account);
    let room: Room | null = null;
    // Token bucket: a few seconds of burst, then `rate` messages per second.
    let allowance = rate * RATE_BURST_SECONDS;
    let refilled = Date.now();

    const send = (msg: ServerMsg): void => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (ws.bufferedAmount > MAX_BUFFERED_BYTES) return ws.terminate();
      ws.send(JSON.stringify(msg));
    };
    /** ws.close throws on a reason over 123 bytes, so the reason is cut to fit (whole characters only). */
    const over = (reason: string): void => {
      let fit = reason;
      while (Buffer.byteLength(fit) > 123) fit = [...fit].slice(0, -1).join('');
      ws.close(CLOSE_OVER, fit);
    };
    const conn: Conn = { send, close: over };
    /** The socket closed: the seat is kept for a reconnect. */
    const detach = (): void => {
      if (!room) return;
      const left = room;
      room = null;
      try {
        left.disconnect(conn);
      } finally {
        released(left); // even if the disconnect threw, or the room would never be forgotten
      }
    };
    /**
     * The socket is going to another table. A seat in a lobby is given up (so a
     * table opened and abandoned this way is forgotten at once, and one
     * connection can never hold more than one never-started table); a seat in
     * a game is kept, as for a dropped connection.
     */
    const moveOn = (): void => {
      if (room?.phase === 'lobby') room.handle(conn, { t: 'leave' });
      detach();
    };

    ws.on('pong', () => alive.add(ws));
    ws.on('error', () => {}); // e.g. an oversized frame; 'close' follows and does the cleanup
    ws.on('close', () => (signed.delete(ws), guard("a socket's close", detach)));
    ws.on('message', (data, isBinary) => {
      const now = Date.now();
      allowance = Math.min(rate * RATE_BURST_SECONDS, allowance + ((now - refilled) / 1000) * rate) - 1;
      refilled = now;
      if (allowance < 0) return ws.close(CLOSE_FLOOD, 'Too many messages'); // the client reconnects and resumes its seat
      alive.add(ws); // (anything it sends says it is there, as a pong does)
      guard('a message', () => {
        const msg = isBinary ? null : parseClientMsg(data.toString());
        if (msg?.t === 'ping') return send(msg.at === undefined ? { t: 'pong' } : { t: 'pong', at: msg.at });
        if (!msg) return room ? send({ t: 'error', message: 'Malformed message' }) : over('Malformed message'); // (at no table, it was the hello)
        if (msg.t === 'create' || msg.t === 'join') {
          if (!(msg.t === 'join' && room?.code === msg.room)) moveOn(); // a repeated join to the same table just re-seats
          let target: Room | undefined;
          if (msg.t === 'join') {
            target = rooms.get(msg.room);
            if (!target) return over(`Table ${msg.room} not found.`);
          } else {
            if (rooms.size >= MAX_ROOMS) return over('The server is full. Try again later.');
            target = new Room(freshCode(), { flipMs, hearMs, deal: options.deal, record });
          }
          const refusal = target.join(conn, msg.name, msg.token, msg.t === 'create', signed.get(ws) ?? null); // (whoever opens a table sits down at it; whoever comes to one does if there is a seat and no round on, and else watches until they ask)
          if (refusal) return over(refusal);
          rooms.set(target.code, target);
          idleSince.delete(target);
          room = target;
        } else if (room) {
          room.handle(conn, msg);
          if (msg.t === 'leave') {
            released(room);
            room = null;
          }
        }
      });
    });
  });

  // Browsers answer pings automatically; a socket that missed a whole interval is dead (laptop lid, lost wifi).
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      guard('the heartbeat', () => {
        if (!alive.has(ws)) return ws.terminate();
        alive.delete(ws);
        ws.ping();
      });
    }
  }, HEARTBEAT_MS);
  const sweeper = setInterval(() => guard('the sweep', sweep), SWEEP_MS);
  heartbeat.unref();
  sweeper.unref();

  const close = (): Promise<void> =>
    new Promise((done) => {
      clearInterval(heartbeat);
      clearInterval(sweeper);
      for (const ws of wss.clients) ws.terminate();
      for (const room of rooms.values()) room.close();
      wss.close();
      http.close(() => (db?.close(), done()));
      http.closeAllConnections();
    });

  return new Promise((ready, failed) => {
    http.once('error', failed);
    http.listen(options.port ?? 8787, () => {
      const address = http.address();
      ready({ port: typeof address === 'object' && address ? address.port : 0, kept: !!rounds, accounts: !!accounts, rooms, sweep, close });
    });
  });
}

/** What `open` gives; or, if it fails, null, with `what` and the error in the log. */
async function attempt<T>(what: string, open: () => T | Promise<T>): Promise<T | null> {
  try {
    return await open();
  } catch (err) {
    console.error(what, err);
    return null;
  }
}

/** What the environment asks to be kept, and how people are to sign in: said in the log where it asks for half of it. */
function fromEnv(): Pick<ServerOptions, 'data' | 'accounts'> {
  const data = dataFromEnv();
  const accounts = accountsFromEnv();
  if (!('missing' in accounts)) {
    if (!data) console.warn('accounts are off: DATA_DIR not set');
    return { data, accounts };
  }
  // Some of it set and some not: somebody meant to. (None of it: nobody did, and there is nothing to say.)
  if (accounts.asked) console.warn(`accounts are off: ${accounts.missing.join(', ')} not set`);
  return { data, accounts: null };
}

/** Serves the built client, falling back to index.html for app routes (anything without a file extension). */
function serveStatic(dist: string, path: string, req: IncomingMessage, res: ServerResponse): void {
  const text = (status: number, body: string): void => {
    res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(body);
  };
  if (req.method !== 'GET' && req.method !== 'HEAD') return text(405, 'Method not allowed');
  const isFile = (f: string): boolean => {
    try {
      return statSync(f).isFile();
    } catch {
      return false; // missing, or a path fs refuses (e.g. a NUL byte)
    }
  };
  let file = join(dist, path); // join normalises any '..'; the prefix check below is the actual guard
  if (!file.startsWith(dist + sep) || !isFile(file)) {
    if (extname(path)) return text(404, 'Not found');
    file = join(dist, 'index.html');
    if (!isFile(file)) return text(404, 'Client not built. Run `npm run build`, or use `npm run dev` and open http://localhost:5173.');
  }
  res.writeHead(200, {
    'content-type': MIME[extname(file)] ?? 'application/octet-stream',
    // Vite fingerprints everything under assets/; index.html must always be fresh.
    'cache-control': file.startsWith(join(dist, 'assets') + sep) ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  if (req.method === 'HEAD') return void res.end();
  createReadStream(file)
    .on('error', () => res.destroy())
    .pipe(res);
}

// Run when executed directly (`tsx server/index.ts`), not when imported by tests.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = await startServer({ port: Number(process.env.PORT) || 8787, ...fromEnv() });
  const hasClient = existsSync(fileURLToPath(new URL('../dist/index.html', import.meta.url)));
  console.log(`nertz server on http://localhost:${server.port}${hasClient ? '' : ' (websocket only: no dist/ build)'}${server.kept ? `, keeping rounds${server.accounts ? ' and accounts' : ''}` : ''}`);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => void server.close().then(() => process.exit(0)));
}
