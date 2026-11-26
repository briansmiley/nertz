// A line to a table's server, as the store (client/net.ts) holds one. The store says what it wants done with what is
// heard, and is handed the line to speak on; where the server is, is the line's own business. There are two: `wire`,
// here, a websocket to the game server; and `local` (client/local.ts), a table that lives in this window.

/** What whoever opens a line is told of it. Never from inside `Dial` or `Line.send`: always later. */
export interface Heard {
  /** It is open: what is sent from now on goes. */
  open(): void;
  /** The server said something (one `ServerMsg`, as text). */
  message(text: string): void;
  /** It closed, and not by `Line.close`: the server ended it (`CLOSE_OVER` and why, `CLOSE_UPDATE`), or it dropped. */
  close(code: number, reason: string): void;
}

export interface Line {
  readonly open: boolean;
  /** One `ClientMsg`, as text. */
  send(text: string): void;
  /** Done with: it is closed, and nothing more is heard from it. */
  close(): void;
}

export type Dial = (heard: Heard) => Line;

/** A websocket to the game server this page came from. */
export const wire: Dial = (heard) => {
  const ws = new WebSocket(`${location.origin.replace(/^http/, 'ws')}/ws`);
  ws.onopen = () => heard.open();
  ws.onmessage = (e) => heard.message(String(e.data));
  ws.onclose = (e) => heard.close(e.code, e.reason);
  return {
    get open() {
      return ws.readyState === WebSocket.OPEN;
    },
    send: (text) => ws.send(text),
    close: () => {
      ws.onopen = ws.onmessage = ws.onclose = null; // (a silent socket may say it closed much later, or never)
      ws.close();
    },
  };
};
