// A table put back together from one window's last snapshot of it (client/rebuild.ts): what it makes is a table the
// room can be brought back from, with every card there once, and nothing in sight moved.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Room } from '../server/room';
import { FakeConn, startRound } from '../server/testkit';
import { alone, checkInvariants, isHidden, viewFor } from '../shared/engine';
import { DEAL_MS } from '../shared/protocol';
import { allCards, lcg, seeded, wire } from '../shared/testkit';
import type { Card, GameState, RoomView } from '../shared/types';
import { rebuild } from './rebuild';

const TOKEN = 'tok-ada-0001';

/** Ada at a table of the server's with three bots, one of them renamed and dressed, and its rules changed. */
function table(seed = 1) {
  const room = new Room('TEST', { rng: seeded(seed), schedule: () => {} });
  const ada = new FakeConn();
  room.join(ada, 'Ada', TOKEN, true);
  for (const level of ['slow', 'medium', 'fast'] as const) room.handle(ada, { t: 'addBot', level });
  room.handle(ada, { t: 'botName', seat: 2, name: 'Babbage' });
  room.handle(ada, { t: 'botBack', seat: 3, backs: { k: 'own', back: 'hilbert' } });
  room.handle(ada, { t: 'deck', look: { deck: 'classic', night: true, bare: false, backs: { k: 'own', back: 'rings' } } });
  room.handle(ada, { t: 'seats', step: -1 });
  const view = (): RoomView => (room.flush(), ada.room);
  return { room, ada, view };
}

/** Every face of `game`, by the card's id. */
const faces = (game: GameState): Map<string, string> => new Map(allCards(game).flatMap((c) => (isHidden(c) ? [] : [[c.id, `${c.owner}:${c.suit}${c.rank}`] as const])));

/** What must hold of the table rebuilt from `view`, whatever it was doing. */
function sound(view: RoomView, rng = lcg(3)) {
  const kept = rebuild(view, TOKEN, rng);
  const game = kept.state;
  expect(!!game).toBe(!!view.game);
  if (game && view.game) {
    expect(checkInvariants(game)).toBeNull(); // every card of every deck once, each in its owner's hand or the middle, every pile a legal one
    expect(allCards(game).some(isHidden)).toBe(false);
    // The same cards in the same places, and every face that was in sight the face it was.
    expect(allCards(game).map((c) => c.id)).toEqual(allCards(view.game).map((c) => c.id));
    for (const [id, face] of faces(view.game)) expect(faces(game).get(id)).toBe(face);
    expect(viewFor(game, view.seat ?? -1)).toEqual(view.game); // (seen from the same seat, it is the snapshot)
  }
  return kept;
}

/** The table brought back from `view`, Ada sat back down at it: as she sees it. */
function back(view: RoomView): { room: Room; ada: FakeConn; view: RoomView } {
  const room = Room.restored(wire(sound(view)), { rng: seeded(9), schedule: () => {} })!;
  expect(room).not.toBeNull();
  const ada = new FakeConn();
  expect(room.join(ada, 'Ada', TOKEN)).toBeNull();
  room.flush();
  return { room, ada, view: ada.room };
}

beforeEach(() => void vi.useFakeTimers());
afterEach(() => void vi.useRealTimers());

