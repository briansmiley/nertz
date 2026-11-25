// The chat's lines as this window shows them (client/social.ts), fed by the server over a fake socket: the notice that
// a round is over waits until the table here has shown how it ended.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatEvent, ChatLine } from '../shared/chat';
import { inPlay, lcg, roomOf } from '../shared/testkit';

class FakeSocket {
  static OPEN = 1;
  static last: FakeSocket | null = null;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.last = this;
  }
  send(): void {}
  close(): void {}
  deliver(msg: unknown): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}

beforeEach(() => {
  const storage = new Map<string, string>();
  const page = { origin: 'http://localhost:5173', search: '', reload: () => {} };
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal('location', page);
  vi.stubGlobal('history', { replaceState: (_s: unknown, _t: string, url: string) => void (page.search = new URL(url, page.origin).search) });
  vi.stubGlobal('sessionStorage', { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => void storage.set(k, v), removeItem: (k: string) => void storage.delete(k) });
  vi.useFakeTimers({ toFake: ['Date'] });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** A window at a table, its chat empty. */
async function atTable() {
  vi.resetModules();
  const net = await import('./net');
  const social = await import('./social');
  net.create('Ada');
  const socket = FakeSocket.last!;
  socket.readyState = FakeSocket.OPEN;
  socket.onopen?.();
  socket.deliver({ t: 'state', rev: 0, ack: -1, room: roomOf(inPlay([0, 1], lcg(8)), 0, { code: 'ABCD' }) });
  const state = () => social.currentSocial();
  const hear = (lines: ChatLine[], history = false) => socket.deliver({ t: 'chat', lines, history });
  return { ...social, state, hear, shown: () => state().lines.map((l) => l.id), passing: () => state().passing.map((p) => [p.line.id, p.at]) };
}

let id = 0;
const line = (event: ChatEvent): ChatLine => ({ ...event, id: ++id, at: 0 });
const over = (round: number) => line({ k: 'over', round, end: 'vote', best: [{ who: 1, name: 'Bo', points: 7 }] });
const said = (text: string) => line({ k: 'said', by: { who: 1, name: 'Bo' }, text });

describe('the notice that a round is over', () => {
  it('waits while the table here has yet to show that round, and comes in its place among the lines, and over the table from then', async () => {
    const t = await atTable();
    t.setUnrevealed(3);
    vi.setSystemTime(1000);
    const a = said('close one');
    const end = over(3);
    t.hear([a]);
    t.hear([end]);
    expect(t.shown()).toEqual([a.id]);
    expect(t.passing()).toEqual([[a.id, 1000]]);
    // Said while the end plays out, and a snipe in the last instant: at once.
    vi.setSystemTime(5000);
    const b = said('gg');
    t.hear([b]);
    expect(t.shown()).toEqual([a.id, b.id]);
    // (Still the end of round 3: nothing changes.)
    t.setUnrevealed(3);
    expect(t.state().held).toEqual(end);
    // The winner is marked: it is let through, and passes over the table for as long as any line does from now, not from when it came.
    vi.setSystemTime(20000);
    t.setUnrevealed(null);
    expect(t.shown()).toEqual([a.id, end.id, b.id]);
    expect(t.passing()).toEqual([[end.id, 20000]]);
    expect(t.state().held).toBeNull();
    // And it is not held again, though a later round has the same number (the table started over).
    t.setUnrevealed(3);
    expect(t.shown()).toEqual([a.id, end.id, b.id]);
  });

  it('is shown at once where there is no end of that round to wait for', async () => {
    const t = await atTable();
    // No table in this window (or one that has shown it already).
    t.setUnrevealed(null);
    const first = over(1);
    t.hear([first]);
    expect(t.shown()).toEqual([first.id]);
    // The table here is on another round.
    t.setUnrevealed(3);
    const old = over(2);
    t.hear([old]);
    expect(t.shown()).toEqual([first.id, old.id]);
    // What the room remembers, sent to a window as it sits down.
    const end = over(3);
    t.hear([first, old, end], true);
    expect(t.shown()).toEqual([first.id, old.id, end.id]);
  });

  it('is let through if the next round is dealt before the end is shown, or the table goes', async () => {
    const t = await atTable();
    t.setUnrevealed(3);
    const end = over(3);
    t.hear([end]);
    expect(t.shown()).toEqual([]);
    t.setUnrevealed(4);
    expect(t.shown()).toEqual([end.id]);

    const u = await atTable();
    u.setUnrevealed(5);
    const five = over(5);
    u.hear([five]);
    u.setUnrevealed(null);
    expect(u.shown()).toEqual([five.id]);
  });

  it('stays held through the history sent again on a reconnect, while the table is still showing that end', async () => {
    const t = await atTable();
    t.setUnrevealed(3);
    const a = said('hi');
    const end = over(3);
    t.hear([a]);
    t.hear([end]);
    t.hear([a, end], true);
    expect(t.shown()).toEqual([a.id]);
    t.setUnrevealed(null);
    expect(t.shown()).toEqual([a.id, end.id]);
  });

  it('leaves the unread count to what people say', async () => {
    const t = await atTable();
    t.setUnrevealed(3);
    t.hear([over(3)]);
    t.setUnrevealed(null);
    expect(t.state().unread).toEqual([]);
  });
});

describe('the lines unread', () => {
  it('are those others said while the chat was closed, kept marked while it is open and let go when it is closed again', async () => {
    const t = await atTable();
    const a = said('one');
    const mine = line({ k: 'said', by: { who: 0, name: 'Ada' }, text: 'mine' });
    const b = said('two');
    t.hear([a, mine]);
    t.setOpen('voice');
    t.hear([b, over(1)]);
    expect(t.state().unread).toEqual([a.id, b.id]);
    // Open: still the same two (they are marked among the lines); what comes now is seen as it comes.
    t.setOpen('chat');
    t.hear([said('three')]);
    expect(t.state().unread).toEqual([a.id, b.id]);
    t.setOpen(null);
    expect(t.state().unread).toEqual([]);
    // (Opening the chat again from the voice slip is no closing of it.)
    const c = said('four');
    t.hear([c]);
    t.setOpen('chat');
    t.setOpen('chat');
    expect(t.state().unread).toEqual([c.id]);
  });
});
