// The table of a window that plays offline: the server's own room (server/room.ts) and its bots, run here, behind a
// line (client/line.ts) like the one to the game server. Nothing of the game is written again for it: what is sent is
// read as the server reads it (`parseClientMsg`), goes where the server sends it (server/index.ts, its websockets'
// `message`), and what the room answers comes back as text. So the store (client/net.ts) plays an offline table as it
// plays any other. The table is this line's alone, and gone with it: nobody else can come to it, nothing of it is kept,
// and its rounds are told to nobody (no `record`: they are on no one's record).
import { Room, type Conn } from '../server/room';
import { guard } from '../server/guard';
import { CLOSE_OVER, parseClientMsg, randomRoomCode, type ServerMsg } from '../shared/protocol';
import type { BotLevel } from '../shared/types';
import type { Dial } from './line';

/** Who is at an offline table as it opens, besides you: there is nobody else to wait for. Whoever opened it changes them as at any table. */
export const COMPANY: readonly BotLevel[] = ['medium', 'medium', 'medium'];

export const local: Dial = (heard) => {
  let room: Room | null = null;
  /** Until the window closes the line, or the room does. */
  let up = true;
  let open = false;
  /** Everything said to the window is said later, in the order it was said: never from inside its own `send`. */
  const later = (fn: () => void): void => queueMicrotask(() => up && fn());
  const down = (): void => {
    up = false;
    room?.close();
    room = null;
  };
  const send = (msg: ServerMsg): void => {
    const text = JSON.stringify(msg);
    later(() => heard.message(text));
  };
  const over = (reason: string): void => later(() => (down(), heard.close(CLOSE_OVER, reason)));
  const conn: Conn = { send, close: over };

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
        if (!msg) return room ? send({ t: 'error', message: 'Malformed message' }) : over('Malformed message');
        if (msg.t === 'join') return over(`Table ${msg.room} not found.`); // (there is no table here but the one this line opens)
        if (msg.t === 'create') {
          room?.close();
          room = new Room(randomRoomCode(), { schedule: queueMicrotask, testing: () => import.meta.env.DEV });
          const refusal = room.join(conn, msg.name, msg.token, true);
          if (refusal) return over(refusal);
          // Nobody to talk to; and its company seated.
          room.handle(conn, { t: 'social', text: false, voice: false });
          for (const level of COMPANY) room.handle(conn, { t: 'addBot', level });
        } else if (room) {
          room.handle(conn, msg);
          if (msg.t === 'leave') (room.close(), (room = null));
        }
      }),
    close: down,
  };
};