describe('a table rebuilt from a snapshot', () => {
  it('in the lobby: everyone where they were, as who they were, and the table as it was set', () => {
    const was = table().view();
    expect(alone(was)).toBe(true);
    const { room, view } = back(was);
    expect(view).toEqual(was);
    expect(view.players.map((p) => p.name)).toEqual(['Ada', 'Bot Ada', 'Babbage', 'Bot Cleo']);
    expect(view.seats).toEqual({ of: 9, taken: 4 });
    room.close();
  });

  it('at every point of a round it is a whole and legal table, with nothing in sight moved', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const t = table(seed);
      t.room.handle(t.ada, { t: 'start' });
      sound(t.view()); // being dealt: no face in sight at all
      vi.advanceTimersByTime(DEAL_MS);
      sound(t.view()); // dealt, waiting for Start
      t.room.handle(t.ada, { t: 'go' });
      sound(t.view()); // "1, 2, 3"
      vi.advanceTimersByTime(5000);
      let seq = 0;
      for (let i = 0; i < 40 && t.room.phase === 'playing'; i++) {
        vi.advanceTimersByTime(700 + 130 * i); // (off the beat of the bots, so groups are caught in flight)
        if (i % 3 === 0) t.room.handle(t.ada, { t: 'intent', seq: seq++, intent: { k: 'draw' } });
        const view = t.view();
        sound(view, lcg(seed * 100 + i));
        if (i === 20) expect(view.game!.slots.some((pile) => pile)).toBe(true); // (the bots have played to the middle by now)
      }
      t.room.close();
    }
  });

  it('gives each deck exactly the faces that were not in sight, shuffled over its face-down cards', () => {
    const t = table();
    startRound(t.room, t.ada);
    vi.advanceTimersByTime(8000);
    const view = t.view();
    const [one, other] = [rebuild(view, TOKEN, lcg(1)).state!, rebuild(view, TOKEN, lcg(2)).state!];
    const down = allCards(view.game!).filter(isHidden);
    expect(down.length).toBeGreaterThan(100);
    for (const seat of view.game!.players.map((p) => p.seat)) {
      const deck = (g: GameState) => allCards(g).filter((c): c is Card => c.owner === seat && !isHidden(c)).map((c) => `${c.suit}${c.rank}`).sort();
      expect(new Set(deck(one)).size).toBe(52);
      expect(deck(one)).toEqual(deck(other));
    }
    // Which face-down card has which face is by lot: another shuffle, other faces, and the truth is not known.
    expect(down.filter((c) => faces(one).get(c.id) !== faces(other).get(c.id)).length).toBeGreaterThan(50);
    expect(down.filter((c) => faces(one).get(c.id) !== faces(t.room.game!).get(c.id)).length).toBeGreaterThan(50);
    t.room.close();
  });

  it('a round in play comes back stopped where it was: its clock, scores, seats and looks as they were, and it plays on', () => {
    const t = table();
    startRound(t.room, t.ada);
    vi.advanceTimersByTime(12_000);
    const was = t.view();
    expect(was.clock).toMatchObject({ running: true });
    t.room.close();
    const { room, ada, view } = back(was);
    expect(view).toMatchObject({ code: 'TEST', phase: 'playing', round: 1, me: was.me, seat: was.seat, settings: was.settings, seats: was.seats, lastRound: null });
    expect(view.players).toEqual(was.players);
    expect(view.clock).toEqual({ ms: was.clock!.ms, running: false });
    expect(view.paused).toEqual({ by: 'update', done: true }); // (as any table brought back: client/local.ts starts it again)
    // Cards in hand went home as it stopped; everything else lies as it lay.
    const lying = (g: GameState) => g.players.map(({ holding, stuck, ending, ...p }) => p);
    expect(lying(view.game!)).toEqual(lying(was.game!));
    expect(view.game!.slots).toEqual(was.game!.slots);
    room.handle(ada, { t: 'pause', on: false });
    const before = JSON.stringify(room.game);
    vi.advanceTimersByTime(20_000);
    expect(JSON.stringify(room.game)).not.toBe(before); // (the bots play their made-up hands)
    expect(checkInvariants(room.game!)).toBeNull();
    room.close();
  });

  it('between rounds: the score sheet, and what everyone has scored, are as they were, and the next round is dealt', () => {
    const t = table();
    startRound(t.room, t.ada);
    vi.advanceTimersByTime(3000);
    t.room.handle(t.ada, { t: 'intent', seq: 0, intent: { k: 'end', on: true } }); // (hers is the only vote)
    const was = t.view();
    expect(was).toMatchObject({ phase: 'results', lastRound: { end: { by: 'vote', voters: 1 } } });
    t.room.close();
    const { room, ada, view } = back(was);
    expect(view.lastRound).toEqual(was.lastRound);
    expect(view.players.map((p) => [p.name, p.score, p.rounds, p.calls])).toEqual(was.players.map((p) => [p.name, p.score, p.rounds, p.calls]));
    expect(view).toMatchObject({ phase: 'results', round: 1, paused: null });
    room.handle(ada, { t: 'start' });
    room.flush();
    expect(ada.room).toMatchObject({ phase: 'playing', round: 2 });
    expect(ada.room.game!.players.map((p) => p.seat)).toEqual(was.game!.players.map((p) => p.seat));
    room.close();
  });

  it('what a snapshot does not say is made up plainly: no chat, nobody signed in, no snipes, no hand put aside', () => {
    const t = table();
    startRound(t.room, t.ada);
    const kept = rebuild(t.view(), TOKEN);
    expect(kept).toMatchObject({ social: { text: false, voice: false, lines: [] }, snipes: [], aside: [], host: 0, ids: 4, sittings: 4, queue: 0 });
    expect(kept.players.map((p) => [p.token, p.account, p.bot])).toEqual([[TOKEN, null, undefined], ['bot:1', null, 'slow'], ['bot:2', null, 'medium'], ['bot:3', null, 'fast']]);
    t.room.close();
  });
});
