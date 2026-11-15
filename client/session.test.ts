// This window's session (client/net.ts): how it ends, and what a reload makes of it afterwards.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLOSE_OVER } from '../shared/protocol';
import type { RoomView } from '../shared/types';

/** Just enough of a browser WebSocket: the test plays the server. */
class FakeSocket {
  static OPEN = 1;
  static all: FakeSocket[] = [];
  readyState = 0;
  sent: { t: string; room?: string; name?: string }[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }
  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
  close(): void {}
  open(): void {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }
  deliver(msg: unknown): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  /** The server closes the connection, or (with no code) the line drops. */
  closed(code = 1006, reason = ''): void {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
}

const lobby = (code: string): RoomView => ({ code, phase: 'lobby', game: null, me: 0, seat: 0, players: [] }) as unknown as RoomView;

/** One browser window: its sessionStorage and its address outlive a reload; the page's script does not. */
let storage: Map<string, string>;
let page: { origin: string; search: string };
/** Loads the page's script afresh, as a reload does, and runs what main.tsx runs first. */
async function reload(): Promise<typeof import('./net')> {
  vi.resetModules();
  const net = await import('./net');
  net.resume();
  return net;
}
const sockets = () => FakeSocket.all.length;
const last = () => FakeSocket.all.at(-1)!;
const address = () => page.search;

beforeEach(() => {
  storage = new Map();
  page = { origin: 'http://localhost:5173', search: '' };
  FakeSocket.all = [];
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal('location', page);
  vi.stubGlobal('history', { replaceState: (_s: unknown, _t: string, url: string) => void (page.search = new URL(url, page.origin).search) });
  vi.stubGlobal('sessionStorage', {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => void storage.set(k, v),
    removeItem: (k: string) => void storage.delete(k),
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** A window that opened a table and was taken in: the server's first snapshot has come. */
async function seated(): Promise<typeof import('./net')> {
  const net = await reload();
  net.create('Ada');
  last().open();
  expect(last().sent[0]).toMatchObject({ t: 'create', name: 'Ada' });
  last().deliver({ t: 'state', rev: 0, ack: -1, room: lobby('ABCD') });
  expect(net.current()).toMatchObject({ status: 'online', room: { code: 'ABCD' } });
  return net;
}

describe("this window's session", () => {
  it('a reload while at the table sits back down at it, under the same name', async () => {
    await seated();
    expect(address()).toBe('?room=ABCD');
    const before = sockets();
    await reload();
    expect(sockets()).toBe(before + 1);
    last().open();
    expect(last().sent[0]).toMatchObject({ t: 'join', room: 'ABCD', name: 'Ada' });
  });

  it.each([
    ['sent away by whoever deals', 'You were removed from the table by whoever deals.'],
    ['its seat opened in another tab', 'This seat was opened in another tab.'],
  ])('%s: the window goes home, says why, and a reload stays at home', async (_, reason) => {
    const net = await seated();
    last().closed(CLOSE_OVER, reason);
    expect(net.current()).toEqual({ status: 'idle', room: null, error: reason });
    expect(address()).toBe('');
    const before = sockets();
    await reload();
    expect(sockets()).toBe(before); // nobody asked to sit down anywhere
  });

  it('refused at the table an invite names: home, told why, and a reload does not try again', async () => {
    page.search = '?room=ZZZZ';
    let net = await reload();
    expect(sockets()).toBe(0); // an invite is not a seat: it is for the form on the home page
    expect(net.roomInUrl()).toBe('ZZZZ');
    net.join('ZZZZ', 'Ada');
    last().open();
    last().closed(CLOSE_OVER, 'There is no table ZZZZ. Check the code, or start a new table.');
    expect(net.current()).toMatchObject({ status: 'idle', room: null, error: expect.stringMatching(/no table ZZZZ/) });
    net = await reload();
    expect(sockets()).toBe(1);
    expect(net.current().status).toBe('idle');
  });

  it('a dropped line is not the end: the window reconnects to its table, and a complaint on the way is only a complaint', async () => {
    vi.useFakeTimers();
    const net = await seated();
    last().closed(); // 1006: the network
    expect(net.current()).toMatchObject({ status: 'reconnecting', room: { code: 'ABCD' } });
    vi.advanceTimersByTime(300);
    expect(sockets()).toBe(2);
    last().open();
    expect(last().sent[0]).toMatchObject({ t: 'join', room: 'ABCD', name: 'Ada' });
    last().deliver({ t: 'error', message: 'Malformed message' }); // before this connection's first snapshot
    expect(net.current()).toMatchObject({ status: 'reconnecting', room: { code: 'ABCD' }, error: 'Malformed message' });
    last().deliver({ t: 'state', rev: 0, ack: -1, room: lobby('ABCD') });
    expect(net.current()).toMatchObject({ status: 'online', error: null });
    expect(address()).toBe('?room=ABCD');

    last().closed(); // and dropped again: a reload in the meantime still sits back down
    await reload();
    last().open();
    expect(last().sent[0]).toMatchObject({ t: 'join', room: 'ABCD', name: 'Ada' });
  });

  it('leaving ends it as well', async () => {
    const net = await seated();
    net.leave();
    expect(net.current()).toEqual({ status: 'idle', room: null, error: null });
    expect(address()).toBe('');
    const before = sockets();
    await reload();
    expect(sockets()).toBe(before);
  });

  it('a seat is kept only from the first snapshot: a reload while still being let in, or with another table in the address, lands at home', async () => {
    page.search = '?room=WXYZ';
    const net = await reload();
    net.join('WXYZ', 'Ada');
    last().open();
    await reload(); // not taken in yet
    expect(sockets()).toBe(1);

    await seated();
    page.search = '?room=QRST'; // someone's link, opened in this window
    const before = sockets();
    await reload();
    expect(sockets()).toBe(before);
  });
});
