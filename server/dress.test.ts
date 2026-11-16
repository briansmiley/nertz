// What a player's cards look like, and the seat they sit in, as the table keeps them: the back drawn by lot stays
// drawn, a message that says nothing of lots changes none, and what goes by seat (chat, voice) follows a change of seat.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { backPool, DEAL_MS, isBack, parseClientMsg } from '../shared/protocol';
import { inPlay, lehmer, rig, seeded } from '../shared/testkit';
import type { PlayerView } from '../shared/types';
import type { Room } from './room';
import { FakeConn, roomWith as seated, send } from './testkit';

function roomWith(n: number): { room: Room; conns: FakeConn[]; kept: (i: number) => { seat: number }; shown: (seat: number) => PlayerView } {
  const { room, conns } = seated(n, { rng: lehmer(7) });
  const kept = (i: number) => (room as unknown as { players: { name: string; seat: number }[] }).players.find((p) => p.name === `P${i}`)!;
  /** Whoever is in `seat`, as the table shows them to everyone. */
  const shown = (seat: number): PlayerView => {
    room.flush();
    return conns[0]!.room.players.find((p) => p.seat === seat)!;
  };
  return { room, conns, kept, shown };
}

/** Ends the round: seat 0 has no nertz pile left, and says so. */
function callNertz(room: Room, conn: FakeConn): void {
  room.game = rig(inPlay(room.game!.players.map((p) => p.seat), seeded(7)), { work: ['S1', 'S2', 'H1', 'D5'], emptyNertz: [0] });
  room.handle(conn, { t: 'intent', seq: 1000, intent: { k: 'nertz' } });
  expect(room.phase).toBe('results');
}

/** Their back is one drawn from `lot`. */
const inLot = (lot: string) => (v: PlayerView) => (backPool(lot) as readonly string[]).includes(v.back!.replace(/:bare$/, ''));

afterEach(() => void vi.useRealTimers());

