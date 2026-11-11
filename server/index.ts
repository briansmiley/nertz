// The whole backend: one Node process, every room in memory. HTTP serves the
// built client (when dist/ exists) and /healthz; websockets on /ws carry the game.
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import WebSocket, { WebSocketServer } from 'ws';
import { MAX_MESSAGE_BYTES, parseClientMsg, randomRoomCode, type ServerMsg } from '../shared/protocol';
import { Room, type Conn } from './room';

const ROOM_TTL_MS = 10 * 60_000; // a room with no connections lives this long
const LOBBY_TTL_MS = 60_000; // ...unless it never dealt a round: an abandoned lobby holds nothing worth keeping
const SWEEP_MS = 60_000;
const HEARTBEAT_MS = 30_000;
const MAX_ROOMS = 2000;
const MAX_BUFFERED_BYTES = 1 << 20; // a client this far behind on snapshots is dropped
const RATE_PER_SECOND = 40; // sustained messages per connection; far above what a hand can do
const RATE_BURST_SECONDS = 3;
/** Close code (policy violation) for a connection that floods the server. */
export const CLOSE_FLOOD = 1008;
/** Close code sent to a socket whose seat was taken over by a newer connection with the same token. */
export const CLOSE_REPLACED = 4000;

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
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
};

export interface NertzServer {
  port: number;
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
}

export function startServer(options: ServerOptions = {}): Promise<NertzServer> {
  const dist = resolve(options.dist ?? fileURLToPath(new URL('../dist', import.meta.url)));
  const rate = options.rate ?? RATE_PER_SECOND;
  const rooms = new Map<string, Room>();
  const idleSince = new Map<Room, number>();

  /** Call when a connection has gone from `room`: forget it at once if nobody is seated, else start its idle clock. */
  const released = (room: Room): void => {
    if (room.connected > 0) return;
    if (room.empty) {
      room.close();
      if (rooms.get(room.code) === room) rooms.delete(room.code);
      idleSince.delete(room);
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
      idleSince.delete(room);
      room.close();
      if (rooms.get(room.code) === room) rooms.delete(room.code);
    }
  };

  // ---------------------------------------------------------------- http

  const http = createServer((req, res) => {
    try {
      const path = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
      if (path === '/healthz') {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ ok: true, rooms: rooms.size, connections: wss.clients.size }));
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
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws));
  });

  wss.on('connection', (ws: WebSocket) => {
    alive.add(ws);
    let room: Room | null = null;
    // Token bucket: a few seconds of burst, then `rate` messages per second.
    let allowance = rate * RATE_BURST_SECONDS;
    let refilled = Date.now();

    const send = (msg: ServerMsg): void => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (ws.bufferedAmount > MAX_BUFFERED_BYTES) return ws.terminate();
      ws.send(JSON.stringify(msg));
    };
    const conn: Conn = { send, close: () => ws.close(CLOSE_REPLACED, 'Replaced by a newer connection') };
    /** The socket closed: the seat is kept for a reconnect. */
    const detach = (): void => {
      if (!room) return;
      room.disconnect(conn);
      released(room);
      room = null;
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
    ws.on('close', detach);
    ws.on('message', (data, isBinary) => {
      const now = Date.now();
      allowance = Math.min(rate * RATE_BURST_SECONDS, allowance + ((now - refilled) / 1000) * rate) - 1;
      refilled = now;
      if (allowance < 0) return ws.close(CLOSE_FLOOD, 'Too many messages'); // the client reconnects and resumes its seat
      try {
        const msg = isBinary ? null : parseClientMsg(data.toString());
        if (!msg) return send({ t: 'error', message: 'Malformed message' });
        if (msg.t === 'create' || msg.t === 'join') {
          if (!(msg.t === 'join' && room?.code === msg.room)) moveOn(); // a repeated join to the same table just re-seats
          let target: Room | undefined;
          if (msg.t === 'join') {
            target = rooms.get(msg.room);
            if (!target) return send({ t: 'error', message: `There is no table ${msg.room}. Check the code, or start a new table.` });
          } else {
            if (rooms.size >= MAX_ROOMS) return send({ t: 'error', message: 'The server is full. Try again later.' });
            target = new Room(freshCode());
          }
          const refusal = target.join(conn, msg.name, msg.token);
          if (refusal) return send({ t: 'error', message: refusal });
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
      } catch (err) {
        console.error('error handling message', err); // one bad message must never take the process down
      }
    });
  });

  // Browsers answer pings automatically; a socket that missed a whole interval is dead (laptop lid, lost wifi).
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!alive.has(ws)) {
        ws.terminate();
        continue;
      }
      alive.delete(ws);
      ws.ping();
    }
  }, HEARTBEAT_MS);
  const sweeper = setInterval(sweep, SWEEP_MS);
  heartbeat.unref();
  sweeper.unref();

  const close = (): Promise<void> =>
    new Promise((done) => {
      clearInterval(heartbeat);
      clearInterval(sweeper);
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      http.close(() => done());
      http.closeAllConnections();
    });

  return new Promise((ready, failed) => {
    http.once('error', failed);
    http.listen(options.port ?? 8787, () => {
      const address = http.address();
      ready({ port: typeof address === 'object' && address ? address.port : 0, rooms, sweep, close });
    });
  });
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
  const server = await startServer({ port: Number(process.env.PORT) || 8787 });
  const hasClient = existsSync(fileURLToPath(new URL('../dist/index.html', import.meta.url)));
  console.log(`nertz server on http://localhost:${server.port}${hasClient ? '' : ' (websocket only: no dist/ build)'}`);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => void server.close().then(() => process.exit(0)));
}
