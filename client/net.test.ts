import { describe, expect, it } from 'vitest';
import { applyIntent, checkInvariants, deal, isHidden, viewFor } from '../shared/engine';
import type { Card, GameState, Intent, RoomView } from '../shared/types';
import { freshSync, onSend, onSnapshot, predict, type Sync } from './net';

/** Deterministic rng so the deals are reproducible. */
function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
}

const roomOf = (game: GameState, you: number): RoomView => ({
  code: 'ABCD',
  phase: 'playing',
  round: 1,
  you,
  players: game.players.map((p) => ({ seat: p.seat, name: `p${p.seat}`, connected: true, score: 0, isHost: p.seat === 0, stuck: p.stuck })),
  game: viewFor(game, you),
  lastRound: null,
});

/** A tiny authoritative server for one player's messages. */
function server(game: GameState, you: number) {
  let rev = 0;
  let ack = -1;
  return {
    get game() {
      return game;
    },
    snapshot: () => ({ rev, ack, room: roomOf(game, you) }),
    /** Processes one intent from `seat`; from `you` it also advances ack. */
    apply(seat: number, intent: Intent, seq?: number) {
      const r = applyIntent(game, seat, intent);
      if (r.ok) game = r.state;
      if (seq !== undefined) ack = seq;
      rev++;
      return r.ok;
    },
  };
}

/** A deal in which both seats hold an ace on top of work pile 0 (found by trying seeds). */
function dealWithAces(): GameState {
  for (let seed = 1; seed < 20000; seed++) {
    const g = deal([0, 1], rng(seed));
    if (g.players.every((p) => (p.work[0]![0] as Card).rank === 1)) return g;
  }
  throw new Error('no suitable deal');
}

const send = (sync: Sync, intent: Intent): Sync => onSend(sync, intent);

