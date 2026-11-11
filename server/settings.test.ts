// Table settings end to end: the wire message, who may change them and when,
// and what the small-table rule does to the deal.
import { describe, expect, it } from 'vitest';
import { checkInvariants, deal, finishDeal } from '../shared/engine';
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
    expect(room.join(conn, `P${i}`, `tok-000${i}`)).toBeNull();
    return conn;
  });
  return { room, conns };
}

const seats = (n: number) => Array.from({ length: n }, (_, i) => i);

describe('the small-table deal', () => {
  it('deals 0/0/1/2 face-down below four players and 0/1/2/3 from four up; the nertz pile is 13 either way', () => {
    for (const n of [2, 3, 4, 6]) {
      for (const fewerDown of [false, true]) {
        const game = deal(seats(n), seeded(n), { fewerDown });
        const small = fewerDown && n < 4;
        expect(checkInvariants(game)).toBeNull();
        expect(game.players).toHaveLength(n);
        for (const p of game.players) {
          expect(p.down, `${n} players, fewerDown ${fewerDown}`).toEqual(small ? [0, 0, 1, 2] : [0, 1, 2, 3]);
          expect(p.work.map((w) => w.length)).toEqual(small ? [1, 1, 2, 3] : [1, 2, 3, 4]);
          expect(p.nertz).toHaveLength(13);
          expect(p.stock).toHaveLength(small ? 32 : 29);
          expect(p.nertz.length + p.work.flat().length + p.stock.length).toBe(52);
        }
      }
    }
  });

  it('is the standard deal when the rule is not asked for', () => {
    expect(deal(seats(2), seeded(1))).toEqual(deal(seats(2), seeded(1), { fewerDown: false }));
    expect(deal(seats(2), seeded(1)).players[0]!.down).toEqual([0, 1, 2, 3]);
  });
});

describe('the settings message', () => {
  it('is parsed into a clean patch of known options', () => {
    expect(parseClientMsg({ t: 'settings', patch: { fewerDown: false } })).toEqual({ t: 'settings', patch: { fewerDown: false } });
    expect(parseClientMsg('{"t":"settings","patch":{"fewerDown":true,"cheat":1},"x":2}')).toEqual({ t: 'settings', patch: { fewerDown: true } });
    expect(parseSettings({ fewerDown: true })).toEqual({ fewerDown: true });
    expect(parseClientMsg({ t: 'settings', patch: { stockDeal: 'click' } })).toEqual({ t: 'settings', patch: { stockDeal: 'click' } });
    expect(parseSettings({ stockDeal: 'drag', fewerDown: false, x: 1 })).toEqual({ stockDeal: 'drag', fewerDown: false });
  });

  it('is dropped when malformed', () => {
    const bad: unknown[] = [
      { t: 'settings' },
      { t: 'settings', patch: null },
      { t: 'settings', patch: [] },
      { t: 'settings', patch: 'fewerDown' },
      { t: 'settings', patch: {} },
      { t: 'settings', patch: { unknown: true } },
      { t: 'settings', patch: { fewerDown: 1 } },
      { t: 'settings', patch: { fewerDown: 'true' } },
      { t: 'settings', patch: { fewerDown: null } },
      { t: 'settings', patch: { stockDeal: 'tap' } },
      { t: 'settings', patch: { stockDeal: true } },
      { t: 'settings', patch: { stockDeal: null } },
      { t: 'settings', patch: { fewerDown: true, stockDeal: 'CLICK' } },
      { t: 'settings', fewerDown: false },
    ];
    for (const raw of bad) expect(parseClientMsg(raw), JSON.stringify(raw)).toBeNull();
  });
});

