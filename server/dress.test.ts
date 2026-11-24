// What a player's cards look like, and the seat they sit in, as the table keeps them: the back drawn by lot stays
// drawn, a look half said changes nothing, and what goes by seat (chat, voice) follows a change of seat.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deal } from '../shared/engine';
import { backPool, DEAL_MS, isBack, parseClientMsg, PLAIN_LOOK, START_MS, type Back, type Backs, type Look } from '../shared/protocol';
import { faceUps, lehmer, rig } from '../shared/testkit';
import type { PlayerView } from '../shared/types';
import type { Room } from './room';
import { FakeConn, roomWith as seated, send } from './testkit';

/** `n` at a table whose every round is dealt with no nertz pile for seat 0 (see `callNertz`). */
function roomWith(n: number): { room: Room; conns: FakeConn[]; everyone: () => PlayerView[]; kept: (i: number) => PlayerView; shown: (seat: number) => PlayerView } {
  const { room, conns } = seated(n, { rng: lehmer(7), deal: (seats, rng) => rig(deal(seats, rng), { work: ['S1', 'S2', 'H1', 'D5'], emptyNertz: [0] }) });
  /** Everyone in the room, as the table shows them to the first of them. */
  const everyone = (): PlayerView[] => {
    room.flush();
    return conns[0]!.room.players;
  };
  /** P`i`, wherever they are. */
  const kept = (i: number) => everyone().find((p) => p.name === `P${i}`)!;
  /** Whoever is in `seat`. */
  const shown = (seat: number) => everyone().find((p) => p.seat === seat)!;
  return { room, conns, everyone, kept, shown };
}

/** Ends the round, once its cards are down: the dealer's Start, the count, and seat 0 (dealt no nertz pile) calls. (Fake timers.) */
function callNertz(room: Room, conn: FakeConn): void {
  send(room, conn, { t: 'go' });
  vi.advanceTimersByTime(START_MS);
  room.handle(conn, { t: 'intent', seq: 1000, intent: { k: 'nertz' } });
  expect(room.phase).toBe('results');
}

const own = (back: Back): Backs => ({ k: 'own', back });
const lot = (lot: string): Backs => ({ k: 'lot', lot, drawn: null });
/** A player saying how their cards look: the plain look, but for `look`. */
const deck = (look: Partial<Look>) => ({ t: 'deck', look: { ...PLAIN_LOOK, ...look } });
/** Their backs are by `lot`, with one drawn from it. */
const inLot = (of: string) => (v: PlayerView) => v.look.backs.k === 'lot' && v.look.backs.lot === of && !!v.look.backs.drawn && backPool(of).includes(v.look.backs.drawn);

afterEach(() => void vi.useRealTimers());

