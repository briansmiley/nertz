// Table settings end to end: the wire message, who may change them and when,
// and what the small-table rule does to the deal.
import { describe, expect, it } from 'vitest';
import { checkInvariants, deal } from '../shared/engine';
import { MAX_PLAYERS, MIN_PLAYERS, parseClientMsg } from '../shared/protocol';
import { DEFAULT_SETTINGS, parseSettings } from '../shared/settings';
import { lcg, seats, toPlay } from '../shared/testkit';
import { FakeConn, roomWith } from './testkit';
import type { Room } from './room';

describe('the small-table deal', () => {
  it('deals no face-down cards at two players, 0/0/1/2 at three and 0/1/2/3 from four up; the nertz pile is 13 either way', () => {
    for (const n of [2, 3, 4, 6]) {
      const game = deal(seats(n), lcg(n));
      const down = n === 2 ? [0, 0, 0, 0] : n === 3 ? [0, 0, 1, 2] : [0, 1, 2, 3];
      const inWork = 4 + down.reduce((a, b) => a + b, 0);
      expect(checkInvariants(game)).toBeNull();
      expect(game.players).toHaveLength(n);
      for (const p of game.players) {
        expect(p.down, `${n} players`).toEqual(down);
        expect(p.work.map((w) => w.length)).toEqual(down.map((d) => d + 1));
        expect(p.nertz).toHaveLength(13);
        expect(p.stock).toHaveLength(39 - inWork);
        expect(p.nertz.length + p.work.flat().length + p.stock.length).toBe(52);
      }
    }
  });
});

describe('the settings message', () => {
  it('is parsed into a clean patch of known options', () => {
    expect(parseClientMsg('{"t":"settings","patch":{"tapToMove":false,"cheat":1},"x":2}')).toEqual({ t: 'settings', patch: { tapToMove: false } });
    expect(parseClientMsg({ t: 'settings', patch: { tapToMove: true } })).toEqual({ t: 'settings', patch: { tapToMove: true } });
    expect(parseSettings({ tapToMove: false, fewerDown: false, x: 1 })).toEqual({ tapToMove: false });
    for (const tapToMove of ['true', 'off', 0, 1, null, undefined]) expect(parseSettings({ tapToMove })).toBeNull();
  });

  it('drops options there are no longer, whatever an older client sends', () => {
    expect(parseSettings({ fewerDown: true })).toBeNull(); // now simply the rule
    for (const centre of ['spots', 'free']) {
      expect(parseSettings({ centre })).toBeNull(); // every middle is the free one
      expect(parseClientMsg({ t: 'settings', patch: { centre, tapToMove: false } })).toEqual({ t: 'settings', patch: { tapToMove: false } });
    }
    // The stock is always dealt by clicking it: the old rule's key is passed over, whatever its value, and never spoils the rest.
    for (const stockDeal of ['drag', 'click', 'tap', true, null]) {
      expect(parseSettings({ stockDeal })).toBeNull();
      expect(parseClientMsg({ t: 'settings', patch: { stockDeal, tapToMove: false } })).toEqual({ t: 'settings', patch: { tapToMove: false } });
    }
  });

  it('is dropped when malformed', () => {
    const bad: unknown[] = [
      { t: 'settings' },
      { t: 'settings', patch: null },
      { t: 'settings', patch: [] },
      { t: 'settings', patch: 'centre' },
      { t: 'settings', patch: {} },
      { t: 'settings', patch: { unknown: true } },
      { t: 'settings', patch: { tapToMove: 'no' } },
      { t: 'settings', patch: { centre: 'spots', tapToMove: 'no' } },
      { t: 'settings', tapToMove: false },
    ];
    for (const raw of bad) expect(parseClientMsg(raw), JSON.stringify(raw)).toBeNull();
  });
});

