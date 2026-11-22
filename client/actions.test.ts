import { describe, expect, it } from 'vitest';
import { applyIntent, deal, finishDeal, RESHUFFLES_BEFORE_VOTE, resolveEndVote, seatedPeople } from '../shared/engine';
import { inPlay, lcg, roomOf } from '../shared/testkit';
import type { GameState, PlayerView, RoomView } from '../shared/types';
import { ballot, canPause, canRedeal, canReset, canResume, pauseKeyAction, standing, tableActions } from './actions';

const live = inPlay([0, 1, 2], lcg(7));
const voting = (g: GameState, seat: number): GameState => {
  const r = applyIntent(g, seat, { k: 'end', on: true });
  if (!r.ok) throw new Error(r.reason);
  return r.state;
};
/** The room with one player's line changed. */
const withPlayer = (room: RoomView, seat: number, patch: Partial<PlayerView>): RoomView => ({ ...room, players: room.players.map((p) => (p.seat === seat ? { ...p, ...patch } : p)) });
const ids = (room: RoomView) => tableActions(room).map((a) => a.id);

describe("the table's actions", () => {
  it('in a live round: pause, the vote, standing up and leaving for anyone dealt in; restarting for whoever deals', () => {
    expect(ids(roomOf(live, 1))).toEqual(['pause', 'vote', 'stand', 'leave']);
    expect(ids(roomOf(live, 0))).toEqual(['pause', 'vote', 'redeal', 'stand', 'leave']);
  });

  it('what cannot be undone asks twice: dealing again, and leaving', () => {
    expect(tableActions(roomOf(live, 0)).filter((a) => a.sure).map((a) => a.id)).toEqual(['redeal', 'leave']);
  });

  it('before Start there is nothing to pause or to end: only whoever deals can deal again, and anyone can leave', () => {
    const ready = finishDeal(deal([0, 1, 2], lcg(7)));
    expect(ids(roomOf(ready, 1))).toEqual(['leave']);
    expect(ids(roomOf(ready, 0))).toEqual(['redeal', 'leave']);
  });

  it('someone watching can only leave', () => {
    const watcher: PlayerView = { ...roomOf(live, 1).players[1]!, id: 9, seat: null, name: 'w', isHost: false };
    const base = roomOf(live, 1);
    const room = { ...base, me: 9, seat: null, players: [...base.players, watcher] };
    expect(ids(room)).toEqual(['leave']);
    expect(canPause(room)).toBe(false);
    expect(ballot(room)).toBeNull();
  });

  it('paused: anyone in the round unpauses it, and whoever deals, watching or not; someone else watching cannot', () => {
    const paused = (you: number) => roomOf(live, you, { paused: { by: 1 } });
    expect(ids(paused(1))).toEqual(['resume', 'vote', 'stand', 'leave']);
    expect(ids(paused(0))).toEqual(['resume', 'vote', 'redeal', 'stand', 'leave']);
    expect(ids(paused(2))).toEqual(['resume', 'vote', 'stand', 'leave']);
    expect(canResume(roomOf(live, 1))).toBe(false); // (not paused)
    // SMI-86: in the queue while whoever paused it had gone, the window offered to unpause it; the server ignored it.
    const watching = (isHost: boolean): RoomView => {
      const base = paused(1);
      const me: PlayerView = { ...base.players[1]!, id: 9, seat: null, name: 'w', isHost, queued: true };
      return { ...withPlayer(base, 1, { connected: false, left: true }), me: 9, seat: null, players: [...base.players, me] };
    };
    expect(canResume(watching(false))).toBe(false);
    expect(canResume(watching(true))).toBe(true);
  });

  it('between rounds: leaving for anyone, and on the score sheet starting over for whoever deals (SMI-117)', () => {
    expect(ids(roomOf(live, 0, { phase: 'lobby', game: null }))).toEqual(['leave']);
    const over = resolveEndVote([0, 1, 2].reduce(voting, live), [0, 1, 2]);
    const room = roomOf(over, 0, { phase: 'results' });
    expect(ids(room)).toEqual(['reset', 'leave']);
    expect(ids(roomOf(over, 1, { phase: 'results' }))).toEqual(['leave']);
    expect(tableActions(room).find((a) => a.id === 'reset')?.sure).toBeTruthy();
    expect(canReset(roomOf(live, 0))).toBe(false); // (not during a round)
    expect(canRedeal(room)).toBe(false);
    expect(canPause(room)).toBe(false);
  });
});

