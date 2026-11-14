// Table settings end to end: the wire message, who may change them and when,
// and what the small-table rule does to the deal.
import { describe, expect, it } from 'vitest';
import { checkInvariants, deal, finishDeal, openPlay, startCountdown } from '../shared/engine';
import { parseClientMsg, type ServerMsg } from '../shared/protocol';
import { DEFAULT_SETTINGS, parseSettings } from '../shared/settings';
import type { RoomView } from '../shared/types';
import { Room, type Conn } from './room';

function seeded(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
}

class FakeConn implements Conn {
  last: RoomView | null = null;
  send(msg: ServerMsg): void {
    if (msg.t === 'state') this.last = JSON.parse(JSON.stringify(msg.room)) as RoomView;
  }
  close(): void {}
}

function roomWith(n: number): { room: Room; conns: FakeConn[] } {
  const room = new Room('TEST', { rng: seeded(3), schedule: () => {} });
  const conns = Array.from({ length: n }, (_, i) => {
    const conn = new FakeConn();
    expect(room.join(conn, `P${i}`, `tok-000${i}`, true)).toBeNull();
    return conn;
  });
  return { room, conns };
}

const seats = (n: number) => Array.from({ length: n }, (_, i) => i);

describe('the small-table deal', () => {
  it('deals no face-down cards at two players, 0/0/1/2 at three and 0/1/2/3 from four up; the nertz pile is 13 either way', () => {
    for (const n of [2, 3, 4, 6]) {
      const game = deal(seats(n), seeded(n));
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
    expect(parseClientMsg('{"t":"settings","patch":{"stockDeal":"drag","cheat":1},"x":2}')).toEqual({ t: 'settings', patch: { stockDeal: 'drag' } });
    expect(parseClientMsg({ t: 'settings', patch: { stockDeal: 'click' } })).toEqual({ t: 'settings', patch: { stockDeal: 'click' } });
    expect(parseSettings({ stockDeal: 'drag', fewerDown: false, x: 1 })).toEqual({ stockDeal: 'drag' });
    for (const stockDeal of ['DRAG', 'tap', true, 1, null, undefined]) expect(parseSettings({ stockDeal })).toBeNull();
    expect(parseClientMsg({ t: 'settings', patch: { tapToMove: false } })).toEqual({ t: 'settings', patch: { tapToMove: false } });
    expect(parseSettings({ tapToMove: true, stockDeal: 'drag' })).toEqual({ tapToMove: true, stockDeal: 'drag' });
    for (const tapToMove of ['true', 'off', 0, 1, null, undefined]) expect(parseSettings({ tapToMove })).toBeNull();
  });

  it('drops options there are no longer, whatever an older client sends', () => {
    expect(parseSettings({ fewerDown: true })).toBeNull(); // now simply the rule
    for (const centre of ['spots', 'free']) {
      expect(parseSettings({ centre })).toBeNull(); // every middle is the free one
      expect(parseClientMsg({ t: 'settings', patch: { centre, stockDeal: 'drag' } })).toEqual({ t: 'settings', patch: { stockDeal: 'drag' } });
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
      { t: 'settings', patch: { stockDeal: 'tap' } },
      { t: 'settings', patch: { stockDeal: true } },
      { t: 'settings', patch: { stockDeal: null } },
      { t: 'settings', patch: { centre: 'spots', stockDeal: 'CLICK' } },
      { t: 'settings', patch: { tapToMove: 'no' } },
      { t: 'settings', patch: { tapToMove: false, stockDeal: 'tap' } },
      { t: 'settings', stockDeal: 'drag' },
    ];
    for (const raw of bad) expect(parseClientMsg(raw), JSON.stringify(raw)).toBeNull();
  });
});

describe('table settings in a room', () => {
  it('start out as the defaults (the stock dealt by clicking, a card moved without dragging) and are in every view', () => {
    const { room, conns } = roomWith(2);
    room.flush();
    expect(DEFAULT_SETTINGS).toEqual({ stockDeal: 'click', tapToMove: true });
    for (const c of conns) expect(c.last!.settings).toEqual({ stockDeal: 'click', tapToMove: true });
  });

  it('only the host changes them, and everyone is told', () => {
    const { room, conns } = roomWith(3);
    const [host, guest, other] = conns as [FakeConn, FakeConn, FakeConn];
    room.handle(guest, { t: 'settings', patch: { stockDeal: 'drag' } });
    room.flush();
    expect(room.settings.stockDeal).toBe('click');
    expect(other.last!.settings.stockDeal).toBe('click');

    room.handle(host, { t: 'settings', patch: { stockDeal: 'drag' } });
    room.flush();
    expect(room.settings.stockDeal).toBe('drag');
    for (const c of conns) expect(c.last!.settings).toEqual({ stockDeal: 'drag', tapToMove: true });
  });

  it('moving without dragging is the host\'s to turn off and on between rounds, and leaves the other options as they are', () => {
    const { room, conns } = roomWith(2);
    const [host, guest] = conns as [FakeConn, FakeConn];
    room.handle(guest, { t: 'settings', patch: { tapToMove: false } });
    expect(room.settings.tapToMove).toBe(true);
    room.handle(host, { t: 'settings', patch: { tapToMove: false } });
    room.flush();
    for (const c of conns) expect(c.last!.settings).toEqual({ stockDeal: 'click', tapToMove: false });

    room.handle(host, { t: 'start' });
    room.handle(host, { t: 'settings', patch: { tapToMove: true } }); // a round is on: not now
    room.flush();
    for (const c of conns) expect(c.last!).toMatchObject({ phase: 'playing', settings: { tapToMove: false } });

    const game = room.game!;
    room.game = openPlay(startCountdown(finishDeal({ ...game, players: game.players.map((p) => (p.seat === 0 ? { ...p, stock: [...p.stock, ...p.nertz], nertz: [] } : p)) })));
    room.handle(host, { t: 'intent', seq: 0, intent: { k: 'nertz' } });
    expect(room.phase).toBe('results');
    room.handle(host, { t: 'settings', patch: { tapToMove: true } });
    room.flush();
    for (const c of conns) expect(c.last!.settings).toEqual({ stockDeal: 'click', tapToMove: true });
  });

  it('how the stock is dealt is for the host to choose, between rounds: the round on the table keeps the way it was dealt under', () => {
    const { room, conns } = roomWith(2);
    const [host, guest] = conns as [FakeConn, FakeConn];
    room.handle(guest, { t: 'settings', patch: { stockDeal: 'drag' } });
    expect(room.settings.stockDeal).toBe('click');
    room.handle(host, { t: 'start' });
    room.handle(host, { t: 'settings', patch: { stockDeal: 'drag' } }); // a round is on: not now
    room.flush();
    expect(room.settings.stockDeal).toBe('click');
    for (const c of conns) expect(c.last!).toMatchObject({ phase: 'playing', settings: { stockDeal: 'click' } });

    // The rule only chooses the gesture. Whatever it says, an intent is one card: a client that sends flips on its own gains nothing.
    const game = room.game!;
    room.game = openPlay(startCountdown(finishDeal({ ...game, players: game.players.map((p) => (p.seat === 0 ? { ...p, stock: [...p.stock, ...p.nertz], nertz: [] } : p)) })));
    for (let seq = 0; seq < 4; seq++) room.handle(guest, { t: 'intent', seq, intent: { k: 'flip' } });
    expect(room.game.players[1]).toMatchObject({ waste: { length: 4 }, dealt: 1 });

    room.handle(host, { t: 'intent', seq: 0, intent: { k: 'nertz' } });
    expect(room.phase).toBe('results');
    room.handle(guest, { t: 'settings', patch: { stockDeal: 'drag' } }); // still not the guest's
    expect(room.settings.stockDeal).toBe('click');
    room.handle(host, { t: 'settings', patch: { stockDeal: 'drag' } });
    room.handle(host, { t: 'start' });
    room.flush();
    for (const c of conns) expect(c.last!).toMatchObject({ phase: 'playing', round: 2, settings: { stockDeal: 'drag' } });
    room.game = openPlay(startCountdown(finishDeal(room.game!)));
    for (let seq = 4; seq < 8; seq++) room.handle(guest, { t: 'intent', seq, intent: { k: 'flip' } });
    expect(room.game.players[1]).toMatchObject({ waste: { length: 4 }, dealt: 1 }); // the same one card per intent
    expect(checkInvariants(room.game)).toBeNull();
  });

  it('follows the dealing role: while the host is away the first connected player may change them', () => {
    const { room, conns } = roomWith(3);
    const [host, guest] = conns as [FakeConn, FakeConn, FakeConn];
    room.disconnect(host);
    room.handle(guest, { t: 'settings', patch: { stockDeal: 'drag' } });
    expect(room.settings.stockDeal).toBe('drag');
  });

  it('deals a small table fewer face-down cards, by how many are dealt in', () => {
    const { room, conns } = roomWith(2);
    room.handle(conns[0]!, { t: 'start' });
    expect(room.game!.players.map((p) => p.down)).toEqual([[0, 0, 0, 0], [0, 0, 0, 0]]);
    expect(room.game!.players[0]!.stock).toHaveLength(35);
    expect(checkInvariants(room.game!)).toBeNull();

    const four = roomWith(4);
    four.room.handle(four.conns[0]!, { t: 'start' });
    for (const p of four.room.game!.players) expect(p.down).toEqual([0, 1, 2, 3]);
  });

  it('counts the players dealt in, not the seats: two of four present get the small-table deal', () => {
    const { room, conns } = roomWith(4);
    room.disconnect(conns[2]!);
    room.disconnect(conns[3]!);
    room.handle(conns[0]!, { t: 'start' });
    expect(room.game!.players).toHaveLength(2);
    for (const p of room.game!.players) expect(p.down).toEqual([0, 0, 0, 0]);
  });
});