describe('a back by lot', () => {
  it('stays as drawn when the player says the rest again (a reconnect, or another setting changed)', () => {
    const { room, conns, shown } = roomWith(2);
    const [a] = conns as [FakeConn, FakeConn];
    send(room, a, { t: 'deck', deck: 'modern', back: 'plain', lot: 'all' });
    send(room, a, { t: 'start' });
    const drawn = shown(0).back;
    expect(isBack(drawn)).toBe(true);
    send(room, a, { t: 'deck', deck: 'modern', back: 'plain', lot: 'all' }); // the same again
    send(room, a, { t: 'deck', deck: 'modern', back: 'plain', night: true, lot: 'all' }); // dark cards switched on
    expect(shown(0)).toMatchObject({ back: drawn, lot: 'all', deck: 'modern:night' });
    send(room, a, { t: 'deck', deck: 'modern', back: 'fern', lot: null }); // no lot any more: their own choice
    expect(shown(0).back).toBe('fern');
    expect(shown(0).lot).toBeUndefined();
  });

  it('is left alone by a message that names no lot, or one this table does not know', () => {
    const { room, conns, shown } = roomWith(2);
    const [a] = conns as [FakeConn, FakeConn];
    expect(parseClientMsg({ t: 'deck', deck: 'modern' })).toEqual({ t: 'deck', deck: 'modern' });
    expect(parseClientMsg({ t: 'deck', deck: 'modern', lot: 'No such kind' })).toEqual({ t: 'deck', deck: 'modern' });
    expect(parseClientMsg({ t: 'deck', deck: 'modern', lot: null })).toEqual({ t: 'deck', deck: 'modern', lot: null });
    send(room, a, { t: 'deck', deck: 'modern', back: 'plain', lot: 'Plants' });
    send(room, a, { t: 'deck', deck: 'classic', back: 'fern' });
    send(room, a, { t: 'deck', deck: 'classic', lot: 'No such kind' });
    expect(shown(0)).toMatchObject({ back: 'any', lot: 'Plants', deck: 'classic' });
  });

  it('is not drawn until a round is dealt, and is drawn again when the table is started over', () => {
    vi.useFakeTimers();
    const { room, conns, shown } = roomWith(2);
    const [a, b] = conns as [FakeConn, FakeConn];
    send(room, b, { t: 'deck', deck: 'modern', back: 'plain', lot: 'Plants' });
    expect(shown(1).back).toBe('any');
    send(room, a, { t: 'start' });
    const drawn = shown(1).back;
    expect(shown(1)).toSatisfy(inLot('Plants'));
    vi.advanceTimersByTime(DEAL_MS);
    callNertz(room, a);
    expect(shown(1).back).toBe(drawn); // kept to the end of the round, and on its finished table
    send(room, a, { t: 'reset' });
    expect(shown(1)).toMatchObject({ back: 'any', lot: 'Plants' });
    send(room, a, { t: 'start' });
    expect(shown(1)).toSatisfy(inLot('Plants'));
  });

  it('chosen between rounds is not drawn until the next deal; chosen while a round is on, it is drawn at once', () => {
    vi.useFakeTimers();
    const { room, conns, shown } = roomWith(2);
    const [a, b] = conns as [FakeConn, FakeConn];
    send(room, a, { t: 'start' });
    send(room, b, { t: 'deck', deck: 'modern', back: 'plain', lot: 'Emblems' });
    expect(shown(1)).toSatisfy(inLot('Emblems'));
    vi.advanceTimersByTime(DEAL_MS);
    callNertz(room, a);
    send(room, b, { t: 'deck', deck: 'modern', back: 'plain', lot: 'Celestial' });
    expect(shown(1)).toMatchObject({ back: 'any', lot: 'Celestial' });
    send(room, a, { t: 'start' });
    expect(shown(1)).toSatisfy(inLot('Celestial'));
  });

  it('is drawn at the deal for someone at the table who is away, and is theirs when they come back', () => {
    const { room, conns, shown } = roomWith(3);
    const [a, , c] = conns as [FakeConn, FakeConn, FakeConn];
    send(room, c, { t: 'deck', deck: 'modern', back: 'plain', lot: 'Maths' });
    room.disconnect(c);
    send(room, a, { t: 'start' });
    expect(room.game!.players.map((p) => p.seat)).toEqual([0, 1]);
    const drawn = shown(2).back;
    expect(shown(2)).toSatisfy(inLot('Maths'));
    expect(room.join(c, 'P2', 'tok-0002')).toBeNull();
    expect(shown(2).back).toBe(drawn);
  });

  it('is shown without its white edge for whoever has backs so; not drawn, it is the one with a question mark', () => {
    const { room, conns, shown } = roomWith(2);
    const [a] = conns as [FakeConn, FakeConn];
    send(room, a, { t: 'deck', deck: 'modern', back: 'fern', bare: true, lot: null });
    expect(shown(0).back).toBe('fern:bare');
    send(room, a, { t: 'deck', deck: 'modern', back: 'fern', bare: true, lot: 'Tilings' });
    expect(shown(0).back).toBe('any');
    send(room, a, { t: 'start' });
    expect(shown(0).back).toMatch(/^[a-z-]+:bare$/);
    expect(shown(0)).toSatisfy(inLot('Tilings'));
  });
});

describe("a bot's back", () => {
  it('is for whoever deals to choose, or to have drawn by lot: and a back drawn stays, whatever else is said with no word of the lot', () => {
    const { room, conns, shown } = roomWith(2);
    const [a, b] = conns as [FakeConn, FakeConn];
    send(room, a, { t: 'addBot', level: 'slow' });
    expect(shown(2).back).toBe('plain');
    send(room, b, { t: 'botBack', seat: 2, lot: 'Emblems' }); // not theirs to say
    expect(shown(2).lot).toBeUndefined();
    send(room, a, { t: 'botBack', seat: 2, lot: 'Emblems' });
    expect(shown(2)).toMatchObject({ back: 'any', lot: 'Emblems' });
    send(room, a, { t: 'start' });
    const drawn = shown(2).back;
    expect(shown(2)).toSatisfy(inLot('Emblems'));
    send(room, a, { t: 'botBack', seat: 2, back: 'fern' }); // a back, with nothing said of the lot
    expect(shown(2)).toMatchObject({ back: drawn, lot: 'Emblems' });
    send(room, a, { t: 'botBack', seat: 2, back: 'fern', lot: null });
    expect(shown(2)).toMatchObject({ back: 'fern' });
    expect(shown(2).lot).toBeUndefined();
    send(room, a, { t: 'botBack', seat: 2, lot: 'all' }); // in the middle of a round: drawn at once
    expect(isBack(shown(2).back)).toBe(true);
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
    expect(room.game!.status.at).toBe('dealing');
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
