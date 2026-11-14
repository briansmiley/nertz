// What a player's cards look like, and the seat they sit in, as the table keeps them: the back drawn by lot stays
// drawn, a message that says nothing of lots changes none, and what goes by seat (chat, voice) follows a change of seat.
import { describe, expect, it } from 'vitest';
import type { SocialServerMsg } from '../shared/chat';
import { parseClientMsg, type ServerMsg } from '../shared/protocol';
import { Room, type Conn } from './room';

class FakeConn implements Conn {
  sent: SocialServerMsg[] = [];
  send(msg: ServerMsg): void {
    if (msg.t !== 'state' && msg.t !== 'error') this.sent.push(JSON.parse(JSON.stringify(msg)) as SocialServerMsg);
  }
  close(): void {}
  last<T extends SocialServerMsg['t']>(t: T): Extract<SocialServerMsg, { t: T }> {
    return this.sent.filter((m): m is Extract<SocialServerMsg, { t: T }> => m.t === t).at(-1)!;
  }
}

interface Kept {
  seat: number;
  back?: string;
  lot?: string;
  night?: boolean;
}

function roomWith(n: number): { room: Room; conns: FakeConn[]; kept: (i: number) => Kept } {
  let x = 7;
  const room = new Room('TEST', { rng: () => ((x = (x * 16807) % 2147483647) - 1) / 2147483646, schedule: () => {} });
  const conns = Array.from({ length: n }, (_, i) => {
    const conn = new FakeConn();
    expect(room.join(conn, `P${i}`, `tok-000${i}`)).toBeNull();
    return conn;
  });
  const kept = (i: number): Kept => (room as unknown as { players: (Kept & { name: string })[] }).players.find((p) => p.name === `P${i}`)!;
  return { room, conns, kept };
}

function send(room: Room, conn: Conn, raw: unknown): void {
  const msg = parseClientMsg(JSON.stringify(raw));
  if (!msg || msg.t === 'join' || msg.t === 'create') throw new Error(`refused: ${JSON.stringify(raw)}`);
  room.handle(conn, msg);
}

describe('a back by lot', () => {
  it('stays as drawn when the player says the rest again (a reconnect, or another setting changed)', () => {
    const { room, conns, kept } = roomWith(2);
    const [a] = conns as [FakeConn, FakeConn];
    send(room, a, { t: 'deck', deck: 'modern', back: 'plain', lot: 'all' });
    send(room, a, { t: 'start' });
    const drawn = kept(0).back;
    expect(drawn).not.toBe('plain');
    send(room, a, { t: 'deck', deck: 'modern', back: 'plain', lot: 'all' }); // the same again
    send(room, a, { t: 'deck', deck: 'modern', back: 'plain', night: true, lot: 'all' }); // dark cards switched on
    expect(kept(0)).toMatchObject({ back: drawn, lot: 'all', night: true });
    send(room, a, { t: 'deck', deck: 'modern', back: 'fern', lot: null }); // no lot any more: their own choice
    expect(kept(0).back).toBe('fern');
    expect(kept(0).lot).toBeUndefined();
  });

  it('is left alone by a message that names no lot, or one this table does not know', () => {
    const { room, conns, kept } = roomWith(2);
    const [a] = conns as [FakeConn, FakeConn];
    expect(parseClientMsg({ t: 'deck', deck: 'modern' })).toEqual({ t: 'deck', deck: 'modern' });
    expect(parseClientMsg({ t: 'deck', deck: 'modern', lot: 'No such kind' })).toEqual({ t: 'deck', deck: 'modern' });
    expect(parseClientMsg({ t: 'deck', deck: 'modern', lot: null })).toEqual({ t: 'deck', deck: 'modern', lot: null });
    send(room, a, { t: 'deck', deck: 'modern', back: 'plain', lot: 'Plants' });
    send(room, a, { t: 'deck', deck: 'classic' });
    send(room, a, { t: 'deck', deck: 'classic', lot: 'No such kind' });
    expect(kept(0).lot).toBe('Plants');
  });
});

describe('a change of seat', () => {
  it('takes what the player said with it, and puts them out of voice to join again from the new seat', () => {
    const { room, conns, kept } = roomWith(2);
    const [a, b] = conns as [FakeConn, FakeConn];
    send(room, a, { t: 'chat', text: 'from a' });
    send(room, b, { t: 'chat', text: 'from b' });
    send(room, a, { t: 'voice', on: true, muted: false });
    send(room, b, { t: 'voice', on: true, muted: false });
    send(room, b, { t: 'seat', seat: 4 });
    expect(kept(1).seat).toBe(4);
    for (const conn of [a, b]) {
      expect(conn.last('chat')).toMatchObject({ history: true, lines: [{ seat: 0, text: 'from a' }, { seat: 4, text: 'from b' }] }); // prettier-ignore
      expect(conn.last('social').inVoice).toEqual([{ seat: 0, muted: false }]);
    }
    send(room, b, { t: 'voice', on: true, muted: false }); // what its window does on seeing that it is not in
    expect(a.last('social').inVoice).toEqual([{ seat: 0, muted: false }, { seat: 4, muted: false }]); // prettier-ignore
    send(room, a, { t: 'signal', to: 4, data: '.x' });
    expect(b.last('signal')).toEqual({ t: 'signal', from: 0, data: '.x' });
  });
});

