// Table settings end to end: the wire message, who may change them and when,
// and what the small-table rule does to the deal.
import { describe, expect, it } from 'vitest';
import { checkInvariants, deal } from '../shared/engine';
import { parseClientMsg } from '../shared/protocol';
import { DEFAULT_SETTINGS, parseSettings } from '../shared/settings';
import { downs, lcg, seats, toPlay } from '../shared/testkit';
import { FakeConn, roomWith } from './testkit';

describe('the small-table deal', () => {
  it('deals no face-down cards at two players, 0/0/1/2 at three and 0/1/2/3 from four up; the nertz pile is 13 either way', () => {
    for (const n of [2, 3, 4, 6]) {
      const game = deal(seats(n), lcg(n));
      const down = n === 2 ? [0, 0, 0, 0] : n === 3 ? [0, 0, 1, 2] : [0, 1, 2, 3];
      const inWork = 4 + down.reduce((a, b) => a + b, 0);
      expect(checkInvariants(game)).toBeNull();
      expect(game.players).toHaveLength(n);
      for (const p of game.players) {
        expect(downs(p), `${n} players`).toEqual(down);
        expect(p.work.map((w) => w.cards.length)).toEqual(down.map((d) => d + 1));
        expect(p.nertz).toHaveLength(13);
        expect(p.stock).toHaveLength(39 - inWork);
        expect(p.nertz.length + p.work.flatMap((w) => w.cards).length + p.stock.length).toBe(52);
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
    expect(room.game!.players.map(downs)).toEqual([[0, 0, 0, 0], [0, 0, 0, 0]]);
    expect(room.game!.players[0]!.stock).toHaveLength(35);
    expect(checkInvariants(room.game!)).toBeNull();

    const four = roomWith(4, { rng: lcg(3) });
    four.room.handle(four.conns[0]!, { t: 'start' });
    for (const p of four.room.game!.players) expect(downs(p)).toEqual([0, 1, 2, 3]);
  });

  it('counts the players dealt in, not the seats: two of four present get the small-table deal', () => {
    const { room, conns } = roomWith(4, { rng: lcg(3) });
    room.disconnect(conns[2]!);
    room.disconnect(conns[3]!);
    room.handle(conns[0]!, { t: 'start' });
    expect(room.game!.players).toHaveLength(2);
    for (const p of room.game!.players) expect(downs(p)).toEqual([0, 0, 0, 0]);
  });
});
