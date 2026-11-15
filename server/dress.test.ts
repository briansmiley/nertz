// What a player's cards look like, and the seat they sit in, as the table keeps them: the back drawn by lot stays
// drawn, a message that says nothing of lots changes none, and what goes by seat (chat, voice) follows a change of seat.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEAL_MS, parseClientMsg } from '../shared/protocol';
import { lehmer } from '../shared/testkit';
import type { Room } from './room';
import { FakeConn, roomWith as seated, send } from './testkit';

interface Kept {
  seat: number;
  back?: string;
  lot?: string;
  night?: boolean;
}

function roomWith(n: number): { room: Room; conns: FakeConn[]; kept: (i: number) => Kept } {
  const { room, conns } = seated(n, { rng: lehmer(7) });
  const kept = (i: number): Kept => (room as unknown as { players: (Kept & { name: string })[] }).players.find((p) => p.name === `P${i}`)!;
  return { room, conns, kept };
}

afterEach(() => void vi.useRealTimers());

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
  it('changes nothing about who one is: what the player said is still theirs, and they stay in voice', () => {
    const { room, conns, kept } = roomWith(2);
    const [a, b] = conns as [FakeConn, FakeConn];
    send(room, a, { t: 'chat', text: 'from a' });
    send(room, b, { t: 'chat', text: 'from b' });
    send(room, a, { t: 'voice', on: true, muted: false });
    send(room, b, { t: 'voice', on: true, muted: false });
    const chats = a.of('chat').length;
    send(room, b, { t: 'seat', seat: 4 });
    expect(kept(1).seat).toBe(4);
    expect(a.of('chat')).toHaveLength(chats); // (nothing to send again: a line goes by who said it, and its colour by the seat they have)
    for (const conn of [a, b]) expect(conn.social.inVoice).toEqual([{ id: 0, muted: false }, { id: 1, muted: false }]); // prettier-ignore
    send(room, a, { t: 'signal', to: 1, data: '.x' });
    expect(b.of('signal').at(-1)).toEqual({ t: 'signal', from: 0, data: '.x' });
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
    vi.useFakeTimers();
    const { room, conns } = roomWith(2);
    const [a] = conns as [FakeConn, FakeConn];
    const seats = () => room.game!.players.map((p) => p.seat);
    send(room, a, { t: 'start' });
    expect(seats()).toEqual([0, 1]);
    const dealtTo = room.game;
    expect(room.join(new FakeConn(), 'Late', 'tok-late', true)).toBeNull();
    expect(seats()).toEqual([0, 1, 2]); // the round is dealt again, with them in it
    expect(room.game).not.toBe(dealtTo);
    expect(room.round).toBe(1); // and is the same round
    vi.advanceTimersByTime(DEAL_MS); // the cards are down: the table waits for Start
    expect(room.join(new FakeConn(), 'Later', 'tok-later', true)).toBeNull();
    expect(seats()).toEqual([0, 1, 2, 3]);
    vi.advanceTimersByTime(DEAL_MS); // (dealt over again: down once more)
    send(room, a, { t: 'go' });
    expect(room.join(new FakeConn(), 'Latest', 'tok-latest', true)).toBeNull();
    expect(seats()).toEqual([0, 1, 2, 3]); // "1, 2, 3" has been said: they watch this one
  });
});

describe('coming back', () => {
  it('goes by the token alone: a stranger with the name of someone who is away is someone else, with no seat, score or cards of theirs', () => {
    const { room, conns, kept } = roomWith(3);
    const [a, , c] = conns as [FakeConn, FakeConn, FakeConn];
    send(room, a, { t: 'start' });
    room.disconnect(c);
    const players = () => (room as unknown as { players: { name: string; seat: number | null; conn: unknown }[] }).players;
    expect(room.join(new FakeConn(), 'P2', 'tok-another-window', true)).toBeNull(); // the name of someone away, and a new token
    expect(players()).toHaveLength(4);
    expect(players().filter((p) => p.name === 'P2').map((p) => [p.seat, !!p.conn])).toEqual([[2, false], [3, true]]); // prettier-ignore
    expect(room.game!.players.map((p) => p.seat)).toEqual([0, 1, 3]); // (before Start: dealt in, to their own seat; the one away is not)
    expect(room.join(c, 'P2', 'tok-0002')).toBeNull(); // and the one who was away is back by their token: in their seat
    expect(kept(2).seat).toBe(2);
    expect(room.game!.players.map((p) => p.seat)).toEqual([0, 1, 2, 3]);
  });

  it('whoever deals can deal the round over: unscored, the same round, with everyone who is here now', () => {
    vi.useFakeTimers();
    const { room, conns } = roomWith(2);
    const [a, b] = conns as [FakeConn, FakeConn];
    send(room, a, { t: 'start' });
    vi.advanceTimersByTime(DEAL_MS);
    send(room, a, { t: 'go' });
    expect(room.join(new FakeConn(), 'Late', 'tok-late', true)).toBeNull(); // too late: watching
    const first = room.game;
    send(room, b, { t: 'redeal' }); // not theirs to say
    expect(room.game).toBe(first);
    send(room, a, { t: 'redeal' });
    expect(room.game!.players.map((p) => p.seat)).toEqual([0, 1, 2]);
    expect(room.game!.stage).toBe('dealing');
    expect([room.round, room.phase, room.lastRound]).toEqual([1, 'playing', null]);
  });
});

describe('sent away', () => {
  it('by whoever deals, a person is out of the table as if they had left: told so, and their connection closed', () => {
    const { room, conns, kept } = roomWith(3);
    const [a, b, c] = conns as [FakeConn, FakeConn, FakeConn];
    const closed: FakeConn[] = [];
    for (const conn of conns) conn.close = () => void closed.push(conn);
    const seats = () => (room as unknown as { players: { seat: number }[] }).players.map((p) => p.seat);
    send(room, b, { t: 'kick', id: 2 }); // not theirs to say
    send(room, a, { t: 'kick', id: 0 }); // not oneself
    expect(seats()).toEqual([0, 1, 2]);
    send(room, a, { t: 'kick', id: 2 });
    expect(seats()).toEqual([0, 1]);
    expect(closed).toEqual([c]);
    room.disconnect(b); // someone who is away can be sent away too
    send(room, a, { t: 'kick', id: 1 });
    expect(seats()).toEqual([0]);
    expect(kept(0).seat).toBe(0);
  });
});