describe('the pause key', () => {
  it("presses the menu's Pause or Unpause, whichever is open to you, and otherwise nothing", () => {
    expect(pauseKeyAction(roomOf(live, 1))).toBe('pause');
    expect(pauseKeyAction(roomOf(live, 1, { paused: { by: 2 } }))).toBe('resume');
    expect(pauseKeyAction(roomOf(finishDeal(deal([0, 1, 2], lcg(7))), 1))).toBeNull(); // (before Start)
    expect(pauseKeyAction(roomOf(live, 0, { phase: 'lobby', game: null }))).toBeNull();
    expect(pauseKeyAction(null)).toBeNull();
  });

  it('is nothing to someone watching, unless they deal and the round is paused', () => {
    const base = roomOf(live, 1, { paused: { by: 1 } });
    const watching = (isHost: boolean, paused: boolean): RoomView => {
      const me: PlayerView = { ...base.players[1]!, id: 9, seat: null, name: 'w', isHost };
      return { ...base, paused: paused ? base.paused : null, me: 9, seat: null, players: [...base.players.map((p) => ({ ...p, isHost: false })), me] };
    };
    expect(pauseKeyAction(watching(false, false))).toBeNull();
    expect(pauseKeyAction(watching(false, true))).toBeNull();
    expect(pauseKeyAction(watching(true, false))).toBeNull();
    expect(pauseKeyAction(watching(true, true))).toBe('resume');
  });
});

describe('standing up from your cards for now', () => {
  it('is open once the round is under way, to whoever plays it; standing, the line says you can sit back down', () => {
    expect(standing(roomOf(finishDeal(deal([0, 1, 2], lcg(7))), 1))).toBeNull(); // before Start: leave, or wait
    expect(standing(roomOf(live, 1))).toBe(false);
    const up = withPlayer(roomOf(live, 1), 1, { standing: true });
    expect(standing(up)).toBe(true);
    expect(tableActions(up).find((a) => a.id === 'stand')).toEqual({ id: 'stand', label: 'Sit back down', on: true });
  });

  it('standing, you have no say in the votes: the others decide without you', () => {
    const up = withPlayer(roomOf(voting(live, 0), 1), 1, { standing: true });
    expect(ballot(up)).toBeNull();
    expect(ballot(roomOf(voting(live, 0), 0, { players: up.players }))).toMatchObject({ voters: 2, voted: 1 });
  });
});

describe('the vote to end the round, as the menu and the table show it', () => {
  it("counts as the engine does: those with a say, and how many voted; and says whether yours is in", () => {
    const one = voting(live, 1);
    expect(ballot(roomOf(one, 1))).toEqual({ voters: 3, voted: 1, mine: true, pressing: true });
    expect(ballot(roomOf(one, 0))).toEqual({ voters: 3, voted: 1, mine: false, pressing: true });
    expect(tableActions(roomOf(one, 1)).find((a) => a.id === 'vote')).toEqual({ id: 'vote', label: 'End round', tally: '1/3', on: true });
  });

  it('stands at the table only once someone has voted or the round drags on; the menu has it from the start', () => {
    expect(ballot(roomOf(live, 1))).toEqual({ voters: 3, voted: 0, mine: false, pressing: false });
    expect(ballot(roomOf({ ...live, reshuffles: RESHUFFLES_BEFORE_VOTE }, 1))?.pressing).toBe(true);
  });

  it('someone who left their cards, or is away, or is a bot, is not counted: the same people the server ends the round by', () => {
    const one = voting(live, 1);
    for (const patch of [{ left: true }, { connected: false }, { bot: 'medium' }] as Partial<PlayerView>[]) {
      const room = withPlayer(roomOf(one, 1), 2, patch);
      const { voters, voted } = ballot(room)!;
      expect([voted, voters]).toEqual([1, 2]);
      // Seat 0 voting too is then everyone: the server ends the round on that very count.
      expect(resolveEndVote(voting(one, 0), seatedPeople(room.players)).status.at).toBe('over');
    }
  });

  it('is not yours once you are up from your cards', () => {
    expect(ballot(withPlayer(roomOf(live, 1), 1, { left: true }))).toBeNull();
    expect(ids(withPlayer(roomOf(live, 1), 1, { left: true }))).not.toContain('vote');
  });
});
