// The table of a window that plays offline: the server's own room (server/room.ts) and its bots, run here, behind a
// line (client/line.ts) like the one to the game server. Nothing of the game is written again for it: what is sent is
// read as the server reads it (`parseClientMsg`), goes where the server sends it (server/seat.ts, with the one table
// there is here for all the tables), and what the room answers comes back as text. So the store (client/net.ts) plays an offline table as it
// plays any other. The table is this line's alone, and gone with it: nobody else can come to it, nothing of it is kept,
// and its rounds are told to nobody (no `record`: they are on no one's record).
import { Room, type Conn } from '../server/room';
import { guard } from '../server/guard';
import { seatAt, type Tables } from '../server/seat';
import { BOT_LEVELS, CLOSE_OVER, hasSeat, MAX_PLAYERS, parseClientMsg, randomRoomCode, type ServerMsg } from '../shared/protocol';
import type { BotLevel, RoomView } from '../shared/types';
import type { Dial } from './line';

/** Who is at the first offline table as it opens, besides you: there is nobody else to wait for. Whoever opened it changes them as at any table. */
export const COMPANY: readonly BotLevel[] = ['medium', 'medium', 'medium'];

/** The bots an offline table opens with: those of the last one (their levels; `remember`), or `COMPANY`. */
const KEY = 'nertz.company';
function company(): readonly BotLevel[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    const levels = Array.isArray(v) ? v.filter((l): l is BotLevel => BOT_LEVELS.includes(l as BotLevel)).slice(0, MAX_PLAYERS - 1) : [];
    return levels.length ? levels : COMPANY;
  } catch {
    return COMPANY;
  }
}
/** The bots at the table now are those the next one opens with. (None is not a company: the next has the last there was.) */
function remember(room: RoomView): void {
  const levels = room.players.flatMap((p) => (p.bot && hasSeat(p) ? [p.bot] : []));
  if (!levels.length) return;
  try {
    const now = JSON.stringify(levels);
    if (localStorage.getItem(KEY) !== now) localStorage.setItem(KEY, now);
  } catch {
    // no storage: the next table has the usual company
  }
}

export const local: Dial = (heard) => {
  /** The one table there is here, once it is opened. */
  let table: Room | null = null;
  /** Until the window closes the line, or the room does. */
  let up = true;
  let open = false;
  /** Everything said to the window is said later, in the order it was said: never from inside its own `send`. */
  const later = (fn: () => void): void => queueMicrotask(() => up && fn());
  const send = (msg: ServerMsg): void => {
    if (msg.t === 'state') remember(msg.room);
    const text = JSON.stringify(msg);
    later(() => heard.message(text));
  };
  const over = (reason: string): void => later(() => (down(), heard.close(CLOSE_OVER, reason)));
  const conn: Conn = { send, close: over };
  const tables: Tables = {
    find: (code) => (table?.code === code ? table : undefined),
    // (A browser's queueMicrotask is not to be called as the room's own.)
    open: () => new Room(randomRoomCode(), { schedule: (flush) => queueMicrotask(flush), testing: () => import.meta.env.DEV }),
    taken: (room) => void (table = room),
    // Nobody else can come back to it: gone from it, it is gone.
    released: (room) => {
      room.close();
      if (table === room) table = null;
    },
  };
  const seat = seatAt(conn, tables);
  const down = (): void => {
    up = false;
    seat.detach();
    table?.close();
    table = null;
  };

  later(() => ((open = true), heard.open()));
  return {
    get open() {
      return up && open;
    },
    send: (text) =>
      guard('a message', () => {
        if (!up || !open) return;
        const msg = parseClientMsg(text);
        if (msg?.t === 'ping') return send(msg.at === undefined ? { t: 'pong' } : { t: 'pong', at: msg.at });
        if (!msg) return seat.room ? send({ t: 'error', message: 'Malformed message' }) : over('Malformed message');
        seat.handle(msg);
        // A table just opened: nobody to talk to at it, and its company seated.
        if (msg.t === 'create' && seat.room) {
          seat.room.handle(conn, { t: 'social', text: false, voice: false });
          for (const level of company()) seat.room.handle(conn, { t: 'addBot', level });
        }
      }),
    close: down,
  };
};