describe("a bot's name", () => {
  it('is whatever whoever deals calls it: not for anyone else to say, and not a name already at the table', () => {
    const { room, conns, kept } = roomWith(2);
    const [a, b] = conns as [FakeConn, FakeConn];
    send(room, a, { t: 'addBot', level: 'slow' });
    const bot = () => (room as unknown as { players: { name: string; seat: number }[] }).players.find((p) => p.seat === 2)!;
    send(room, b, { t: 'botName', seat: 2, name: 'Mine' });
    expect(bot().name).toBe('Bot Ada');
    send(room, a, { t: 'botName', seat: 2, name: 'P1' }); // taken
    send(room, a, { t: 'botName', seat: 1, name: 'Renamed' }); // not a bot
    expect([bot().name, kept(1).seat]).toEqual(['Bot Ada', 1]);
    send(room, a, { t: 'botName', seat: 2, name: '  Deep\tBlue ' });
    expect(bot().name).toBe('Deep Blue');
    expect(parseClientMsg({ t: 'botName', seat: 2, name: '  ' })).toBeNull();
  });
});

describe('sitting down after the deal', () => {
  it('before the dealer says Start is in time to be dealt in; after it, only to watch', () => {
    const { room, conns } = roomWith(2);
    const [a] = conns as [FakeConn, FakeConn];
    const seats = () => room.game!.players.map((p) => p.seat);
    send(room, a, { t: 'start' });
    expect(seats()).toEqual([0, 1]);
    const dealtTo = room.game;
    expect(room.join(new FakeConn(), 'Late', 'tok-late')).toBeNull();
    expect(seats()).toEqual([0, 1, 2]); // the round is dealt again, with them in it
    expect(room.game).not.toBe(dealtTo);
    expect(room.round).toBe(1); // and is the same round
    (room as unknown as { dealt(): void }).dealt(); // the cards are down: the table waits for Start
    expect(room.join(new FakeConn(), 'Later', 'tok-later')).toBeNull();
    expect(seats()).toEqual([0, 1, 2, 3]);
    (room as unknown as { dealt(): void }).dealt(); // (dealt over again: down once more)
    send(room, a, { t: 'go' });
    expect(room.join(new FakeConn(), 'Latest', 'tok-latest')).toBeNull();
    expect(seats()).toEqual([0, 1, 2, 3]); // "1, 2, 3" has been said: they watch this one
  });
});

describe('coming back', () => {
  it('as a stranger with the name of someone who is away takes their seat, score and cards, not a second seat', () => {
    const { room, conns, kept } = roomWith(3);
    const [a, , c] = conns as [FakeConn, FakeConn, FakeConn];
    send(room, a, { t: 'start' });
    const hand = room.game!.players[2]!.nertz.map((card) => card.id);
    room.disconnect(c);
    expect(room.join(new FakeConn(), 'P2', 'tok-another-window')).toBeNull(); // the old window is gone: a new token
    expect((room as unknown as { players: unknown[] }).players).toHaveLength(3);
    expect(kept(2).seat).toBe(2);
    expect(room.game!.players[2]!.nertz.map((card) => card.id)).toEqual(hand);
    expect(room.join(new FakeConn(), 'P1', 'tok-namesake')).toBeNull(); // P1 is here: a namesake is someone else
    expect((room as unknown as { players: unknown[] }).players).toHaveLength(4);
  });

  it('whoever deals can deal the round over: unscored, the same round, with everyone who is here now', () => {
    const { room, conns } = roomWith(2);
    const [a, b] = conns as [FakeConn, FakeConn];
    send(room, a, { t: 'start' });
    (room as unknown as { dealt(): void }).dealt();
    send(room, a, { t: 'go' });
    expect(room.join(new FakeConn(), 'Late', 'tok-late')).toBeNull(); // too late: watching
    const first = room.game;
    send(room, b, { t: 'redeal' }); // not theirs to say
    expect(room.game).toBe(first);
    send(room, a, { t: 'redeal' });
    expect(room.game!.players.map((p) => p.seat)).toEqual([0, 1, 2]);
    expect(room.game!.stage).toBe('dealing');
    expect([room.round, room.phase, room.lastRound]).toEqual([1, 'playing', null]);
  });
});