describe('table settings in a room', () => {
  it('start out as the defaults (a card moved without dragging) and are in every view', () => {
    const { room, conns } = roomWith(2, { rng: lcg(3) });
    room.flush();
    expect(DEFAULT_SETTINGS).toEqual({ tapToMove: true });
    for (const c of conns) expect(c.room.settings).toEqual({ tapToMove: true });
  });

  it('only the host changes them, and everyone is told', () => {
    const { room, conns } = roomWith(3, { rng: lcg(3) });
    const [host, guest, other] = conns as [FakeConn, FakeConn, FakeConn];
    room.handle(guest, { t: 'settings', patch: { tapToMove: false } });
    room.flush();
    expect(room.settings.tapToMove).toBe(true);
    expect(other.room.settings.tapToMove).toBe(true);

    room.handle(host, { t: 'settings', patch: { tapToMove: false } });
    room.flush();
    expect(room.settings.tapToMove).toBe(false);
    for (const c of conns) expect(c.room.settings).toEqual({ tapToMove: false });
  });

  it('moving without dragging is the host\'s to turn off and on between rounds', () => {
    const { room, conns } = roomWith(2, { rng: lcg(3) });
    const [host, guest] = conns as [FakeConn, FakeConn];
    room.handle(guest, { t: 'settings', patch: { tapToMove: false } });
    expect(room.settings.tapToMove).toBe(true);
    room.handle(host, { t: 'settings', patch: { tapToMove: false } });
    room.flush();
    for (const c of conns) expect(c.room.settings).toEqual({ tapToMove: false });

    room.handle(host, { t: 'start' });
    room.handle(host, { t: 'settings', patch: { tapToMove: true } }); // a round is on: not now
    room.flush();
    for (const c of conns) expect(c.room).toMatchObject({ phase: 'playing', settings: { tapToMove: false } });

    const game = room.game!;
    room.game = toPlay({ ...game, players: game.players.map((p) => (p.seat === 0 ? { ...p, stock: [...p.stock, ...p.nertz], nertz: [] } : p)) });
    room.handle(host, { t: 'intent', seq: 0, intent: { k: 'nertz' } });
    expect(room.phase).toBe('results');
    room.handle(host, { t: 'settings', patch: { tapToMove: true } });
    room.flush();
    for (const c of conns) expect(c.room.settings).toEqual({ tapToMove: true });
  });

  it('a flip is one card off the stock: a client that sends flips on its own gains nothing', () => {
    const { room, conns } = roomWith(2, { rng: lcg(3) });
    const [host, guest] = conns as [FakeConn, FakeConn];
    room.handle(host, { t: 'start' });
    room.game = toPlay(room.game!);
    for (let seq = 0; seq < 4; seq++) room.handle(guest, { t: 'intent', seq, intent: { k: 'flip' } });
    expect(room.game.players[1]).toMatchObject({ waste: { length: 4 }, dealt: 1 });
    expect(checkInvariants(room.game)).toBeNull();
  });

  it('follows the dealing role: while the host is away the first connected player may change them', () => {
    const { room, conns } = roomWith(3, { rng: lcg(3) });
    const [host, guest] = conns as [FakeConn, FakeConn, FakeConn];
    room.disconnect(host);
    room.handle(guest, { t: 'settings', patch: { tapToMove: false } });
    expect(room.settings.tapToMove).toBe(false);
  });

  it('deals a small table fewer face-down cards, by how many are dealt in', () => {
    const { room, conns } = roomWith(2, { rng: lcg(3) });
    room.handle(conns[0]!, { t: 'start' });
    expect(room.game!.players.map((p) => p.down)).toEqual([[0, 0, 0, 0], [0, 0, 0, 0]]);
    expect(room.game!.players[0]!.stock).toHaveLength(35);
    expect(checkInvariants(room.game!)).toBeNull();

    const four = roomWith(4, { rng: lcg(3) });
    four.room.handle(four.conns[0]!, { t: 'start' });
    for (const p of four.room.game!.players) expect(p.down).toEqual([0, 1, 2, 3]);
  });

  it('counts the players dealt in, not the seats: two of four present get the small-table deal', () => {
    const { room, conns } = roomWith(4, { rng: lcg(3) });
    room.disconnect(conns[2]!);
    room.disconnect(conns[3]!);
    room.handle(conns[0]!, { t: 'start' });
    expect(room.game!.players).toHaveLength(2);
    for (const p of room.game!.players) expect(p.down).toEqual([0, 0, 0, 0]);
  });
});

