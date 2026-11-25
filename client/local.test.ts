// The table of a window that plays offline (client/local.ts): the server's own room behind a line, spoken to as the
// store speaks to any line.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLOSE_OVER, type ClientMsg, type ServerMsg } from '../shared/protocol';
import { dragsOn } from '../shared/engine';
import { lcg } from '../shared/testkit';
import type { RoomView } from '../shared/types';
import { COMPANY, local } from './local';

/** A window on a local line: everything it heard, and the table as it last saw it. */
function dial() {
  const heard: ServerMsg[] = [];
  const closed: { code: number; reason: string }[] = [];
  let opened = 0;
  const line = local({ open: () => void opened++, message: (text) => void heard.push(JSON.parse(text) as ServerMsg), close: (code, reason) => void closed.push({ code, reason }) });
  return {
    line,
    heard,
    closed,
    opened: () => opened,
    say: (msg: ClientMsg) => line.send(JSON.stringify(msg)),
    room: (): RoomView | undefined => heard.findLast((m) => m.t === 'state')?.room,
  };
}
/** Everything said so far has been heard. */
const settled = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
/** A window at the table it opened. */
async function seated() {
  const w = dial();
  await settled();
  w.say({ t: 'create', name: 'Ada', token: 'a'.repeat(32) });
  await settled();
  return w;
}

/** What the browser keeps for this page: here, the bots the last table had. Nothing, as each test begins. */
let storage: Map<string, string>;
beforeEach(() => {
  storage = new Map();
  vi.stubGlobal('localStorage', { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => void storage.set(k, v) });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('a local line', () => {
  it('opens later, never from inside the dial, and takes nothing before it is open', async () => {
    const w = dial();
    expect(w.line.open).toBe(false);
    expect(w.opened()).toBe(0);
    w.say({ t: 'create', name: 'Ada', token: 'a'.repeat(32) });
    await settled();
    expect(w.line.open).toBe(true);
    expect(w.opened()).toBe(1);
    expect(w.heard).toEqual([]);
  });

  it("asks nothing of the window's own timers that a browser would refuse: they are called bare, never as the room's", async () => {
    const real = queueMicrotask;
    vi.stubGlobal('queueMicrotask', function (this: unknown, fn: () => void) {
      if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation');
      real(fn);
    });
    const w = await seated();
    expect(w.room()).toMatchObject({ phase: 'lobby' });
  });

  it('opens a table of its own: you deal, its company is seated, and it has neither chat nor voice', async () => {
    const w = await seated();
    const room = w.room()!;
    const me = room.players.find((p) => p.id === room.me)!;
    expect(me).toMatchObject({ name: 'Ada', isHost: true, connected: true });
    expect(room.seat).toBe(me.seat);
    expect(room.players.filter((p) => p.bot).map((p) => p.bot)).toEqual([...COMPANY]);
    expect(room.phase).toBe('lobby');
    expect(w.heard.findLast((m) => m.t === 'social')).toMatchObject({ text: false, voice: false, inVoice: [] });
  });

  it('is spoken to as the server is: a ping is answered, nonsense is complained of, and what the window may do at a table it may do here', async () => {
    const w = await seated();
    w.say({ t: 'ping', at: 12.5 });
    w.line.send('nonsense');
    w.say({ t: 'removeBot', seat: w.room()!.players.find((p) => p.bot)!.seat! });
    w.say({ t: 'addBot', level: 'fast' });
    w.say({ t: 'addBot', level: 'slow' });
    await settled();
    expect(w.heard).toContainEqual({ t: 'pong', at: 12.5 });
    expect(w.heard).toContainEqual({ t: 'error', message: 'Malformed message' });
    expect(w.room()!.players.filter((p) => p.bot).map((p) => p.bot).sort()).toEqual(['fast', 'medium', 'medium', 'slow']);
  });

  it('opens with the bots the last table had (how many, and how quick): none at all is not remembered', async () => {
    const first = await seated();
    const bots = () => first.room()!.players.filter((p) => p.bot);
    first.say({ t: 'removeBot', seat: bots()[0]!.seat! });
    first.say({ t: 'addBot', level: 'fast' });
    first.say({ t: 'addBot', level: 'slow' });
    await settled();
    first.say({ t: 'leave' });
    first.line.close();
    const levels = async () => (await seated()).room()!.players.flatMap((p) => (p.bot ? [p.bot] : [])).sort();
    expect(await levels()).toEqual(['fast', 'medium', 'medium', 'slow']);

    const emptied = await seated();
    for (const p of emptied.room()!.players.filter((p) => p.bot)) emptied.say({ t: 'removeBot', seat: p.seat! });
    await settled();
    expect(emptied.room()!.players.filter((p) => p.bot)).toEqual([]);
    expect(await levels()).toEqual(['fast', 'medium', 'medium', 'slow']);

    storage.set('nertz.company', '["fast","nonsense",7]'); // (whatever is kept there: only what a bot can be)
    expect(await levels()).toEqual(['fast']);
  });

  it('has no table but the one it opens: one asked for by its code is not found, and nonsense for a hello ends it', async () => {
    const asked = dial();
    await settled();
    asked.say({ t: 'join', room: 'ABCD', name: 'Ada', token: 'a'.repeat(32) });
    await settled();
    expect(asked.closed).toEqual([{ code: CLOSE_OVER, reason: 'Table ABCD not found.' }]);
    expect(asked.line.open).toBe(false);

    const odd = dial();
    await settled();
    odd.line.send('nonsense');
    await settled();
    expect(odd.closed).toEqual([{ code: CLOSE_OVER, reason: 'Malformed message' }]);
  });

  it('plays rounds through with nobody but its bots, one after another, and is gone with its timers when the window leaves', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockImplementation(lcg(5)); // (the same cards and the same bots every time)
    const w = await seated();
    let seq = 0;
    /** Deals, starts, and lets the bots play until the round is scored. You play nothing: you say you are stuck when they all are, and once that has dragged on, vote to end it (yours is the only vote). */
    const playRound = async (): Promise<void> => {
      w.say({ t: 'start' });
      for (let i = 0; i < 100 && w.room()!.game?.status.at !== 'ready'; i++) await vi.advanceTimersByTimeAsync(100);
      w.say({ t: 'go' });
      for (let i = 0; i < 3000 && w.room()!.phase !== 'results'; i++) {
        const game = w.room()!.game!;
        const me = game.players.find((p) => p.seat === w.room()!.seat)!;
        if (game.status.at === 'play' && dragsOn(game)) w.say({ t: 'intent', seq: ++seq, intent: { k: 'end', on: true } });
        else if (game.status.at === 'play' && !me.stuck) w.say({ t: 'intent', seq: ++seq, intent: { k: 'stuck', on: true } });
        await vi.advanceTimersByTimeAsync(1000);
      }
    };
    await playRound();
    expect(w.room()).toMatchObject({ phase: 'results', round: 1 });
    expect(w.room()!.lastRound!.scores).toHaveLength(1 + COMPANY.length);
    await playRound();
    expect(w.room()).toMatchObject({ phase: 'results', round: 2 });

    w.say({ t: 'start' });
    await vi.advanceTimersByTimeAsync(100);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    w.say({ t: 'leave' });
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('closed by the window, it says nothing more and keeps no timer', async () => {
    vi.useFakeTimers();
    const w = await seated();
    w.say({ t: 'start' });
    await vi.advanceTimersByTimeAsync(100);
    const had = w.heard.length;
    w.say({ t: 'ping' });
    w.line.close();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(w.heard).toHaveLength(had);
    expect(w.closed).toEqual([]);
    expect(w.line.open).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
