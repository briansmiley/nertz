// The store (client/net.ts) over a fake socket: the connection, the retry, this window's session and how it ends, what
// a reload makes of it afterwards, and the page put up anew.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLOSE_OVER, CLOSE_UPDATE } from '../shared/protocol';
import { inPlay, lcg, roomOf } from '../shared/testkit';

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

/** A window that opened a table and was taken in: the server's first snapshot has come. */
async function seated(): Promise<typeof import('./net')> {
  const net = await reload();
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
    expect(net.current()).toEqual({ status: 'connecting', room: null, error: null });
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
    expect(net.current()).toEqual({ status: 'reconnecting', room: null, error: 'Cannot reach the game server. Still trying…' });
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
    net.join('WXYZ', 'Ada'); // another table
    expect(old.shut).toBe(true);
    last().open();
    expect(last().sent[0]).toMatchObject({ t: 'join', room: 'WXYZ' });
    old.deliver(at('ABCD', 5));
    old.deliver({ t: 'error', message: 'Malformed message' });
    old.closed(1005);
    vi.advanceTimersByTime(10_000);
    expect(sockets()).toBe(2);
    expect(net.current()).toEqual({ status: 'connecting', room: null, error: null });
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
    ['its seat opened in another tab or device', 'This table was opened somewhere else.'],
  ])('%s: the window goes home, says why, does not come back by itself, and a reload stays at home', async (_, reason) => {
    vi.useFakeTimers();
    const net = await seated();
    last().closed(CLOSE_OVER, reason);
    expect(net.current()).toEqual({ status: 'idle', room: null, error: reason });
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
    expect(net.current()).toEqual({ status: 'connecting', room: null, error: null });
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
    expect(net.current()).toEqual({ status: 'idle', room: null, error: null });
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
    expect(net.current()).toEqual({ status: 'idle', room: null, error: null });
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

describe('a page put up anew while the window was open', () => {
  const OLD = '/assets/index-Old1.js';
  const NEW = '/assets/index-New2.js';
  const served = (src: string) => `<!doctype html><script type="module" crossorigin src="${src}"></script>`;
  let fetched: ReturnType<typeof vi.fn>;
  /** The window comes back to the front. */
  let front: () => void;
  /** The script of the page this window runs (`mine`; null: the dev server's page), and of the page the server serves now. */
  function built(mine: string | null, theirs: string | Promise<string>): void {
    const listeners: (() => void)[] = [];
    vi.stubGlobal('document', {
      visibilityState: 'visible',
      documentElement: { classList: { toggle: () => {} } }, // (client/prefs.ts)
      querySelector: () => (mine ? { getAttribute: () => mine } : null),
      addEventListener: (_: string, fn: () => void) => void listeners.push(fn),
    });
    fetched = vi.fn(async () => ({ text: async () => served(await theirs) }));
    vi.stubGlobal('fetch', fetched);
    front = () => listeners.at(-1)!();
  }
  /** Whatever the window set going has run to its end. */
  const settled = () => new Promise((ok) => setTimeout(ok, 0));

  it.each([
    ['leaving it', (net: typeof import('./net')) => net.leave()],
    ['sent away from it', () => last().closed(CLOSE_OVER, 'You were removed from the table by whoever deals.')],
  ])('is loaded once the window is at no table: not while it plays, and on %s', async (_, out) => {
    built(OLD, NEW);
    const net = await seated();
    front();
    await settled();
    expect(fetched).not.toHaveBeenCalled(); // at a table: it plays on with the page it has
    out(net);
    await settled();
    expect(page.reload).toHaveBeenCalledTimes(1);
  });

  it('is loaded when the window comes back to the front at home', async () => {
    built(OLD, NEW);
    await reload();
    front();
    await settled();
    expect(page.reload).toHaveBeenCalledTimes(1);
  });

  it('is not loaded when it is the page the window has, and not asked for at all from the dev server', async () => {
    built(OLD, OLD);
    await reload();
    front();
    await settled();
    expect(fetched).toHaveBeenCalledTimes(1);
    expect(page.reload).not.toHaveBeenCalled();

    built(null, NEW);
    await reload();
    front();
    await settled();
    expect(fetched).not.toHaveBeenCalled();
  });

  it('does not cut short a table the window sat down at while the page was being asked for', async () => {
    let answer!: (src: string) => void;
    built(OLD, new Promise<string>((ok) => (answer = ok)));
    const net = await reload();
    front();
    net.join('ABCD', 'Ada');
    answer(NEW);
    await settled();
    expect(fetched).toHaveBeenCalledTimes(1);
    expect(page.reload).not.toHaveBeenCalled();
    expect(net.current().status).toBe('connecting');
  });

  it('is loaded at a table once the window is back there from an update the server stopped for; until then the window says that is why the line is down', async () => {
    vi.useFakeTimers();
    built(OLD, NEW);
    const net = await seated();
    last().closed(CLOSE_UPDATE);
    expect(net.current()).toMatchObject({ status: 'updating', room: { code: 'ABCD' }, error: null });
    await vi.advanceTimersByTimeAsync(300);
    expect(sockets()).toBe(2);
    last().closed(); // (the next server is not up yet)
    expect(net.current().status).toBe('updating');
    await vi.advanceTimersByTimeAsync(600);
    expect(sockets()).toBe(3);
    last().open();
    expect(last().sent[0]).toMatchObject({ t: 'join', room: 'ABCD', name: 'Ada' });
    await vi.advanceTimersByTimeAsync(0);
    expect(page.reload).not.toHaveBeenCalled();
    last().deliver(at('ABCD'));
    expect(net.current()).toMatchObject({ status: 'online', room: { code: 'ABCD' } });
    await vi.advanceTimersByTimeAsync(0);
    expect(page.reload).toHaveBeenCalledTimes(1);
  });
});
