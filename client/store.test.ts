// The store (client/net.ts) over a fake socket: the connection, the retry, this window's session and how it ends, what
// a reload makes of it afterwards, and the page put up anew.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLOSE_OVER, CLOSE_UPDATE } from '../shared/protocol';
import { inPlay, lcg, roomOf } from '../shared/testkit';
import type { GameState, RoomView } from '../shared/types';

/** Just enough of a browser WebSocket: the test plays the server. */
class FakeSocket {
  static OPEN = 1;
  static all: FakeSocket[] = [];
  readyState = 0;
  sent: { t: string; [k: string]: unknown }[] = [];
  /** The window closed it. */
  shut = false;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }
  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
  close(): void {
    this.shut = true;
  }
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

/** A snapshot of the table `code`, in play, as seat 0 sees it. */
const at = (code = 'ABCD', rev = 0) => ({ t: 'state', rev, ack: -1, room: roomOf(inPlay([0, 1], lcg(8)), 0, { code }) });

/** One browser window: its sessionStorage and its address outlive a reload; the page's script does not. */
let storage: Map<string, string>;
let page: { origin: string; search: string; reload: () => void };
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
  page = { origin: 'http://localhost:5173', search: '', reload: vi.fn() };
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

/** The start of the server a page was served by (see 'a page put up anew'). */
const BOOT = 'registry.fly.io/nertz:deployment-old';

/** A window that opened a table and was taken in: the server's first snapshot has come. */
async function seated(): Promise<typeof import('./net')> {
  const before = sockets();
  const net = await reload();
  if (sockets() > before) FakeSocket.all.pop()!.deliver({ t: 'welcome', boot: BOOT }); // (a page at home listens once for the server's boot)
  net.create('Ada');
  last().open();
  expect(last().sent[0]).toMatchObject({ t: 'create', name: 'Ada' });
  last().deliver(at('ABCD'));
  expect(net.current()).toMatchObject({ status: 'online', room: { code: 'ABCD' } });
  return net;
}

describe('the connection', () => {
  it("opens one socket to the page's own server, says hello once it is open, and keeps the code the server gave from the first snapshot", async () => {
    page.origin = 'https://nertz.example';
    const net = await reload();
    net.create('Ada');
    expect(sockets()).toBe(1);
    expect(last().url).toBe('wss://nertz.example/ws');
    expect(net.current()).toEqual({ status: 'connecting', room: null, error: null, offline: false });
    expect(last().sent).toEqual([]); // nothing goes before it is open

    last().open();
    expect(last().sent.map((m) => m.t)).toEqual(['create', 'deck']);
    last().deliver(at('ABCD'));
    expect(net.current()).toMatchObject({ status: 'online', room: { code: 'ABCD' }, error: null });
    expect(address()).toBe('?room=ABCD');
    expect(JSON.parse(storage.get('nertz.seat')!)).toEqual({ room: 'ABCD', name: 'Ada' });
    last().deliver(at('ABCD', 1));
    expect(last().sent).toHaveLength(2); // a snapshot is not answered
  });

  it('each message from the server goes to whoever it is for, and one it does not know goes to nobody', async () => {
    const net = await seated();
    const heard: string[] = [];
    net.onSnipe((m) => heard.push(`snipe ${m.by} ${m.of}`));
    net.onDrag((m) => heard.push(`drag ${m.seat}`));
    net.onSocial((m) => heard.push(m.t));
    const before = net.current();
    const msgs = [
      { t: 'snipe', by: 1, of: 0, slot: 2 },
      { t: 'drag', seat: 1, id: 'S1', w: 0.5, h: [1, 1], p: [0.1, 0.2] },
      { t: 'chat', lines: [], history: true },
      { t: 'social', inVoice: [], text: true, voice: true },
      { t: 'signal', from: 1, data: '{}' },
      { t: 'later' },
      { t: 'toString' },
    ];
    for (const msg of msgs) last().deliver(msg);
    last().onmessage!({ data: 'not json' });
    expect(heard).toEqual(['snipe 1 0', 'drag 1', 'chat', 'social', 'signal']);
    expect(net.current()).toBe(before);
    last().deliver({ t: 'error', message: 'Malformed message' });
    expect(net.current()).toMatchObject({ status: 'online', room: { code: 'ABCD' }, error: 'Malformed message' });
  });

  it('a dropped line is not the end: the window reconnects to its table as the same person, and a complaint on the way is only a complaint', async () => {
    vi.useFakeTimers();
    const net = await seated();
    const token = last().sent[0]!.token;
    last().closed(); // 1006: the network
    expect(net.current()).toMatchObject({ status: 'reconnecting', room: { code: 'ABCD' }, error: null });
    vi.advanceTimersByTime(300);
    expect(sockets()).toBe(2);
    last().open();
    expect(last().sent[0]).toEqual({ t: 'join', room: 'ABCD', name: 'Ada', token });
    expect(last().sent.filter((m) => m.t === 'join')).toHaveLength(1);
    last().deliver({ t: 'error', message: 'Malformed message' }); // before this connection's first snapshot
    expect(net.current()).toMatchObject({ status: 'reconnecting', room: { code: 'ABCD' }, error: 'Malformed message' });
    last().deliver(at('ABCD'));
    expect(net.current()).toMatchObject({ status: 'online', error: null });
    expect(address()).toBe('?room=ABCD');

    last().closed(); // and dropped again: a reload in the meantime still sits back down
    await reload();
    last().open();
    expect(last().sent[0]).toMatchObject({ t: 'join', room: 'ABCD', name: 'Ada', token });
  });

  it('retries a server it cannot reach ever more slowly, up to every five seconds, and from the start again once it is back', async () => {
    vi.useFakeTimers();
    const net = await reload();
    net.join('ABCD', 'Ada');
    last().closed(); // never opened
    expect(net.current()).toEqual({ status: 'reconnecting', room: null, error: 'Cannot reach the game server. Still trying…', offline: false });
    const waits: number[] = [];
    for (let i = 0; i < 7; i++) {
      const n = sockets();
      let waited = 0;
      while (sockets() === n && waited < 10_000) {
        vi.advanceTimersByTime(250);
        waited += 250;
      }
      waits.push(waited);
      if (i < 6) last().closed();
    }
    expect(waits).toEqual([250, 500, 1000, 2000, 4000, 5000, 5000]);

    last().open();
    last().deliver(at('ABCD'));
    last().closed();
    const n = sockets();
    vi.advanceTimersByTime(250);
    expect(sockets()).toBe(n + 1);
  });

  // Regression: after a reconnect the socket is open before its first snapshot arrives. `send` judged the intent
  // against the old table, then rendered `predict` of a connection that had no snapshot: null, i.e. the home screen.
  it('sends and predicts nothing between a reconnect and its first snapshot, and keeps the table on screen', async () => {
    vi.useFakeTimers();
    const net = await reload();
    net.join('ABCD', 'Ada');
    const first = last();
    first.open();
    expect(first.sent).toMatchObject([{ t: 'join', room: 'ABCD', name: 'Ada' }, { t: 'deck' }]);
    expect(net.send({ k: 'draw' })).toBe(false); // nothing to play on yet
    first.deliver(at('ABCD'));
    expect(net.current()).toMatchObject({ status: 'online', room: { phase: 'playing' } });
    expect(net.send({ k: 'draw' })).toBe(true);
    expect(first.sent.at(-1)).toEqual({ t: 'intent', seq: 1, intent: { k: 'draw' } });

    first.closed();
    expect(net.current().status).toBe('reconnecting');
    vi.advanceTimersByTime(300);
    const second = last();
    second.open();
    expect(second.sent).toHaveLength(2); // the join, and which deck
    const shown = net.current().room;
    expect(shown?.game).toBeTruthy();
    expect(shown!.game!.players[0]!.waste).toHaveLength(0); // the flip that was never answered died with the line

    expect(net.send({ k: 'draw' })).toBe(false);
    expect(second.sent).toHaveLength(2); // nothing went out
    expect(net.current().room).toBe(shown); // and the table is still what is rendered

    second.deliver(at('ABCD'));
    expect(net.current().status).toBe('online');
    expect(net.send({ k: 'draw' })).toBe(true);
    expect(second.sent.at(-1)).toEqual({ t: 'intent', seq: 1, intent: { k: 'draw' } }); // seq starts over with the connection
    expect(net.current().room!.game!.players[0]!.waste).toHaveLength(1);
  });

  it('a socket the window is done with is not listened to: its late snapshot, complaint or close changes nothing', async () => {
    vi.useFakeTimers();
    const net = await seated();
    const old = last();
    const shown = net.current().room;
    net.join('WXYZ', 'Ada'); // another table
    expect(old.shut).toBe(true);
    last().open();
    expect(last().sent[0]).toMatchObject({ t: 'join', room: 'WXYZ' });
    old.deliver(at('ABCD', 5));
    old.deliver({ t: 'error', message: 'Malformed message' });
    old.closed(1005);
    vi.advanceTimersByTime(10_000);
    expect(sockets()).toBe(2);
    expect(net.current().error).toBeNull();
    expect(net.current().room).toBe(shown); // (the table it left, on screen until the new one is there)
  });

  it('a socket that opens only after the window has moved on says nothing, on it or on the socket that took its place', async () => {
    const net = await reload();
    net.join('ABCD', 'Ada');
    const old = last();
    net.join('WXYZ', 'Ada');
    last().open();
    old.open();
    expect(old.sent).toEqual([]);
    expect(last().sent.map((m) => m.t)).toEqual(['join', 'deck']);
  });
});

