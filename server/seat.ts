// One connection's way to the tables: which it is at, and where what it says goes. Opening a table or coming to one
// seats it there (`Room.join`); everything else is the table's to handle (`Room.handle`). The same for every
// connection there is: a websocket of the server's (server/index.ts), or the line of a window that plays offline
// (client/local.ts). What differs is only which tables there are (`Tables`), and what a connection must get past before
// it is heard here at all (the server's rate limit, and its stopping for an update).
import type { ClientMsg } from '../shared/protocol';
import type { Conn, Room, SignedAs } from './room';

/** The tables there are, as a connection needs them. */
export interface Tables {
  find(code: string): Room | undefined;
  /** A new table, with nobody at it yet; or why there cannot be one (said to whoever asked). */
  open(): Room | string;
  /** Someone has sat down at `room`, or come back to it: it is one of the tables, and not to be forgotten. */
  taken(room: Room): void;
  /** A connection has gone from `room` (it left, or its line closed): forgotten at once if nobody is left to come back, else in time. */
  released(room: Room): void;
}

export interface Seat {
  /** The table this connection is at, if any. */
  readonly room: Room | null;
  /** What it said: anything but a ping. */
  handle(msg: Exclude<ClientMsg, { t: 'ping' }>): void;
  /** Its line closed: its place at the table is kept for it to come back to. */
  detach(): void;
}

/** `conn`'s way to `tables`; `signed`: who it is signed in as, asked whenever it sits down. */
export function seatAt(conn: Conn, tables: Tables, signed: () => SignedAs | null = () => null): Seat {
  let room: Room | null = null;
  const detach = (): void => {
    if (!room) return;
    const left = room;
    room = null;
    try {
      left.disconnect(conn);
    } finally {
      tables.released(left); // even if the disconnect threw, or the room would never be forgotten
    }
  };
  /**
   * The connection is going to another table. A seat in a lobby is given up (so a
   * table opened and abandoned this way is forgotten at once, and one
   * connection can never hold more than one never-started table); a seat in
   * a game is kept, as for a dropped connection.
   */
  const moveOn = (): void => {
    if (room?.phase === 'lobby') room.handle(conn, { t: 'leave' });
    detach();
  };
  return {
    get room() {
      return room;
    },
    detach,
    handle(msg) {
      if (msg.t === 'create' || msg.t === 'join') {
        if (!(msg.t === 'join' && room?.code === msg.room)) moveOn(); // a repeated join to the same table just re-seats
        let target: Room | string | undefined;
        if (msg.t === 'join') {
          target = tables.find(msg.room);
          if (!target) return conn.close(`Table ${msg.room} not found.`);
        } else {
          target = tables.open();
          if (typeof target === 'string') return conn.close(target);
        }
        const refusal = target.join(conn, msg.name, msg.token, msg.t === 'create', signed()); // (whoever opens a table sits down at it; whoever comes to one does if there is a seat and no round on, and else watches until they ask)
        if (refusal) return conn.close(refusal);
        tables.taken(target);
        room = target;
      } else if (room) {
        room.handle(conn, msg);
        if (msg.t === 'leave') {
          tables.released(room);
          room = null;
        }
      }
    },
  };
}