describe('the seats at a table', () => {
  const sitting = (c: FakeConn) => c.room.players.filter((p) => p.seat !== null).map((p) => p.name);
  /** The host taps the minus or the plus `n` times, each before any snapshot comes back. */
  const tap = (room: Room, host: FakeConn, step: 1 | -1, n = 1) => {
    for (let i = 0; i < n; i++) room.handle(host, { t: 'seats', step });
  };

  it('are changed a seat at a time, by a message of its own', () => {
    expect(parseClientMsg({ t: 'seats', step: 1 })).toEqual({ t: 'seats', step: 1 });
    expect(parseClientMsg({ t: 'seats', step: -1 })).toEqual({ t: 'seats', step: -1 });
    for (const step of [0, 2, -2, 0.5, '1', null, undefined, NaN]) expect(parseClientMsg({ t: 'seats', step }), String(step)).toBeNull();
    expect(parseSettings({ seats: 4 })).toBeNull(); // not a house rule
  });

  it('are the host\'s to set: whoever comes in after the last is seated waits in the queue, and is told the table is full', () => {
    const { room, conns } = roomWith(2, { rng: lcg(3) });
    const [host, guest] = conns as [FakeConn, FakeConn];
    room.flush();
    expect(host.room.seats).toEqual({ of: MAX_PLAYERS, taken: 2 });
    tap(room, guest, -1, 7); // not theirs
    room.flush();
    expect(host.room.seats.of).toBe(MAX_PLAYERS);
    tap(room, host, -1, 7); // seven taps quicker than the snapshots: seven seats fewer
    const third = new FakeConn();
    const fourth = new FakeConn();
    room.join(third, 'C', 'tok-c', true);
    room.join(fourth, 'D', 'tok-d', true);
    room.flush();
    expect(sitting(host)).toEqual(['P0', 'P1', 'C']);
    expect(fourth.room).toMatchObject({ seat: null, seats: { of: 3, taken: 3 } });
    expect(fourth.room.players.at(-1)).toMatchObject({ name: 'D', queued: true });
    expect(room.summary()).toMatchObject({ names: ['P0', 'P1', 'C'], seats: 3 });
    room.handle(host, { t: 'addBot', level: 'medium' }); // no seat for a bot either
    room.flush();
    expect(sitting(host)).toEqual(['P0', 'P1', 'C']);

    room.handle(host, { t: 'start' });
    expect(room.game!.players).toHaveLength(3); // the three seated, not the one waiting
  });

  it('raised, the first in the queue sits down; never above the most a table seats', () => {
    const { room, conns } = roomWith(2, { rng: lcg(3) });
    const [host] = conns as [FakeConn];
    tap(room, host, -1, MAX_PLAYERS);
    const late = new FakeConn();
    room.join(late, 'Late', 'tok-late', true);
    room.flush();
    expect(late.room).toMatchObject({ seat: null, seats: { of: MIN_PLAYERS, taken: 2 } });
    tap(room, host, 1);
    room.flush();
    expect(late.room.seat).toBe(2);
    tap(room, host, 1, 20);
    room.flush();
    expect(host.room.seats.of).toBe(MAX_PLAYERS);
  });

  it('lowered past how many are seated, stop there: nobody is stood up', () => {
    const { room, conns } = roomWith(5, { rng: lcg(3) });
    const [host] = conns as [FakeConn];
    tap(room, host, -1, MAX_PLAYERS);
    room.flush();
    expect(host.room.seats).toEqual({ of: 5, taken: 5 });
    expect(sitting(host)).toHaveLength(5);
    // One leaves: lowered now, the seats stop at four.
    room.handle(conns[4]!, { t: 'leave' });
    tap(room, host, -1, MAX_PLAYERS);
    room.flush();
    expect(host.room.seats).toEqual({ of: 4, taken: 4 });
  });

  it('stand still while a round is on, and a deal over fills only the seats there are', () => {
    const { room, conns } = roomWith(2, { rng: lcg(3) });
    const [host] = conns as [FakeConn];
    tap(room, host, -1, MAX_PLAYERS);
    room.handle(host, { t: 'start' });
    tap(room, host, 1, 4);
    room.flush();
    expect(host.room.seats.of).toBe(2);
    const late = new FakeConn();
    room.join(late, 'Late', 'tok-late', true);
    room.handle(host, { t: 'redeal' });
    expect(room.game!.players).toHaveLength(2);
    room.flush();
    expect(late.room.seat).toBeNull();
  });

  it('are not held by whoever leaves while the cards are dealt: the first in the queue has theirs, and is dealt in', () => {
    const { room, conns } = roomWith(4, { rng: lcg(3) });
    const [host] = conns as [FakeConn];
    tap(room, host, -1, MAX_PLAYERS - 4);
    const late = new FakeConn();
    room.join(late, 'Late', 'tok-late', true);
    room.handle(host, { t: 'start' });
    expect(room.game!.status.at).toBe('dealing');
    expect(room.game!.players).toHaveLength(4);
    room.flush();
    expect(late.room.seat).toBeNull();

    room.handle(conns[3]!, { t: 'leave' }); // before Start
    room.flush();
    expect(late.room.seat).not.toBeNull();
    expect(sitting(host)).toEqual(['P0', 'P1', 'P2', 'Late']);
    expect(room.game!.players.map((p) => p.seat)).toContain(late.room.seat);
    expect(room.game!.players).toHaveLength(4);
    expect(host.room.seats).toEqual({ of: 4, taken: 4 });
  });

  it('given to the queue are not taken back: whoever left comes back to watch, and the table is never over its seats', () => {
    const { room, conns } = roomWith(2, { rng: lcg(3) });
    const [host, second] = conns as [FakeConn, FakeConn];
    tap(room, host, -1, MAX_PLAYERS - 2);
    const late = new FakeConn();
    room.join(late, 'Late', 'tok-late', true);
    room.handle(host, { t: 'start' });
    room.disconnect(host); // away, not gone: too few here to deal again once the seat is taken
    room.handle(second, { t: 'leave' }); // before Start
    room.flush();
    expect(late.room.seat).not.toBeNull();

    const back = new FakeConn();
    expect(room.join(back, 'P1', 'tok-0001')).toBeNull();
    room.flush();
    expect(back.room.seat).toBeNull();
    expect(back.room.seats).toEqual({ of: 2, taken: 2 });
    expect(back.room.me).not.toBe(1); // someone new: the seat with P1's cards in it is their dead hand, not theirs
  });

  it('are not taken back even while free: whoever left mid-round comes back to watch, their cards still lying where they were', () => {
    const { room, conns } = roomWith(3, { rng: lcg(3) });
    const [host, , third] = conns as [FakeConn, FakeConn, FakeConn];
    room.handle(host, { t: 'start' });
    room.flush();
    room.handle(third, { t: 'leave' });
    room.flush();
    expect(host.room.seats).toEqual({ of: MAX_PLAYERS, taken: 2 });

    const back = new FakeConn();
    expect(room.join(back, 'P2', 'tok-0002')).toBeNull();
    room.flush();
    expect(back.room.seat).toBeNull();
    expect(back.room.me).not.toBe(2);
    expect(room.game!.players.map((p) => p.seat)).toEqual([0, 1, 2]); // the round goes on with their cards in it
  });
});