describe('a line that dies without a word', () => {
  /** What the window listens for, on `window` and `document`, by event. */
  let on: Map<string, () => void>;
  beforeEach(() => {
    on = new Map();
    const listen = (event: string, fn: () => void) => void on.set(event, fn);
    vi.stubGlobal('window', { addEventListener: listen });
    vi.stubGlobal('document', { visibilityState: 'visible', documentElement: { classList: { toggle: () => {} } }, querySelector: () => null, addEventListener: listen });
  });
  const pings = () => last().sent.filter((m) => m.t === 'ping').length;

  it('the window asks every few seconds, and a line that answers stays up however quiet the table is', async () => {
    vi.useFakeTimers();
    const net = await seated();
    const socket = last();
    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(5_000);
      socket.deliver({ t: 'pong' });
    }
    expect(pings()).toBe(10);
    expect(sockets()).toBe(1);
    expect(net.current().status).toBe('online');
  });

  it('a line that is busy anyway is not asked: whatever comes down it says it is up', async () => {
    vi.useFakeTimers();
    const net = await seated();
    for (let i = 0; i < 40; i++) {
      vi.advanceTimersByTime(1_000);
      last().deliver({ t: 'drag', seat: 1, id: 'S1', w: 0.5, h: [1, 1], p: [0.1, 0.2] });
    }
    expect(pings()).toBe(0);
    expect(sockets()).toBe(1);
    expect(net.current().status).toBe('online');
  });

  it('a line that has said nothing at all for a while is taken for dead: the window reconnects to its table and is let back in', async () => {
    vi.useFakeTimers();
    const net = await seated();
    const dead = last();
    vi.advanceTimersByTime(14_000);
    expect(net.current()).toMatchObject({ status: 'online' }); // (not yet)
    vi.advanceTimersByTime(2_000);
    expect(dead.shut).toBe(true);
    expect(net.current()).toMatchObject({ status: 'reconnecting', room: { code: 'ABCD' } });
    vi.advanceTimersByTime(300);
    expect(sockets()).toBe(2);
    last().open();
    expect(last().sent[0]).toMatchObject({ t: 'join', room: 'ABCD', name: 'Ada' });
    dead.closed(); // its close, at last, changes nothing
    expect(sockets()).toBe(2);
    last().deliver(at('ABCD'));
    expect(net.current().status).toBe('online');
  });

  it('back on the network, or in front: an open line has a moment to answer, and one that does not is dropped at once', async () => {
    vi.useFakeTimers();
    const net = await seated();
    on.get('online')!();
    expect(pings()).toBe(1);
    vi.advanceTimersByTime(1_000);
    last().deliver({ t: 'pong' });
    vi.advanceTimersByTime(3_000);
    expect(sockets()).toBe(1); // it answered

    on.get('visibilitychange')!();
    vi.advanceTimersByTime(3_000);
    expect(net.current().status).toBe('reconnecting'); // it did not
  });

  it('back on the network while waiting out a retry: it goes now', async () => {
    vi.useFakeTimers();
    await seated();
    for (let i = 0; i < 5; i++) {
      last().closed();
      vi.advanceTimersByTime(5_000);
    }
    const n = sockets();
    last().closed();
    on.get('online')!();
    expect(sockets()).toBe(n + 1);
  });

  it('with the ping shown, the window asks even a busy line, times each answer by the clock its ping carried, and forgets the time when the line drops', async () => {
    vi.useFakeTimers();
    const net = await seated();
    const { setPrefs } = await import('./prefs');
    const rtt = net.rttNow;
    setPrefs({ ping: true });
    expect(pings()).toBe(1); // at once, not at the next look
    for (let i = 0; i < 3; i++) {
      vi.advanceTimersByTime(5_000);
      last().deliver({ t: 'drag', seat: 1, id: 'S1', w: 0.5, h: [1, 1], p: [0.1, 0.2] });
    }
    expect(pings()).toBe(4);
    const ping = last().sent.filter((m) => m.t === 'ping').at(-1)!;
    expect(typeof ping.at).toBe('number');
    last().deliver({ t: 'pong', at: (ping.at as number) - 30 });
    expect(rtt()).toBeGreaterThanOrEqual(30);
    expect(rtt()).toBeLessThan(40);
    last().deliver({ t: 'pong' }); // (an answer to a ping that carried no clock times nothing)
    expect(rtt()).toBeGreaterThanOrEqual(30);
    last().closed();
    expect(rtt()).toBeNull();
  });

  it('leaving stops the asking', async () => {
    vi.useFakeTimers();
    const net = await seated();
    net.leave();
    const sent = last().sent.length;
    vi.advanceTimersByTime(60_000);
    expect(last().sent).toHaveLength(sent);
    expect(sockets()).toBe(1);
  });
});