describe('a back by lot', () => {
  it('stays as drawn when the player says the rest again (a reconnect, or another setting changed)', () => {
    const { room, conns, shown } = roomWith(2);
    const [a] = conns as [FakeConn, FakeConn];
    send(room, a, deck({ backs: lot('all') }));
    send(room, a, { t: 'start' });
    const drawn = shown(0).look.backs;
    expect(drawn).toSatisfy((b: Backs) => b.k === 'lot' && isBack(b.drawn));
    send(room, a, deck({ backs: lot('all') })); // the same again
    send(room, a, deck({ backs: lot('all'), night: true })); // dark cards switched on
    expect(shown(0).look).toEqual({ ...PLAIN_LOOK, night: true, backs: drawn });
    send(room, a, deck({ backs: own('fern') })); // no lot any more: their own choice
    expect(shown(0).look.backs).toEqual(own('fern'));
  });

  it('is left alone by a look half said, one with a lot this table does not know, or one that says what was drawn', () => {
    const { room, conns, shown } = roomWith(2);
    const [a] = conns as [FakeConn, FakeConn];
    const { bare: _, ...unsaid } = PLAIN_LOOK;
    for (const look of [unsaid, { ...PLAIN_LOOK, backs: lot('No such kind') }, { ...PLAIN_LOOK, backs: { k: 'own' } }, { ...PLAIN_LOOK, deck: 'classic:night' }]) expect(parseClientMsg({ t: 'deck', look })).toBeNull();
    expect(parseClientMsg({ t: 'deck', deck: 'modern', back: 'fern' })).toBeNull(); // (as a window from before the look was one thing said it)
    expect(parseClientMsg(deck({ backs: { k: 'lot', lot: 'Plants', drawn: 'fern' } }))).toEqual(deck({ backs: lot('Plants') })); // only the table draws
    send(room, a, deck({ backs: lot('Plants'), deck: 'classic' }));
    send(room, a, { t: 'deck', look: { ...unsaid, backs: own('fern') } });
    expect(shown(0).look).toEqual({ ...PLAIN_LOOK, deck: 'classic', backs: lot('Plants') });
  });

  it('is not drawn until a round is dealt, and is drawn again when the table is started over', () => {
    vi.useFakeTimers();
    const { room, conns, shown } = roomWith(2);
    const [a, b] = conns as [FakeConn, FakeConn];
    send(room, b, deck({ backs: lot('Plants') }));
    expect(shown(1).look.backs).toEqual(lot('Plants'));
    send(room, a, { t: 'start' });
    const drawn = shown(1).look.backs;
    expect(shown(1)).toSatisfy(inLot('Plants'));
    vi.advanceTimersByTime(DEAL_MS);
    callNertz(room, a);
    expect(shown(1).look.backs).toEqual(drawn); // kept to the end of the round, and on its finished table
    expect(conns[0]!.room.lastRound!.scores.find((l) => l.seat === 1)!.look!.backs).toEqual(drawn);
    send(room, a, { t: 'reset' });
    expect(shown(1).look.backs).toEqual(lot('Plants'));
    send(room, a, { t: 'start' });
    expect(shown(1)).toSatisfy(inLot('Plants'));
  });

  it('chosen between rounds is not drawn until the next deal; chosen while a round is on, it is drawn at once', () => {
    vi.useFakeTimers();
    const { room, conns, shown } = roomWith(2);
    const [a, b] = conns as [FakeConn, FakeConn];
    send(room, a, { t: 'start' });
    send(room, b, deck({ backs: lot('Emblems') }));
    expect(shown(1)).toSatisfy(inLot('Emblems'));
    vi.advanceTimersByTime(DEAL_MS);
    callNertz(room, a);
    send(room, b, deck({ backs: lot('Celestial') }));
    expect(shown(1).look.backs).toEqual(lot('Celestial'));
    send(room, a, { t: 'start' });
    expect(shown(1)).toSatisfy(inLot('Celestial'));
  });

  it('is drawn at the deal for someone at the table who is away, and is theirs when they come back', () => {
    const { room, conns, shown } = roomWith(3);
    const [a, , c] = conns as [FakeConn, FakeConn, FakeConn];
    send(room, c, deck({ backs: lot('Maths') }));
    room.disconnect(c);
    send(room, a, { t: 'start' });
    expect(room.game!.players.map((p) => p.seat)).toEqual([0, 1]);
    const drawn = shown(2).look.backs;
    expect(shown(2)).toSatisfy(inLot('Maths'));
    expect(room.join(c, 'P2', 'tok-0002')).toBeNull();
    expect(shown(2).look.backs).toEqual(drawn);
  });

  it('keeps its white edge or not as the player has their backs, drawn or not', () => {
    const { room, conns, shown } = roomWith(2);
    const [a] = conns as [FakeConn, FakeConn];
    send(room, a, deck({ backs: own('fern'), bare: true }));
    expect(shown(0).look).toMatchObject({ backs: own('fern'), bare: true });
    send(room, a, deck({ backs: lot('Tilings'), bare: true }));
    expect(shown(0).look).toMatchObject({ backs: lot('Tilings'), bare: true });
    send(room, a, { t: 'start' });
    expect(shown(0)).toSatisfy(inLot('Tilings'));
    expect(shown(0).look.bare).toBe(true);
  });
});

