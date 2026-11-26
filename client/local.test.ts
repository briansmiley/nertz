// The table of a window that plays offline (client/local.ts): the server's own room behind a line, spoken to as the
// store speaks to any line.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLOSE_OVER, type ClientMsg, type ServerMsg } from '../shared/protocol';
import { dragsOn } from '../shared/engine';
import { lcg } from '../shared/testkit';
import type { RoomView } from '../shared/types';
import { Room } from '../server/room';
import { FakeConn, startRound } from '../server/testkit';
import { seeded, wire } from '../shared/testkit';
import { local, type Carried } from './local';

/** A window on a local line: everything it heard, and the table as it last saw it. */
function dial(carried?: Carried) {
  const heard: ServerMsg[] = [];
  const closed: { code: number; reason: string }[] = [];
  let opened = 0;
  const line = local(carried)({ open: () => void opened++, message: (text) => void heard.push(JSON.parse(text) as ServerMsg), close: (code, reason) => void closed.push({ code, reason }) });
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
/** The bots at the table, by how quick they are. */
const bots = (room: RoomView): string[] => room.players.flatMap((p) => (p.bot ? [p.bot] : [])).sort();
/** A window at the table it opened. */
async function seated() {
  const w = dial();
  await settled();
  w.say({ t: 'create', name: 'Ada', token: 'a'.repeat(32) });
  await settled();
  return w;
}

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

  it('opens a table of its own: you deal, nobody else is at it, and it has neither chat nor voice', async () => {
    const w = await seated();
    const room = w.room()!;
    const me = room.players.find((p) => p.id === room.me)!;
    expect(me).toMatchObject({ name: 'Ada', isHost: true, connected: true });
    expect(room.seat).toBe(me.seat);
    expect(room.players).toEqual([me]);
    expect(room.phase).toBe('lobby');
    expect(w.heard.findLast((m) => m.t === 'social')).toMatchObject({ text: false, voice: false, inVoice: [] });
    // Alone, there is nobody to deal to; with a bot added, there is.
    w.say({ t: 'start' });
    await settled();
    expect(w.room()!.phase).toBe('lobby');
    w.say({ t: 'addBot', level: 'medium' });
    w.say({ t: 'start' });
    await settled();
    expect(w.room()!.phase).toBe('playing');
    w.line.close();
  });

  it('is spoken to as the server is: a ping is answered, nonsense is complained of, and what the window may do at a table it may do here', async () => {
    const w = await seated();
    w.say({ t: 'ping', at: 12.5 });
    w.line.send('nonsense');
    w.say({ t: 'addBot', level: 'medium' });
    w.say({ t: 'addBot', level: 'fast' });
    w.say({ t: 'addBot', level: 'slow' });
    await settled();
    w.say({ t: 'removeBot', seat: w.room()!.players.find((p) => p.bot === 'medium')!.seat! });
    await settled();
    expect(w.heard).toContainEqual({ t: 'pong', at: 12.5 });
    expect(w.heard).toContainEqual({ t: 'error', message: 'Malformed message' });
    expect(bots(w.room()!)).toEqual(['fast', 'slow']);
  });

  it('opens with nobody but you, whatever bots the last table had', async () => {
    const first = await seated();
    first.say({ t: 'addBot', level: 'fast' });
    first.say({ t: 'addBot', level: 'slow' });
    await settled();
    expect(bots(first.room()!)).toEqual(['fast', 'slow']);
    first.say({ t: 'leave' });
    first.line.close();
    expect(bots((await seated()).room()!)).toEqual([]);
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
    for (let i = 0; i < 3; i++) w.say({ t: 'addBot', level: 'medium' });
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
    expect(w.room()!.lastRound!.scores).toHaveLength(4);
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
    w.say({ t: 'addBot', level: 'medium' });
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

describe('a table carried to a local line', () => {
  const TOKEN = 'a'.repeat(32);
  /** Ada at a table of the server's with two bots, a round in play; and the server's router to it. */
  function served() {
    const room = new Room('WXYZ', { rng: seeded(4), schedule: () => {} });
    const ada = new FakeConn();
    room.join(ada, 'Ada', TOKEN, true);
    room.handle(ada, { t: 'addBot', level: 'fast' });
    room.handle(ada, { t: 'addBot', level: 'slow' });
    room.handle(ada, { t: 'botName', seat: 1, name: 'Babbage' });
    startRound(room, ada);
    vi.advanceTimersByTime(6000);
    room.flush();
    return { room, ada };
  }
  /** The window sits back down at the table it carried here. */
  async function sat(carried: Carried) {
    const w = dial(carried);
    await vi.advanceTimersByTimeAsync(0);
    w.say({ t: 'join', room: carried.kept.code, name: 'Ada', token: TOKEN });
    await vi.advanceTimersByTimeAsync(0);
    return w;
  }
  beforeEach(() => void vi.useFakeTimers());

  it('is the same table, come to by its code: your seat, the bots and their names, the scores and the cards; and its round goes on', async () => {
    const { room, ada } = served();
    const was = ada.room;
    const kept = wire(room.carried(ada)!);
    const w = await sat({ kept, paused: false });
    const now = w.room()!;
    expect(now).toMatchObject({ code: 'WXYZ', phase: 'playing', round: 1, me: was.me, seat: was.seat, paused: null, game: { status: { at: 'play' } } });
    expect(now.players).toEqual(was.players);
    expect(now.players.map((p) => p.name)).toEqual(['Ada', 'Babbage', 'Bot Bix']);
    expect(now.game!.slots).toEqual(was.game!.slots);
    expect(now.game!.players.map((p) => p.nertz.at(-1))).toEqual(was.game!.players.map((p) => p.nertz.at(-1)));
    expect(now.clock).toMatchObject({ running: true });
    expect(now.clock!.ms).toBeGreaterThanOrEqual(was.clock!.ms);
    expect(w.heard.findLast((m) => m.t === 'social')).toMatchObject({ text: false, voice: false });
    const lay = JSON.stringify(now.game);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(JSON.stringify(w.room()!.game)).not.toBe(lay); // (the bots play on)
    w.say({ t: 'leave' });
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a round you had paused is paused still, by you; one that only stood still for the handover is not', async () => {
    const { room, ada } = served();
    room.handle(ada, { t: 'pause', on: true });
    const w = await sat({ kept: wire(room.carried(ada)!), paused: true });
    expect(w.room()!.paused).toEqual({ by: 'player', id: w.room()!.me });
    const lay = JSON.stringify(w.room()!.game);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(JSON.stringify(w.room()!.game)).toBe(lay);
    w.say({ t: 'pause', on: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(w.room()!.paused).toBeNull();
    w.line.close();
  });

  it('carried between rounds, the next round is dealt here; and no other table is to be found', async () => {
    const { room, ada } = served();
    room.handle(ada, { t: 'intent', seq: 0, intent: { k: 'end', on: true } });
    room.flush();
    const was = ada.room;
    const kept = wire(room.carried(ada)!);
    const w = await sat({ kept, paused: false });
    expect(w.room()).toMatchObject({ phase: 'results', round: 1, paused: null, lastRound: was.lastRound });
    w.say({ t: 'start' });
    await vi.advanceTimersByTimeAsync(0);
    expect(w.room()).toMatchObject({ phase: 'playing', round: 2 });
    w.line.close();

    const lost = dial({ kept, paused: false });
    await vi.advanceTimersByTimeAsync(0);
    lost.say({ t: 'join', room: 'ABCD', name: 'Ada', token: TOKEN });
    await vi.advanceTimersByTimeAsync(0);
    expect(lost.closed).toEqual([{ code: CLOSE_OVER, reason: 'Table ABCD not found.' }]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