describe("this window's session", () => {
  it('a reload while at the table sits back down at it, under the same name, and says it is rejoining until it is seated (nothing of home meanwhile)', async () => {
    await seated();
    expect(address()).toBe('?room=ABCD');
    const before = sockets();
    const net = await reload();
    expect(sockets()).toBe(before + 1);
    expect(net.current()).toMatchObject({ status: 'rejoining' });
    last().open();
    expect(last().sent[0]).toMatchObject({ t: 'join', room: 'ABCD', name: 'Ada' });
    last().deliver(at('ABCD'));
    expect(net.current()).toMatchObject({ status: 'online' });
  });

  it('names the table in the address beside whatever else is there (a set-up deal), and takes only the table out when it goes', async () => {
    page.search = '?deal=aces';
    const net = await seated();
    expect(address()).toBe('?deal=aces&room=ABCD');
    net.leave();
    expect(address()).toBe('?deal=aces');
  });

  it.each([
    ['sent away by whoever deals', 'You were removed from the table by whoever deals.'],
    ['its seat opened in another tab', 'This seat was opened in another tab.'],
  ])('%s: the window goes home, says why, does not come back by itself, and a reload stays at home', async (_, reason) => {
    vi.useFakeTimers();
    const net = await seated();
    last().closed(CLOSE_OVER, reason);
    expect(net.current()).toEqual({ status: 'idle', room: null, error: reason, offline: false });
    expect(address()).toBe('');
    const before = sockets();
    vi.advanceTimersByTime(10_000);
    expect(sockets()).toBe(before);
    await reload();
    expect(sockets()).toBe(before); // nobody asked to sit down anywhere
  });

  it('sent away, the window may still sit down at that table again when its player asks to', async () => {
    const net = await seated();
    last().closed(CLOSE_OVER, 'You were removed from the table by whoever deals.');
    net.join('ABCD', 'Ada');
    expect(net.current()).toEqual({ status: 'connecting', room: null, error: null, offline: false });
    last().open();
    expect(last().sent[0]).toMatchObject({ t: 'join', room: 'ABCD', name: 'Ada' });
    last().deliver(at('ABCD'));
    expect(net.current()).toMatchObject({ status: 'online', room: { code: 'ABCD' } });
    expect(address()).toBe('?room=ABCD');
  });

  it('refused at the table an invite names: home, told why, and neither the window nor a reload tries again', async () => {
    vi.useFakeTimers();
    page.search = '?room=ZZZZ';
    let net = await reload();
    expect(sockets()).toBe(0); // an invite is not a seat: it is for the form on the home page
    expect(net.roomInUrl()).toBe('ZZZZ');
    net.join('ZZZZ', 'Ada');
    last().open();
    last().closed(CLOSE_OVER, 'Table ZZZZ not found.');
    expect(net.current()).toMatchObject({ status: 'idle', room: null, error: expect.stringMatching(/Table ZZZZ not found/) });
    vi.advanceTimersByTime(10_000);
    expect(sockets()).toBe(1);
    net = await reload();
    expect(sockets()).toBe(1);
    expect(net.current().status).toBe('idle');
  });

  it('leaving ends it as well, and says so to the table', async () => {
    const net = await seated();
    net.leave();
    expect(last().sent.at(-1)).toEqual({ t: 'leave' });
    expect(last().shut).toBe(true);
    expect(net.current()).toEqual({ status: 'idle', room: null, error: null, offline: false });
    expect(address()).toBe('');
    const before = sockets();
    await reload();
    expect(sockets()).toBe(before);
  });

  it('leaving while reconnecting calls the retry off: the table sat down at next has the one socket', async () => {
    vi.useFakeTimers();
    const net = await seated();
    last().closed();
    expect(net.current().status).toBe('reconnecting');
    net.leave();
    expect(net.current()).toEqual({ status: 'idle', room: null, error: null, offline: false });
    net.join('WXYZ', 'Ada');
    vi.advanceTimersByTime(10_000);
    expect(sockets()).toBe(2);
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

describe('a window that plays offline', () => {
  /** A page whose settings say offline: its table is its own (client/local.ts), told of only later. */
  async function offline(): Promise<{ net: typeof import('./net'); prefs: typeof import('./prefs') }> {
    const net = await reload();
    const prefs = await import('./prefs');
    prefs.setPrefs({ offline: true });
    return { net, prefs };
  }
  const told = async (): Promise<void> => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  };

  it('a page loaded with the settings saying offline asks the server nothing, not even its boot', async () => {
    vi.stubGlobal('document', { visibilityState: 'visible', documentElement: { classList: { toggle: () => {} } }, querySelector: () => null, addEventListener: () => {} });
    vi.stubGlobal('localStorage', { getItem: () => JSON.stringify({ offline: true }), setItem: () => {} });
    const net = await reload();
    expect(net.current().offline).toBe(true);
    expect(sockets()).toBe(0);
  });

  it('is offline as its settings say while it is at no table', async () => {
    const { net, prefs } = await offline();
    expect(net.current()).toMatchObject({ status: 'idle', offline: true });
    prefs.setPrefs({ offline: false });
    expect(net.current().offline).toBe(false);
  });

  it('opens a table of its own with no socket: seated at once, nobody else at it, with nothing in the address and nothing kept for a reload', async () => {
    const { net } = await offline();
    net.create('Ada');
    await told();
    expect(sockets()).toBe(0);
    const { status, room, error } = net.current();
    expect({ status, error }).toEqual({ status: 'online', error: null });
    expect(room!.players.map((p) => p.bot ?? p.name)).toEqual(['Ada']);
    expect(address()).toBe('');
    expect(storage.has('nertz.seat')).toBe(false);
    // What it does at the table goes to the table: alone, there is no deal; a bot, and there is.
    net.start();
    await told();
    expect(net.current().room).toMatchObject({ phase: 'lobby' });
    net.addBot('fast');
    net.start();
    await told();
    expect(net.current().room).toMatchObject({ phase: 'playing', round: 1 });
    expect(net.current().room!.players.map((p) => p.bot ?? p.name)).toEqual(['Ada', 'fast']);
    net.leave();
  });

  it('a table is offline or not as it was opened, whatever the settings say since; leaving it, the window is as they say', async () => {
    const { net, prefs } = await offline();
    net.create('Ada');
    await told();
    prefs.setPrefs({ offline: false });
    expect(net.current()).toMatchObject({ status: 'online', offline: true });
    net.leave();
    expect(net.current()).toEqual({ status: 'idle', room: null, error: null, offline: false });
    expect(sockets()).toBe(0);

    net.create('Ada');
    last().open();
    last().deliver(at('ABCD'));
    prefs.setPrefs({ offline: true });
    expect(net.current()).toMatchObject({ status: 'online', room: { code: 'ABCD' }, offline: false });
    net.leave();
    expect(net.current().offline).toBe(true);
  });

  it('Offline switched on while a new table cannot be reached: the window gives that table up, and is offline at once', async () => {
    vi.useFakeTimers();
    const net = await reload();
    const prefs = await import('./prefs');
    net.create('Ada');
    last().closed(); // no server to be had
    await vi.advanceTimersByTimeAsync(3000);
    expect(net.current()).toMatchObject({ status: 'reconnecting', room: null, error: 'Cannot reach the game server. Still trying…', offline: false });
    const tried = sockets();
    prefs.setPrefs({ offline: true });
    expect(net.current()).toEqual({ status: 'idle', room: null, error: null, offline: true });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sockets()).toBe(tried); // (and it has stopped trying)
    net.create('Ada');
    await vi.advanceTimersByTimeAsync(0);
    expect(net.current()).toMatchObject({ status: 'online', offline: true, room: { phase: 'lobby' } });
    expect(sockets()).toBe(tried);
    net.leave();
  });

  it('only the switch itself gives a table up: some other setting changed while on the way to one changes nothing', async () => {
    const net = await reload();
    const prefs = await import('./prefs');
    net.join('WXYZ', 'Ada');
    prefs.setPrefs({ muted: true });
    expect(net.current()).toMatchObject({ status: 'connecting', offline: false });
    last().open();
    expect(last().sent[0]).toMatchObject({ t: 'join', room: 'WXYZ' });
  });

  it('a table that is there already is the server\'s, whatever the settings say: a reload sits back down at it, and one come to by its code is come to', async () => {
    const net = await seated();
    const prefs = await import('./prefs');
    prefs.setPrefs({ offline: true }); // (another window of this browser switched it on)
    expect(net.current()).toMatchObject({ status: 'online', room: { code: 'ABCD' }, offline: false });
    // The reload: the page's script anew, with the settings as they are kept.
    vi.stubGlobal('localStorage', { getItem: () => JSON.stringify({ offline: true }), setItem: () => {} });
    const before = sockets();
    const again = await reload();
    expect((await import('./prefs')).getPrefs().offline).toBe(true);
    expect(sockets()).toBe(before + 1);
    expect(again.current()).toMatchObject({ status: 'rejoining', offline: false });
    last().open();
    expect(last().sent[0]).toMatchObject({ t: 'join', room: 'ABCD', name: 'Ada' });
    last().deliver(at('ABCD'));
    expect(again.current()).toMatchObject({ status: 'online', room: { code: 'ABCD' }, offline: false, error: null });
    expect(address()).toBe('?room=ABCD');
    again.leave();
    expect(again.current().offline).toBe(true);
    // Come to by its code (a link someone sent), with Offline on: the server's table still.
    again.join('WXYZ', 'Ada');
    expect(sockets()).toBe(before + 2);
    expect(again.current()).toMatchObject({ status: 'connecting', offline: false });
  });

  it('Offline pressed while the table a reload went back to cannot be reached, the settings saying offline already: the window gives the table up, and is offline', async () => {
    vi.useFakeTimers();
    // The page loads as a window that was at ABCD left it, with the settings as they are kept.
    storage.set('nertz.seat', JSON.stringify({ room: 'ABCD', name: 'Ada' }));
    page.search = '?room=ABCD';
    vi.stubGlobal('localStorage', { getItem: () => JSON.stringify({ offline: true }), setItem: () => {} });
    const net = await reload();
    expect(net.current()).toMatchObject({ status: 'rejoining', offline: false });
    const prefs = await import('./prefs');
    last().closed(); // no server to be had
    await vi.advanceTimersByTimeAsync(3000);
    expect(net.current()).toMatchObject({ status: 'reconnecting', room: null, offline: false });
    const tried = sockets();
    prefs.setPrefs({ offline: true }); // (what the settings said already: the window did not have it so)
    expect(net.current()).toEqual({ status: 'idle', room: null, error: null, offline: true });
    expect(address()).toBe('');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sockets()).toBe(tried);
    net.create('Ada');
    await vi.advanceTimersByTimeAsync(0);
    expect(net.current()).toMatchObject({ status: 'online', offline: true, room: { phase: 'lobby' } });
    net.leave();
  });

  it('there is no standing up from a table of its own, to watch or for now; at one others can come to, there is', async () => {
    vi.useFakeTimers();
    const { net, prefs } = await offline();
    const actions = await import('./actions');
    net.create('Ada');
    await vi.advanceTimersByTimeAsync(0);
    net.addBot('medium');
    net.start();
    await vi.advanceTimersByTimeAsync(5000);
    net.go();
    await vi.advanceTimersByTimeAsync(5000);
    const room = net.current().room!;
    expect(room.game!.status.at).toBe('play');
    expect(net.reach().others).toBe(false);
    expect(actions.standing(room)).toBeNull();
    expect(actions.tableActions(room).map((a) => a.id)).toEqual(['pause', 'vote', 'redeal', 'leave']);
    // (And the lone human's vote is not counted out loud.)
    expect(actions.tableActions(room).find((a) => a.id === 'vote')).toEqual({ id: 'vote', label: 'End round', on: false });
    net.leave();
    prefs.setPrefs({ offline: false });
    expect(net.reach().others).toBe(true);
    expect(actions.tableActions(room).map((a) => a.id)).toContain('stand');
  });

  it("leaves someone's link in the address alone, and a reload lands at home", async () => {
    page.search = '?room=WXYZ';
    const { net } = await offline();
    net.create('Ada');
    await told();
    expect(address()).toBe('?room=WXYZ');
    net.leave();
    expect(address()).toBe('?room=WXYZ');
    await reload();
    expect(sockets()).toBe(0);
  });

  it('its line never drops: however long the window was frozen in the background, and whatever it is told of the network, the table is there', async () => {
    vi.useFakeTimers();
    const listeners = new Map<string, () => void>();
    const listen = (type: string, fn: () => void) => void listeners.set(type, fn);
    vi.stubGlobal('window', { addEventListener: listen });
    vi.stubGlobal('document', { visibilityState: 'visible', documentElement: { classList: { toggle: () => {} } }, querySelector: () => null, addEventListener: listen });
    const { net } = await offline();
    net.create('Ada');
    await vi.advanceTimersByTimeAsync(0);
    const code = net.current().room!.code;
    const before = sockets(); // (the page asked the server's boot as it loaded, before the settings said offline)
    vi.setSystemTime(Date.now() + 60 * 60_000); // (frozen: the clock went on, and no timer ran)
    await vi.advanceTimersByTimeAsync(60_000);
    listeners.get('online')!();
    listeners.get('visibilitychange')!();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(net.current()).toMatchObject({ status: 'online', error: null, room: { code } });
    expect(sockets()).toBe(before);
    net.leave();
  });

  it('a round at its table is paused when the window is left (another tab, the screen off), and waits to be resumed; a table others are at is not', async () => {
    vi.useFakeTimers();
    const listeners = new Map<string, () => void>();
    const listen = (type: string, fn: () => void) => void listeners.set(type, fn);
    const doc = { visibilityState: 'visible', documentElement: { classList: { toggle: () => {} } }, querySelector: () => null, addEventListener: listen };
    vi.stubGlobal('window', { addEventListener: listen });
    vi.stubGlobal('document', doc);
    const { net, prefs } = await offline();
    net.create('Ada');
    await vi.advanceTimersByTimeAsync(0);
    net.addBot('medium');
    net.start();
    await vi.advanceTimersByTimeAsync(5000);
    net.go();
    await vi.advanceTimersByTimeAsync(5000);
    expect(net.current().room).toMatchObject({ phase: 'playing', paused: null, game: { status: { at: 'play' } } });
    doc.visibilityState = 'hidden';
    listeners.get('visibilitychange')!();
    await vi.advanceTimersByTimeAsync(0);
    const me = net.current().room!.me;
    expect(net.current().room!.paused).toEqual({ by: 'player', id: me });
    const stood = JSON.stringify(net.current().room!.game);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    doc.visibilityState = 'visible';
    listeners.get('visibilitychange')!();
    await vi.advanceTimersByTimeAsync(1000);
    expect(JSON.stringify(net.current().room!.game)).toBe(stood); // (no bot played a card meanwhile)
    net.pause(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(net.current().room!.paused).toBeNull();
    net.leave();

    // Left before the round is live (the cards dealt, "1, 2, 3" being said): paused as soon as it is.
    net.create('Ada');
    await vi.advanceTimersByTimeAsync(0);
    net.addBot('medium');
    net.start();
    await vi.advanceTimersByTimeAsync(5000);
    net.go();
    doc.visibilityState = 'hidden';
    listeners.get('visibilitychange')!();
    await vi.advanceTimersByTimeAsync(0);
    expect(net.current().room).toMatchObject({ paused: null, game: { status: { at: 'countdown' } } });
    await vi.advanceTimersByTimeAsync(5000);
    expect(net.current().room).toMatchObject({ paused: { by: 'player', id: net.current().room!.me }, game: { status: { at: 'play' } } });
    const lay = JSON.stringify(net.current().room!.game);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(JSON.stringify(net.current().room!.game)).toBe(lay);
    doc.visibilityState = 'visible';
    listeners.get('visibilitychange')!();
    net.leave();

    prefs.setPrefs({ offline: false });
    net.create('Ada');
    last().open();
    last().deliver(at('ABCD'));
    const before = last().sent.length;
    doc.visibilityState = 'hidden';
    listeners.get('visibilitychange')!();
    expect(last().sent.slice(before)).toEqual([]);
  });
});

describe('Play offline and Play online, in the menu', () => {
  const told = async (): Promise<void> => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  };
  const ids = (actions: typeof import('./actions'), net: typeof import('./net')) => actions.actionsAt(net.current().room).map((a) => a.id);

  it('at no table there is the one that is not so now, and it changes the settings', async () => {
    const net = await reload();
    const prefs = await import('./prefs');
    const actions = await import('./actions');
    expect(ids(actions, net)).toEqual(['offline']);
    actions.press('offline', null);
    expect(prefs.getPrefs().offline).toBe(true);
    expect(net.current()).toMatchObject({ status: 'idle', offline: true });
    expect(ids(actions, net)).toEqual(['online']);
    actions.press('online', null);
    expect(prefs.getPrefs().offline).toBe(false);
    expect(net.current()).toMatchObject({ status: 'idle', offline: false });
  });

  it('Play online is not open while the browser has no network: there, not to be pressed, and open again once it is back; Play offline always is', async () => {
    const heard = new Map<string, () => void>();
    const browser = { onLine: false };
    vi.stubGlobal('navigator', browser);
    const listen = (e: string, l: () => void) => void heard.set(e, l);
    vi.stubGlobal('window', { addEventListener: listen });
    vi.stubGlobal('document', { visibilityState: 'visible', documentElement: { classList: { toggle: () => {} } }, querySelector: () => null, addEventListener: listen });
    vi.stubGlobal('localStorage', { getItem: () => JSON.stringify({ offline: true }), setItem: () => {} });
    const net = await reload();
    const prefs = await import('./prefs');
    const actions = await import('./actions');
    expect(net.connected()).toBe(false);
    expect(actions.actionsAt(null)).toEqual([{ id: 'online', label: 'Play online', coming: true, why: 'No connection' }]);
    expect(actions.openAction(null, 'online')).toBeUndefined();
    actions.press('online', null);
    expect(prefs.getPrefs().offline).toBe(true);
    expect(net.current()).toMatchObject({ status: 'idle', offline: true });

    // The same in the lobby of a table of the window's own.
    net.create('Ada');
    await told();
    expect(actions.actionsAt(net.current().room).find((a) => a.id === 'online')).toMatchObject({ coming: true });
    actions.press('online', net.current().room);
    expect(net.current()).toMatchObject({ offline: true, room: { phase: 'lobby' } });
    expect(sockets()).toBe(0);
    net.leave();

    // The network is back: the browser says so, and it is open.
    browser.onLine = true;
    heard.get('online')!();
    expect(net.connected()).toBe(true);
    expect(actions.actionsAt(null)).toEqual([{ id: 'online', label: 'Play online' }]);
    actions.press('online', null);
    expect(prefs.getPrefs().offline).toBe(false);

    // And gone again: Play offline is what a window online is offered, and is open whatever the network.
    browser.onLine = false;
    heard.get('offline')!();
    expect(net.connected()).toBe(false);
    expect(actions.actionsAt(null)).toEqual([{ id: 'offline', label: 'Play offline' }]);
    actions.press('offline', null);
    expect(prefs.getPrefs().offline).toBe(true);
  });

  it('Play offline where a new table cannot be reached gives that table up', async () => {
    vi.useFakeTimers();
    const net = await reload();
    net.create('Ada');
    expect(net.unreachable(net.current())).toBe(false); // (still asking)
    last().closed();
    expect(net.unreachable(net.current())).toBe(true);
    net.playOffline();
    expect(net.current()).toEqual({ status: 'idle', room: null, error: null, offline: true });
    expect(net.unreachable(net.current())).toBe(false);
  });

  it('Play online in the lobby of an offline table: that table is left, and the server asked for one with the same bots; once it has dealt there is neither', async () => {
    const net = await reload();
    const prefs = await import('./prefs');
    const actions = await import('./actions');
    prefs.setPrefs({ offline: true });
    net.create('Ada');
    await told();
    net.addBot('medium');
    net.addBot('medium');
    net.addBot('fast');
    await told();
    const bots = net.current().room!.players.filter((p) => p.bot);
    net.nameBot(bots[0]!.seat!, 'Bot Zed');
    net.botBack(bots[1]!.seat!, { k: 'own', back: 'plain' });
    await told();
    expect(ids(actions, net)).toEqual(['online', 'leave']);
    const company = net.current().room!.players.flatMap((p) => (p.bot ? [{ t: 'addBot', level: p.bot, name: p.name, backs: p.look.backs }] : []));
    expect(company.map((b) => b.level).sort()).toEqual(['fast', 'medium', 'medium']);
    expect(company.map((b) => b.name)).toContain('Bot Zed');

    const lobby = net.current().room;
    const shown: (string | null)[] = [];
    const unheard = net.subscribe(() => shown.push(net.current().room?.code ?? null));
    const was = net.current();
    actions.press('online', lobby);
    expect(prefs.getPrefs().offline).toBe(false);
    // Nothing of the switch shows until the server's table is there: the offline lobby as it was, never the home page.
    expect(net.current()).toBe(was);
    expect(sockets()).toBe(1);
    last().open();
    expect(last().sent.filter((m) => m.t !== 'deck')).toEqual([expect.objectContaining({ t: 'create', name: 'Ada' }), ...company]);
    last().deliver(at('ABCD'));
    expect(net.current()).toMatchObject({ status: 'online', offline: false, room: { code: 'ABCD' } });
    expect(shown).not.toContain(null);
    unheard();
    expect(address()).toBe('?room=ABCD'); // (kept for a reload from its first snapshot, as any table of the server's)
    // A line that drops and comes back sits down again: nobody is seated twice.
    last().closed();
    net.leave();

    // Dealt, an offline table has neither; nor on its score sheet.
    prefs.setPrefs({ offline: true });
    net.create('Ada');
    await told();
    net.addBot('medium');
    net.start();
    await told();
    expect(net.current().room).toMatchObject({ phase: 'playing' });
    expect(ids(actions, net)).not.toContain('online');
    expect(ids(actions, net)).not.toContain('offline');
    const before = sockets();
    net.playOnline();
    await told();
    expect(net.current()).toMatchObject({ offline: true, room: { phase: 'playing' } });
    expect(sockets()).toBe(before);
    expect(net.returnable({ ...net.current().room!, phase: 'results' })).toBe(false);
    net.leave();
  });

  it('Play online where the server cannot be reached: the offline table goes with the line, and the window is home, told so', async () => {
    const net = await reload();
    const prefs = await import('./prefs');
    prefs.setPrefs({ offline: true });
    net.create('Ada');
    await told();
    const was = net.current();
    net.playOnline();
    expect(net.current()).toBe(was);
    last().closed();
    expect(net.current()).toEqual({ status: 'reconnecting', room: null, error: 'Cannot reach the game server. Still trying…', offline: false });
    expect(net.unreachable(net.current())).toBe(true);
    net.playOffline();
    expect(net.current()).toEqual({ status: 'idle', room: null, error: null, offline: true });
  });
});

describe('a table taken offline', () => {
  const told = async (): Promise<void> => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  };
  /** A snapshot of the table ABCD, in play, as seat 0 sees it: everyone else at it a bot. */
  const withBots = (rev = 0, extra: Partial<RoomView> = {}) => {
    const room = roomOf(inPlay([0, 1, 2], lcg(8)), 0, { clock: { ms: 4000, running: true }, ...extra });
    return { t: 'state', rev, ack: -1, room: { ...room, players: room.players.map((p) => (p.id === 0 ? { ...p, name: 'Ada' } : { ...p, name: `Bot ${p.id}`, bot: 'fast' as const })) } };
  };
  /** A window at a table of the server's where nobody else is but bots. */
  async function alone(extra: Partial<RoomView> = {}) {
    const before = sockets();
    const net = await reload();
    if (sockets() > before) FakeSocket.all.pop()!.deliver({ t: 'welcome', boot: BOOT });
    const prefs = await import('./prefs');
    net.create('Ada');
    last().open();
    const snapshot = withBots(0, extra);
    last().deliver(snapshot);
    expect(net.current()).toMatchObject({ status: 'online', offline: false });
    return { net, prefs, was: snapshot.room, token: last().sent[0]!.token as string };
  }
  const game = (net: typeof import('./net')): GameState => net.current().room!.game!;

  it('with the line up, the server is asked for it and hands it over: the window plays on at the same table, its own now, and the settings say Offline', async () => {
    const { net, prefs, was, token } = await alone();
    const { rebuild } = await import('./rebuild');
    const wire = last();
    expect(net.portable(net.current().room)).toBe(true);
    const actions = await import('./actions');
    expect(actions.tableActions(net.current().room!).map((a) => a.id)).toEqual(['pause', 'vote', 'redeal', 'stand', 'offline', 'leave']);
    actions.press('offline', net.current().room!); // (the menu's: done at once, not asked about)
    expect(wire.sent.at(-1)).toEqual({ t: 'carry' });
    // Until the server answers, nothing has changed.
    expect(net.current()).toMatchObject({ status: 'online', offline: false });
    expect(prefs.getPrefs().offline).toBe(false);
    expect(wire.shut).toBe(false);
    const statuses: string[] = [];
    net.subscribe(() => statuses.push(net.current().status));
    wire.deliver({ t: 'carried', kept: rebuild(was, token, lcg(2)) });
    expect(net.current()).toMatchObject({ offline: true, room: { code: 'ABCD' } }); // (the table stays on screen meanwhile)
    await told();
    expect(net.current()).toMatchObject({ status: 'online', error: null, offline: true, room: { code: 'ABCD', phase: 'playing', round: 1, me: 0, seat: 0, paused: null } });
    expect(net.current().room!.players.map((p) => [p.name, p.bot ?? null, p.connected])).toEqual([['Ada', null, true], ['Bot 1', 'fast', true], ['Bot 2', 'fast', true]]);
    expect(game(net).slots).toEqual(was.game!.slots);
    expect(game(net).players.map((p) => p.work.map((w) => w.cards.at(-1)))).toEqual(was.game!.players.map((p) => p.work.map((w) => w.cards.at(-1))));
    expect(statuses).not.toContain('reconnecting');
    expect(prefs.getPrefs().offline).toBe(true);
    expect(net.reach()).toEqual({ others: false, server: false });
    expect(net.portable(net.current().room)).toBe(false);
    expect(actions.tableActions(net.current().room!).map((a) => a.id)).toEqual(['pause', 'vote', 'redeal', 'leave']);
    // The server's table is done with: its socket shut, nothing of it for a reload, and no other socket ever.
    expect(wire.shut).toBe(true);
    expect(address()).toBe('');
    expect(storage.has('nertz.seat')).toBe(false);
    const had = sockets();
    // What the window does now goes to its own table.
    net.pause(true);
    await told();
    expect(net.current().room!.paused).toEqual({ by: 'player', id: 0 });
    expect(wire.sent.at(-1)).toEqual({ t: 'carry' });
    // There is no going back at the table: Online pressed, it is offline until it is left.
    prefs.setPrefs({ offline: false });
    await told();
    expect(net.current()).toMatchObject({ status: 'online', offline: true, room: { code: 'ABCD' } });
    net.leave();
    expect(net.current()).toEqual({ status: 'idle', room: null, error: null, offline: false });
    expect(sockets()).toBe(had);
  });

  it('Offline switched on in the settings takes such a table along; one that others are at stays the server\'s, as does one the server will not hand over', async () => {
    const { net, prefs } = await alone();
    prefs.setPrefs({ offline: true });
    expect(last().sent.at(-1)).toEqual({ t: 'carry' });
    expect(net.current()).toMatchObject({ status: 'online', offline: false, room: { code: 'ABCD' } });
    // (Someone came meanwhile: the server says nothing, and the table goes on as it was.)
    last().deliver(at('ABCD', 1));
    await told();
    expect(net.current()).toMatchObject({ status: 'online', offline: false, room: { code: 'ABCD' } });
    expect(net.portable(net.current().room)).toBe(false);
    const said = last().sent.length;
    net.takeOffline();
    prefs.setPrefs({ offline: false });
    prefs.setPrefs({ offline: true });
    expect(last().sent).toHaveLength(said);
    expect(last().shut).toBe(false);
  });

  it('with the line lost, the table is put back together from the last snapshot: what was in sight is where it was, what was sent and not answered is not in it, and the window stops trying the server', async () => {
    vi.useFakeTimers();
    const { net, prefs, was } = await alone();
    expect(net.send({ k: 'draw' })).toBe(true); // (never answered)
    expect(game(net).players[0]!.draw).not.toBeNull();
    last().closed();
    expect(net.current()).toMatchObject({ status: 'reconnecting', offline: false });
    expect(net.portable(net.current().room)).toBe(true);
    await vi.advanceTimersByTimeAsync(300);
    const tried = sockets();
    last().closed(); // (still no server)
    const statuses: string[] = [];
    net.subscribe(() => statuses.push(net.current().status));
    net.takeOffline();
    await vi.advanceTimersByTimeAsync(0);
    expect(statuses[0]).toBe('connecting'); // (never `online` straight out of `reconnecting`: the line is not back)
    expect(net.current()).toMatchObject({ status: 'online', error: null, offline: true, room: { code: 'ABCD', me: 0, seat: 0, paused: null, clock: { running: true } } });
    expect(prefs.getPrefs().offline).toBe(true);
    const mine = game(net).players[0]!;
    expect(mine.draw).toBeNull();
    expect(mine.stock.map((c) => c.id)).toEqual(was.game!.players[0]!.stock.map((c) => c.id));
    expect(game(net).players.map((p) => [p.nertz.at(-1), p.work.map((w) => w.cards.at(-1))])).toEqual(was.game!.players.map((p) => [p.nertz.at(-1), p.work.map((w) => w.cards.at(-1))]));
    expect(address()).toBe('');
    expect(storage.has('nertz.seat')).toBe(false);
    // Its own table: a card can be played at once, and the bots play theirs.
    expect(net.send({ k: 'draw' })).toBe(true);
    const lay = JSON.stringify(game(net).players.slice(1));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(JSON.stringify(game(net).players.slice(1))).not.toBe(lay);
    expect(sockets()).toBe(tried);
    expect(net.current()).toMatchObject({ status: 'online', offline: true });
    net.leave();
    expect(net.current()).toEqual({ status: 'idle', room: null, error: null, offline: true });
  });

  it('with the server stopped for an update, likewise: the round it stopped goes on here, and the page is not loaded anew for it', async () => {
    vi.useFakeTimers();
    const { net } = await alone();
    last().deliver(withBots(1, { paused: { by: 'update', done: false }, clock: { ms: 5000, running: false } }));
    last().closed(CLOSE_UPDATE);
    expect(net.current()).toMatchObject({ status: 'updating', room: { paused: { by: 'update', done: false } } });
    expect(net.portable(net.current().room)).toBe(true);
    net.takeOffline();
    await vi.advanceTimersByTimeAsync(0);
    expect(net.current()).toMatchObject({ status: 'online', offline: true, room: { code: 'ABCD', paused: null, clock: { running: true } } });
    expect(page.reload).not.toHaveBeenCalled();
    net.leave();
  });

  it('a round you had paused yourself is still paused by you; and a table with anyone else at it is not taken, line or no line', async () => {
    vi.useFakeTimers();
    const { net } = await alone();
    last().deliver(withBots(1, { paused: { by: 'player', id: 0 }, clock: { ms: 5000, running: false } }));
    last().closed();
    net.takeOffline();
    await vi.advanceTimersByTimeAsync(0);
    expect(net.current()).toMatchObject({ status: 'online', offline: true, room: { paused: { by: 'player', id: 0 }, clock: { ms: 5000, running: false } } });
    net.leave();

    const prefs = await import('./prefs');
    prefs.setPrefs({ offline: false });
    net.create('Ada');
    last().open();
    last().deliver(at('ABCD'));
    last().closed();
    expect(net.portable(net.current().room)).toBe(false);
    net.takeOffline();
    prefs.setPrefs({ offline: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(net.current()).toMatchObject({ status: 'reconnecting', offline: false, room: { code: 'ABCD' } });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(last().sent).toEqual([]); // (still trying the server)
    net.leave();
  });
});

describe('a page put up anew while the window was open', () => {
  /** Two starts of the server: the one this page was served by, and one put up since (an icon alone may have changed). */
  const OLD = BOOT;
  const NEW = 'registry.fly.io/nertz:deployment-new';
  /** The server tells this socket which start of it it reached, as it tells every socket first. */
  const welcome = (ws: FakeSocket, boot: string) => ws.deliver({ t: 'welcome', boot });
  /** The window comes back to the front. */
  let front: () => void;
  beforeEach(() => {
    const listeners: (() => void)[] = [];
    vi.stubGlobal('document', {
      visibilityState: 'visible',
      documentElement: { classList: { toggle: () => {} } }, // (client/prefs.ts)
      addEventListener: (_: string, fn: () => void) => void listeners.push(fn),
    });
    front = () => listeners.at(-1)!();
  });
  /** A page just loaded at home: the socket it opened to hear the server's boot has heard `boot`. */
  async function home(boot = OLD): Promise<typeof import('./net')> {
    const net = await reload();
    expect(sockets()).toBe(1);
    welcome(last(), boot);
    expect(last()).toMatchObject({ shut: true, sent: [] }); // it only listened
    return net;
  }

  it.each([
    ['leaving it', (net: typeof import('./net')) => net.leave()],
    ['sent away from it', () => last().closed(CLOSE_OVER, 'You were removed from the table by whoever deals.')],
  ])('is loaded once the window is at no table: not while it plays, and on %s', async (_, out) => {
    const net = await seated();
    welcome(last(), NEW);
    front();
    expect(page.reload).not.toHaveBeenCalled(); // at a table: it plays on with the page it has
    expect(sockets()).toBe(1); // (and does not listen apart: it has its line)
    out(net);
    expect(page.reload).toHaveBeenCalledTimes(1);
  });

  it('is loaded when the window comes back to the front at home, though only something beside the script changed', async () => {
    await home();
    front();
    expect(sockets()).toBe(2);
    welcome(last(), NEW);
    expect(last().shut).toBe(true);
    expect(page.reload).toHaveBeenCalledTimes(1);
  });

  it('is not loaded when the server is the same start: a line that dropped, or a window back at home', async () => {
    vi.useFakeTimers();
    const net = await home();
    net.create('Ada');
    welcome(last(), OLD);
    last().open();
    last().deliver(at('ABCD'));
    last().closed();
    await vi.advanceTimersByTimeAsync(300);
    welcome(last(), OLD);
    last().open();
    last().deliver(at('ABCD'));
    expect(net.current().status).toBe('online');
    net.leave();
    front();
    welcome(last(), OLD);
    expect(page.reload).not.toHaveBeenCalled();
  });

  it('does not cut short a table the window sat down at while it was listening for the server', async () => {
    const net = await home();
    front();
    const listening = last();
    net.join('ABCD', 'Ada');
    welcome(listening, NEW);
    expect(page.reload).not.toHaveBeenCalled();
    expect(net.current().status).toBe('connecting');
  });

  it.each([
    ['put up anew', NEW, 1],
    ['the same build started again', OLD, 0],
  ])('at a table it waits until the window is back there from an update the server stopped for: %s, it is loaded that many times', async (_, next, times) => {
    vi.useFakeTimers();
    const net = await seated();
    welcome(last(), OLD);
    last().closed(CLOSE_UPDATE);
    expect(net.current()).toMatchObject({ status: 'updating', room: { code: 'ABCD' }, error: null });
    await vi.advanceTimersByTimeAsync(300);
    last().closed(); // (the next server is not up yet)
    expect(net.current().status).toBe('updating');
    await vi.advanceTimersByTimeAsync(600);
    expect(sockets()).toBe(3);
    welcome(last(), next);
    last().open();
    expect(last().sent[0]).toMatchObject({ t: 'join', room: 'ABCD', name: 'Ada' });
    expect(page.reload).not.toHaveBeenCalled();
    last().deliver(at('ABCD'));
    expect(net.current()).toMatchObject({ status: 'online', room: { code: 'ABCD' } });
    expect(page.reload).toHaveBeenCalledTimes(times);
  });
});