describe("a bot's back", () => {
  it('is for whoever deals to choose, or to have drawn by lot: and a back drawn stays while the lot is said again', () => {
    const { room, conns, shown } = roomWith(2);
    const [a, b] = conns as [FakeConn, FakeConn];
    send(room, a, { t: 'addBot', level: 'slow' });
    expect(shown(2).look).toEqual(PLAIN_LOOK);
    send(room, b, { t: 'botBack', seat: 2, backs: lot('Emblems') }); // not theirs to say
    expect(shown(2).look.backs).toEqual(own('plain'));
    expect(parseClientMsg({ t: 'botBack', seat: 2, lot: 'Emblems' })).toBeNull(); // (as a window from before said it)
    send(room, a, { t: 'botBack', seat: 2, backs: lot('Emblems') });
    expect(shown(2).look.backs).toEqual(lot('Emblems'));
    send(room, a, { t: 'start' });
    const drawn = shown(2).look.backs;
    expect(shown(2)).toSatisfy(inLot('Emblems'));
    send(room, a, { t: 'botBack', seat: 2, backs: lot('Emblems') });
    expect(shown(2).look.backs).toEqual(drawn);
    send(room, a, { t: 'botBack', seat: 2, backs: own('fern') });
    expect(shown(2).look).toEqual({ ...PLAIN_LOOK, backs: own('fern') });
    send(room, a, { t: 'botBack', seat: 2, backs: lot('all') }); // in the middle of a round: drawn at once
    expect(shown(2)).toSatisfy(inLot('all'));
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
    const { room, conns, kept, shown } = roomWith(2);
    const [a, b] = conns as [FakeConn, FakeConn];
    send(room, a, { t: 'addBot', level: 'slow' });
    const bot = () => shown(2);
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
    expect(seats()).toEqual([0, 1, 2]); // they are dealt into the round
    // Nobody else's face-up cards or nertz pile change: only what is buried under them, now that three are dealt in.
    expect(room.game!.players.slice(0, 2).map(faceUps)).toEqual(dealtTo!.players.map(faceUps));
    expect(room.game!.players.map((p) => p.work.map((w) => w.down))).toEqual([[0, 0, 1, 2], [0, 0, 1, 2], [0, 0, 1, 2]]);
    expect(room.round).toBe(1);
    vi.advanceTimersByTime(DEAL_MS); // the cards are down: the table waits for Start
    expect(room.join(new FakeConn(), 'Later', 'tok-later', true)).toBeNull();
    expect(seats()).toEqual([0, 1, 2, 3]);
    send(room, a, { t: 'go' });
    expect(room.join(new FakeConn(), 'Latest', 'tok-latest', true)).toBeNull();
    expect(seats()).toEqual([0, 1, 2, 3]); // "1, 2, 3" has been said: they watch this one
  });
});

describe('coming back', () => {
  it('goes by the token alone: a stranger with the name of someone who is away is someone else, with no seat, score or cards of theirs', () => {
    const { room, conns, everyone, kept } = roomWith(3);
    const [a, , c] = conns as [FakeConn, FakeConn, FakeConn];
    send(room, a, { t: 'start' });
    room.disconnect(c);
    expect(room.join(new FakeConn(), 'P2', 'tok-another-window', true)).toBeNull(); // the name of someone away, and a new token
    expect(everyone()).toHaveLength(4);
    expect(everyone().filter((p) => p.name === 'P2').map((p) => [p.seat, p.connected])).toEqual([[2, false], [3, true]]); // prettier-ignore
    expect(room.game!.players.map((p) => p.seat)).toEqual([0, 1, 2, 3]); // (before Start: dealt in, to their own seat; the one away keeps the cards they were dealt)
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
    const { room, conns, everyone, kept } = roomWith(3);
    const [a, b, c] = conns as [FakeConn, FakeConn, FakeConn];
    const closed: FakeConn[] = [];
    for (const conn of conns) conn.close = () => void closed.push(conn);
    const seats = () => everyone().map((p) => p.seat);
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