describe('prediction', () => {
  it('renders the snapshot untouched when nothing is pending', () => {
    const s = server(deal([0, 1], rng(1)), 0);
    const sync = onSnapshot(freshSync, s.snapshot());
    expect(predict(sync)).toBe(sync.server);
  });

  it('predicts a flip with face-down cards and keeps their ids when the truth arrives', () => {
    const s = server(deal([0, 1], rng(2)), 0);
    let sync = onSnapshot(freshSync, s.snapshot());
    sync = send(sync, { k: 'flip' });
    const predicted = predict(sync)!.game!.players[0]!;
    expect(predicted.waste).toHaveLength(3);
    expect(predicted.waste.every(isHidden)).toBe(true);
    expect(checkInvariants(predict(sync)!.game!)).toBeNull();

    s.apply(0, { k: 'flip' }, sync.seq);
    sync = onSnapshot(sync, s.snapshot());
    expect(sync.pending).toHaveLength(0);
    const real = predict(sync)!.game!.players[0]!;
    expect(real.waste.map((c) => c.id)).toEqual(predicted.waste.map((c) => c.id));
    expect(real.waste.some(isHidden)).toBe(false);
  });

  it('keeps unacknowledged intents applied over a snapshot that does not include them yet', () => {
    const s = server(dealWithAces(), 0);
    let sync = onSnapshot(freshSync, s.snapshot());
    const ace = s.game.players[0]!.work[0]![0]!;
    sync = send(sync, { k: 'move', cardId: ace.id, to: { k: 'newFoundation' } });
    sync = send(sync, { k: 'flip' });
    expect(sync.pending.map((p) => p.seq)).toEqual([1, 2]);

    // The opponent acts first; the snapshot reflects only that.
    s.apply(1, { k: 'flip' });
    sync = onSnapshot(sync, s.snapshot());
    expect(sync.pending).toHaveLength(2);
    let game = predict(sync)!.game!;
    expect(game.foundations.map((f) => f.id)).toEqual([ace.id]);
    expect(game.players[0]!.waste).toHaveLength(3);
    expect(game.players[1]!.waste).toHaveLength(3);

    // The server processes the first intent only.
    s.apply(0, sync.pending[0]!.intent, 1);
    sync = onSnapshot(sync, s.snapshot());
    expect(sync.pending.map((p) => p.seq)).toEqual([2]);
    game = predict(sync)!.game!;
    expect(game.foundations).toHaveLength(1);
    expect(game.players[0]!.waste).toHaveLength(3);
    expect(checkInvariants(game)).toBeNull();
  });

  it('a lost race falls out of the replay: the card is simply back where the server says', () => {
    const base = dealWithAces();
    // Hand-build a race: one foundation at Ace, and both players hold that suit's 2 on a work pile.
    const suit = (base.players[0]!.work[0]![0] as Card).suit;
    const rig = (g: GameState): GameState => ({
      ...g,
      players: g.players.map((p) => {
        const all = [...p.nertz, ...p.stock, ...p.work.flat()] as Card[];
        const two = all.find((c) => c.suit === suit && c.rank === 2)!;
        const ace = all.find((c) => c.suit === suit && c.rank === 1)!;
        const rest = all.filter((c) => c !== two && c !== ace);
        return { ...p, nertz: rest.slice(0, 13), work: [[ace], [two], [rest[13]!], [rest[14]!]], stock: rest.slice(15), waste: [] };
      }),
    });
    const s = server(rig(base), 0);
    expect(checkInvariants(s.game)).toBeNull();
    const [mine, theirs] = s.game.players.map((p) => p.work[1]![0]!) as [Card, Card];
    const myAce = s.game.players[0]!.work[0]![0]!;
    s.apply(0, { k: 'move', cardId: myAce.id, to: { k: 'newFoundation' } });

    let sync = onSnapshot(freshSync, s.snapshot());
    const to = { k: 'foundation', id: myAce.id } as const;
    sync = send(sync, { k: 'move', cardId: mine.id, to });
    expect(predict(sync)!.game!.foundations[0]!.cards.at(-1)!.id).toBe(mine.id);

    // The opponent's identical move reaches the server first.
    expect(s.apply(1, { k: 'move', cardId: theirs.id, to })).toBe(true);
    sync = onSnapshot(sync, s.snapshot());
    // Still pending, but it no longer applies, so the replay skips it.
    expect(sync.pending).toHaveLength(1);
    let game = predict(sync)!.game!;
    expect(game.foundations[0]!.cards.at(-1)!.id).toBe(theirs.id);
    expect(game.players[0]!.work[1]!.map((c) => c.id)).toEqual([mine.id]);

    // The server rejects ours; ack still advances and pending empties.
    expect(s.apply(0, sync.pending[0]!.intent, 1)).toBe(false);
    sync = onSnapshot(sync, s.snapshot());
    expect(sync.pending).toHaveLength(0);
    game = predict(sync)!.game!;
    expect(game.players[0]!.work[1]!.map((c) => c.id)).toEqual([mine.id]);
    expect(checkInvariants(game)).toBeNull();
  });

  it('ignores a snapshot older than the last one seen, and accepts an equal rev with a newer ack', () => {
    const s = server(deal([0, 1], rng(3)), 0);
    const old = s.snapshot();
    s.apply(1, { k: 'flip' });
    let sync = onSnapshot(freshSync, s.snapshot());
    expect(onSnapshot(sync, old)).toBe(sync);

    sync = send(sync, { k: 'flip' });
    const same = { ...s.snapshot(), ack: sync.seq };
    expect(onSnapshot(sync, same).pending).toHaveLength(0);
  });

  it('does not replay outside a round', () => {
    const s = server(deal([0, 1], rng(4)), 0);
    let sync = onSnapshot(freshSync, s.snapshot());
    sync = send(sync, { k: 'flip' });
    const results = { rev: 9, ack: -1, room: { ...s.snapshot().room, phase: 'results' as const } };
    sync = onSnapshot(sync, results);
    expect(predict(sync)).toBe(sync.server);
  });

  it('a fresh connection starts seq and rev again', () => {
    let sync = send(send(freshSync, { k: 'flip' }), { k: 'flip' });
    expect(sync.seq).toBe(2);
    sync = freshSync;
    const s = server(deal([0, 1], rng(5)), 0);
    sync = onSnapshot(sync, { ...s.snapshot(), rev: 0 }); // e.g. the server restarted: rev is low again
    expect(sync.server).not.toBeNull();
    expect(send(sync, { k: 'flip' }).pending[0]!.seq).toBe(1);
  });
});