describe('table settings in a room', () => {
  it('start out as the defaults (small-table rule on, the stock dealt by dragging) and are in every view', () => {
    const { room, conns } = roomWith(2);
    room.flush();
    expect(DEFAULT_SETTINGS).toEqual({ fewerDown: true, stockDeal: 'drag' });
    for (const c of conns) expect(c.last!.settings).toEqual({ fewerDown: true, stockDeal: 'drag' });
  });

  it('only the host changes them, and everyone is told', () => {
    const { room, conns } = roomWith(3);
    const [host, guest, other] = conns as [FakeConn, FakeConn, FakeConn];
    room.handle(guest, { t: 'settings', patch: { fewerDown: false } });
    room.flush();
    expect(room.settings.fewerDown).toBe(true);
    expect(other.last!.settings.fewerDown).toBe(true);

    room.handle(host, { t: 'settings', patch: { fewerDown: false } });
    room.flush();
    expect(room.settings.fewerDown).toBe(false);
    for (const c of conns) expect(c.last!.settings).toEqual({ fewerDown: false, stockDeal: 'drag' });
  });

  it('how the stock is dealt is for the host to choose, between rounds: the round on the table keeps the way it was dealt under', () => {
    const { room, conns } = roomWith(2);
    const [host, guest] = conns as [FakeConn, FakeConn];
    room.handle(guest, { t: 'settings', patch: { stockDeal: 'click' } });
    expect(room.settings.stockDeal).toBe('drag');
    room.handle(host, { t: 'start' });
    room.handle(host, { t: 'settings', patch: { stockDeal: 'click' } }); // a round is on: not now
    room.flush();
    expect(room.settings.stockDeal).toBe('drag');
    for (const c of conns) expect(c.last!).toMatchObject({ phase: 'playing', settings: { stockDeal: 'drag' } });

    // The rule only chooses the gesture. Whatever it says, an intent is one card: a client that sends flips on its own gains nothing.
    const game = room.game!;
    room.game = finishDeal({ ...game, players: game.players.map((p) => (p.seat === 0 ? { ...p, stock: [...p.stock, ...p.nertz], nertz: [] } : p)) });
    for (let seq = 0; seq < 4; seq++) room.handle(guest, { t: 'intent', seq, intent: { k: 'flip' } });
    expect(room.game.players[1]).toMatchObject({ waste: { length: 4 }, dealt: 1 });

    room.handle(host, { t: 'intent', seq: 0, intent: { k: 'nertz' } });
    expect(room.phase).toBe('results');
    room.handle(guest, { t: 'settings', patch: { stockDeal: 'click' } }); // still not the guest's
    expect(room.settings.stockDeal).toBe('drag');
    room.handle(host, { t: 'settings', patch: { stockDeal: 'click' } });
    room.handle(host, { t: 'start' });
    room.flush();
    for (const c of conns) expect(c.last!).toMatchObject({ phase: 'playing', round: 2, settings: { fewerDown: true, stockDeal: 'click' } });
    room.game = finishDeal(room.game!);
    for (let seq = 4; seq < 8; seq++) room.handle(guest, { t: 'intent', seq, intent: { k: 'flip' } });
    expect(room.game.players[1]).toMatchObject({ waste: { length: 4 }, dealt: 1 }); // the same one card per intent
    expect(checkInvariants(room.game)).toBeNull();
  });

  it('follows the dealing role: while the host is away the first connected player may change them', () => {
    const { room, conns } = roomWith(3);
    const [host, guest] = conns as [FakeConn, FakeConn, FakeConn];
    room.disconnect(host);
    room.handle(guest, { t: 'settings', patch: { fewerDown: false } });
    expect(room.settings.fewerDown).toBe(false);
  });

  it('apply to the next deal: 0/0/1/2 at two players by default, 0/1/2/3 once switched off, and never below four players', () => {
    const { room, conns } = roomWith(2);
    const [host, guest] = conns as [FakeConn, FakeConn];
    room.handle(host, { t: 'start' });
    expect(room.game!.players.map((p) => p.down)).toEqual([[0, 0, 1, 2], [0, 0, 1, 2]]);
    expect(room.game!.players[0]!.stock).toHaveLength(32);

    // Not while a round is on: the cards on the table were dealt under the old rule.
    room.handle(host, { t: 'settings', patch: { fewerDown: false } });
    expect(room.settings.fewerDown).toBe(true);

    // End the round, then change it on the score sheet.
    const game = room.game!;
    room.game = finishDeal({ ...game, players: game.players.map((p) => (p.seat === 0 ? { ...p, stock: [...p.stock, ...p.nertz], nertz: [] } : p)) });
    room.handle(host, { t: 'intent', seq: 0, intent: { k: 'nertz' } });
    expect(room.phase).toBe('results');
    room.handle(guest, { t: 'settings', patch: { fewerDown: false } }); // still not the guest's to change
    expect(room.settings.fewerDown).toBe(true);
    room.handle(host, { t: 'settings', patch: { fewerDown: false } });
    room.handle(host, { t: 'start' });
    expect(room.game!.players.map((p) => p.down)).toEqual([[0, 1, 2, 3], [0, 1, 2, 3]]);
    expect(checkInvariants(room.game!)).toBeNull();

    const four = roomWith(4);
    four.room.handle(four.conns[0]!, { t: 'start' });
    expect(four.room.settings.fewerDown).toBe(true);
    for (const p of four.room.game!.players) expect(p.down).toEqual([0, 1, 2, 3]);
  });

  it('counts the players dealt in, not the seats: two of four present get the small-table deal', () => {
    const { room, conns } = roomWith(4);
    room.disconnect(conns[2]!);
    room.disconnect(conns[3]!);
    room.handle(conns[0]!, { t: 'start' });
    expect(room.game!.players).toHaveLength(2);
    for (const p of room.game!.players) expect(p.down).toEqual([0, 0, 1, 2]);
  });
});
