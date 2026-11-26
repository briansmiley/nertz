// The table of a window that plays offline: the server's own room (server/room.ts) and its bots, run here, behind a
// line (client/line.ts) like the one to the game server. Nothing of the game is written again for it: what is sent is
// read and goes where the server sends it (server/seat.ts, with the one table there is here for all the tables), and
// what the room answers comes back as text. So the store (client/net.ts) plays an offline table as it
// plays any other. The table is this line's alone, and gone with it: nobody else can come to it, and nothing of it is
// kept but its rounds: those go to the record of whoever was last signed in here, once they are back (client/record.ts),
// unless the settings say not to (`Prefs.saveStats`, as each round ends).
// The one table is opened here, or was the server's and is carried here (`Carried`): then it is the same table, and
// from here on no different from one opened here.
import { Room, type Conn, type Kept, type RoomOptions } from '../server/room';
import { guard } from '../server/guard';
import { seatAt, type Tables } from '../server/seat';
import { CLOSE_OVER, randomRoomCode, type ServerMsg } from '../shared/protocol';
import type { Dial } from './line';
import { getPrefs } from './prefs';
import { keep } from './record';

/**
 * A table taken offline: as it is kept (handed over by the server whole, or put together from this window's last
 * snapshot: client/rebuild.ts), and whether whoever takes it had paused its round.
 */
export interface Carried {
  kept: Kept;
  paused: boolean;
}

/** A line to a table of this window's own: one it opens, or `carried`, come to by its code as it was on the server. */
export const local = (carried?: Carried): Dial => (heard) => {
  // (A browser's queueMicrotask is not to be called as the room's own.)
  const options: RoomOptions = {
    schedule: (flush) => queueMicrotask(flush),
    testing: () => import.meta.env.DEV,
    record: (round) => {
      if (getPrefs().saveStats) keep(round);
    },
  };
  /** The one table there is here: the one carried here, or the one opened, once it is. */
  let table: Room | null = carried ? Room.restored(carried.kept, options) : null;
  /** The table nobody has sat down at here yet: carried, or being opened. */
  let fresh: Room | null = table;
  /** Until the window closes the line, or the room does. */
  let up = true;
  let open = false;
  /** Everything said to the window is said later, in the order it was said: never from inside its own `send`. */
  const later = (fn: () => void): void => queueMicrotask(() => up && fn());
  const send = (msg: ServerMsg): void => {
    const text = JSON.stringify(msg);
    later(() => heard.message(text));
  };
  const over = (reason: string): void => later(() => (down(), heard.close(CLOSE_OVER, reason)));
  const conn: Conn = { send, close: over };
  const tables: Tables = {
    find: (code) => (table?.code === code ? table : undefined),
    open: () => (fresh = new Room(randomRoomCode(), options)),
    taken: (room) => {
      const opened = room !== table;
      table = room;
      if (room !== fresh) return;
      fresh = null;
      // Sat down at for the first time here: nobody to talk to at it.
      room.handle(conn, { t: 'social', text: false, voice: false });
      // Just opened, it has nobody but you: you seat the bots, as at any table. Carried here, its round goes on: it came
      // stopped (`Room.restored`), and is paused again if it was.
      if (opened) return;
      room.handle(conn, { t: 'pause', on: false });
      if (carried?.paused) room.handle(conn, { t: 'pause', on: true });
    },
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
        if (up && open) seat.hear(text);
      }),
    close: down,
  };
};
