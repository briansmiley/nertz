import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyIntent, checkInvariants, deal as dealRound, finishDeal, isHidden, openPlay, refused, startCountdown, viewFor } from '../shared/engine';
import { DEFAULT_SETTINGS } from '../shared/settings';
import type { Card, GameState, Intent, RoomView } from '../shared/types';
import * as net from './net';
import { freshSync, hello, onSend, onSnapshot, predict, type Sync } from './net';

/** A round in play: dealt, and the deal over. (The deal itself has its own tests.) */
const toPlay = (s: GameState): GameState => openPlay(startCountdown(finishDeal(s)));
const deal = (seats: readonly number[], rng: () => number): GameState => toPlay(dealRound(seats, rng));

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
  me: you,
  seat: you,
  players: game.players.map((p) => ({ id: p.seat, seat: p.seat, name: `p${p.seat}`, connected: true, score: 0, rounds: 0, isHost: p.seat === 0, stuck: p.stuck, ending: false })),
  settings: DEFAULT_SETTINGS,
  game: viewFor(game, you),
  graceMs: null,
  dealMs: null,
  startMs: null,
  clock: null, paused: null,
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
      game = r.ok ? r.state : refused(game, seat, intent); // as server/room.ts does
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
  it('predicts nothing while the cards are being dealt, while the table waits and through the count, and plays on from the snapshot that opens the round', () => {
    const dealt = dealRound([0, 1], rng(1));
    const s = server(dealt, 0);
    let sync = onSnapshot(freshSync, s.snapshot());
    expect(predict(sync)).toBe(sync.server);
    expect(sync.server!.game!.players.flatMap((p) => [...p.nertz, ...p.work.flat(), ...p.stock]).every(isHidden)).toBe(true);
    // What `net.send` asks before sending anything: every intent is refused on the dealing view, so nothing goes out.
    const intents: Intent[] = [{ k: 'flip' }, { k: 'stuck', on: true }, { k: 'hold', cardId: dealt.players[0]!.nertz.at(-1)!.id }, { k: 'nertz' }];
    for (const intent of intents) expect(applyIntent(sync.server!.game!, 0, intent).ok).toBe(false);
    // Even an intent that did go out (a hostile or stale client) is refused by both sides: prediction stays the snapshot.
    sync = send(sync, { k: 'flip' });
    expect(predict(sync)).toBe(sync.server);
    expect(s.apply(0, { k: 'flip' }, sync.seq)).toBe(false);
    sync = onSnapshot(sync, s.snapshot());
    expect(sync.pending).toHaveLength(0);

    // Ready and "1, 2, 3": the work tops are showing, the nertz top is not, and still nothing is predicted or accepted.
    for (const waiting of [finishDeal(dealt), startCountdown(finishDeal(dealt))]) {
      const w = server(waiting, 0);
      sync = onSnapshot({ ...sync, rev: -1 }, w.snapshot());
      const me = sync.server!.game!.players[0]!;
      expect(me.nertz.every(isHidden)).toBe(true);
      expect(me.work.map((pile) => isHidden(pile.at(-1)!))).toEqual([false, false, false, false]);
      const tries: Intent[] = [...intents, { k: 'hold', cardId: me.work[0]!.at(-1)!.id }, { k: 'move', cardId: me.work[0]!.at(-1)!.id, count: 1, to: { k: 'felt', x: 0, y: 0 } }];
      for (const intent of tries) {
        expect(applyIntent(sync.server!.game!, 0, intent).ok).toBe(false);
        sync = send(sync, intent);
        expect(predict(sync)).toBe(sync.server);
        expect(w.apply(0, intent, sync.seq)).toBe(false);
      }
      sync = onSnapshot(sync, w.snapshot());
      expect(sync.pending).toHaveLength(0);
    }

    const open = server(toPlay(dealt), 0);
    sync = onSnapshot({ ...sync, rev: -1 }, open.snapshot());
    expect(isHidden(sync.server!.game!.players[0]!.nertz.at(-1)!)).toBe(false);
    sync = send(sync, { k: 'flip' });
    expect(predict(sync)!.game!.players[0]!.waste).toHaveLength(1);
  });

  it('clear-first is predicted too: after my King nothing else of mine applies until the pile is in the tray; a King that lost its race holds nothing up', () => {
    // Seat 0's spades up to the Queen are a centre pile; its King of spades is the top of work pile 0.
    const g = deal([0, 1], rng(4));
    const cards = g.players[0]!.nertz.concat(g.players[0]!.work.flat(), g.players[0]!.stock) as Card[];
    const spades = cards.filter((c) => c.suit === 'S').sort((x, y) => x.rank - y.rank);
    const rest = cards.filter((c) => c.suit !== 'S');
    const king = spades[12]!;
    const rigged: GameState = {
      ...g,
      slots: g.slots.map((_, i) => (i === 0 ? spades.slice(0, 12) : [])),
      places: g.places.map((at, i) => (i === 0 ? { x: 0, y: 0, r: 0 } : at)),
      players: g.players.map((p) => (p.seat === 0 ? { ...p, nertz: rest.slice(0, 3), work: [[king], [], [], []], down: [0, 0, 0, 0], stock: rest.slice(3), waste: [] } : p)),
    };
    expect(checkInvariants(rigged)).toBeNull();
    const kingMove: Intent = { k: 'move', cardId: king.id, count: 1, to: { k: 'slot', i: 0 } };
    const s = server(rigged, 0);
    let sync = onSnapshot(freshSync, s.snapshot());
    sync = send(sync, kingMove);
    const blocked = predict(sync)!.game!;
    expect(blocked.slots[0]).toHaveLength(13);
    // What `net.send` asks: everything but the clear is refused on the predicted table, before the server has said a word.
    const nertzTop = blocked.players[0]!.nertz.at(-1)!.id;
    for (const intent of [{ k: 'flip' }, { k: 'stuck', on: true }, { k: 'hold', cardId: nertzTop }, { k: 'nertz' }] as Intent[]) expect(applyIntent(blocked, 0, intent).ok).toBe(false);
    expect(applyIntent(blocked, 0, { k: 'clear', slot: 0 }).ok).toBe(true);
    // King and clear in flight together; a flip sent between them (a stale client) is dropped by both sides.
    sync = send(send(sync, { k: 'flip' }), { k: 'clear', slot: 0 });
    expect(predict(sync)!.game!.slots[0]).toEqual([]);
    expect(predict(sync)!.game!.tray.map((pile) => pile.length)).toEqual([13]);
    expect(predict(sync)!.game!.players[0]!.waste).toHaveLength(0);
    expect(sync.pending.map((p) => s.apply(0, p.intent, p.seq))).toEqual([true, false, true]);
    sync = onSnapshot(sync, s.snapshot());
    expect(predict(sync)).toBe(sync.server);
    sync = send(sync, { k: 'flip' });
    expect(predict(sync)!.game!.players[0]!.waste).toHaveLength(1);

    // The other way round: the server refuses my King (the pile is no longer there for it). I am not held up by a pile I never finished.
    const lost = server({ ...rigged, slots: rigged.slots.map(() => []) }, 0);
    sync = onSnapshot(freshSync, s2snap(rigged));
    sync = send(send(sync, kingMove), { k: 'flip' });
    expect(predict(sync)!.game!.players[0]!.waste).toHaveLength(0); // predicted: blocked behind my King
    expect(sync.pending.map((p) => lost.apply(0, p.intent, p.seq))).toEqual([false, true]);
    sync = onSnapshot(sync, lost.snapshot());
    expect(predict(sync)!.game!.players[0]!.waste).toHaveLength(1); // the truth: the King went home, the flip counted
    function s2snap(game: GameState) {
      return { rev: 0, ack: -1, room: roomOf(game, 0) };
    }
  });

  it('renders the snapshot untouched when nothing is pending', () => {
    const s = server(deal([0, 1], rng(1)), 0);
    const sync = onSnapshot(freshSync, s.snapshot());
    expect(predict(sync)).toBe(sync.server);
  });

  it('predicts cards dealt off the stock one by one, face-down, and keeps their ids when the group turns up', () => {
    const s = server(deal([0, 1], rng(2)), 0);
    let sync = onSnapshot(freshSync, s.snapshot());
    const mine = () => predict(sync)!.game!.players[0]!;
    sync = send(sync, { k: 'flip' });
    expect([mine().waste.length, mine().dealt]).toEqual([1, 1]);
    sync = send(sync, { k: 'flip' });
    expect([mine().waste.length, mine().dealt]).toEqual([2, 2]);
    // The server has the first card only: the snapshot shows it face-down too, and the second is still replayed over it.
    s.apply(0, { k: 'flip' }, 1);
    sync = onSnapshot(sync, s.snapshot());
    expect(sync.server!.game!.players[0]!).toMatchObject({ dealt: 1 });
    expect(sync.server!.game!.players[0]!.waste.every(isHidden)).toBe(true);
    expect([mine().waste.length, mine().dealt]).toEqual([2, 2]);
    // The third is predicted: the group counts as turned up, but its faces are the server's to show.
    sync = send(sync, { k: 'flip' });
    const predicted = mine();
    expect([predicted.waste.length, predicted.dealt]).toEqual([3, 0]);
    expect(predicted.waste.every(isHidden)).toBe(true);
    expect(checkInvariants(predict(sync)!.game!)).toBeNull();
    expect(applyIntent(predict(sync)!.game!, 0, { k: 'hold', cardId: predicted.waste.at(-1)!.id }).ok).toBe(false); // not until it is seen

    s.apply(0, { k: 'flip' }, 2);
    s.apply(0, { k: 'flip' }, 3);
    sync = onSnapshot(sync, s.snapshot());
    expect(sync.pending).toHaveLength(0);
    const real = mine();
    expect(real.waste.map((c) => c.id)).toEqual(predicted.waste.map((c) => c.id));
    expect(real.waste.some(isHidden)).toBe(false);
    expect(real.dealt).toBe(0);
  });

  it('keeps unacknowledged intents applied over a snapshot that does not include them yet', () => {
    const s = server(dealWithAces(), 0);
    let sync = onSnapshot(freshSync, s.snapshot());
    const ace = s.game.players[0]!.work[0]![0]!;
    sync = send(sync, { k: 'move', cardId: ace.id, count: 1, to: { k: 'felt', x: 0, y: 0 } });
    sync = send(sync, { k: 'flip' });
    expect(sync.pending.map((p) => p.seq)).toEqual([1, 2]);

    // The opponent acts first; the snapshot reflects only that.
    s.apply(1, { k: 'flip' });
    sync = onSnapshot(sync, s.snapshot());
    expect(sync.pending).toHaveLength(2);
    let game = predict(sync)!.game!;
    expect(game.slots[0]!.map((c) => c.id)).toEqual([ace.id]);
    expect(game.players[0]!.waste).toHaveLength(1);
    expect(game.players[1]!.waste).toHaveLength(1);

    // The server processes the first intent only.
    s.apply(0, sync.pending[0]!.intent, 1);
    sync = onSnapshot(sync, s.snapshot());
    expect(sync.pending.map((p) => p.seq)).toEqual([2]);
    game = predict(sync)!.game!;
    expect(game.slots.filter((pile) => pile.length > 0)).toHaveLength(1);
    expect(game.players[0]!.waste).toHaveLength(1);
    expect(checkInvariants(game)).toBeNull();
  });

  it('a lost race falls out of the replay: the card is simply back where the server says', () => {
    const base = dealWithAces();
    // Hand-build a race: one centre pile at its Ace, and both players hold that suit's 2 on a work pile.
    const suit = (base.players[0]!.work[0]![0] as Card).suit;
    const rig = (g: GameState): GameState => ({
      ...g,
      players: g.players.map((p) => {
        const all = [...p.nertz, ...p.stock, ...p.work.flat()] as Card[];
        const two = all.find((c) => c.suit === suit && c.rank === 2)!;
        const ace = all.find((c) => c.suit === suit && c.rank === 1)!;
        const rest = all.filter((c) => c !== two && c !== ace);
        return { ...p, nertz: rest.slice(0, 13), work: [[ace], [two], [rest[13]!], [rest[14]!]], down: [0, 0, 0, 0], stock: rest.slice(15), waste: [] };
      }),
    });
    const s = server(rig(base), 0);
    expect(checkInvariants(s.game)).toBeNull();
    const [mine, theirs] = s.game.players.map((p) => p.work[1]![0]!) as [Card, Card];
    const myAce = s.game.players[0]!.work[0]![0]!;
    s.apply(0, { k: 'move', cardId: myAce.id, count: 1, to: { k: 'felt', x: 0, y: 0 } });

    let sync = onSnapshot(freshSync, s.snapshot());
    const to = { k: 'slot', i: 0 } as const;
    sync = send(sync, { k: 'move', cardId: mine.id, count: 1, to });
    expect(predict(sync)!.game!.slots[0]!.at(-1)!.id).toBe(mine.id);

    // The opponent's identical move reaches the server first.
    expect(s.apply(1, { k: 'move', cardId: theirs.id, count: 1, to })).toBe(true);
    sync = onSnapshot(sync, s.snapshot());
    // Still pending, but it no longer applies, so the replay skips it.
    expect(sync.pending).toHaveLength(1);
    let game = predict(sync)!.game!;
    expect(game.slots[0]!.at(-1)!.id).toBe(theirs.id);
    expect(game.players[0]!.work[1]!.map((c) => c.id)).toEqual([mine.id]);

    // The server rejects ours; ack still advances and pending empties.
    expect(s.apply(0, sync.pending[0]!.intent, 1)).toBe(false);
    sync = onSnapshot(sync, s.snapshot());
    expect(sync.pending).toHaveLength(0);
    game = predict(sync)!.game!;
    expect(game.players[0]!.work[1]!.map((c) => c.id)).toEqual([mine.id]);
    expect(checkInvariants(game)).toBeNull();
  });

  it('a drag is two intents: hold is predicted at once, and release (or a move) puts the hand down again', () => {
    const s = server(dealWithAces(), 0);
    let sync = onSnapshot(freshSync, s.snapshot());
    const ace = s.game.players[0]!.work[0]![0]!;
    const me = () => predict(sync)!.game!.players[0]!;

    sync = send(sync, { k: 'hold', cardId: ace.id });
    expect(me().holding).toBe(ace.id);
    // Somebody else's move arrives first: the hold is still pending and still shown.
    s.apply(1, { k: 'flip' });
    sync = onSnapshot(sync, s.snapshot());
    expect(me().holding).toBe(ace.id);

    // Dropped nowhere: release. Both are acknowledged and the server agrees nothing is held.
    sync = send(sync, { k: 'release' });
    expect(sync.pending.map((p) => p.intent.k)).toEqual(['hold', 'release']);
    expect(me().holding).toBeNull();
    for (const p of sync.pending) s.apply(0, p.intent, p.seq);
    sync = onSnapshot(sync, s.snapshot());
    expect(sync.pending).toHaveLength(0);
    expect(me().holding).toBeNull();

    // Picked up again and put down in the middle: the move itself clears the hold, no release is sent.
    sync = send(sync, { k: 'hold', cardId: ace.id });
    sync = send(sync, { k: 'move', cardId: ace.id, count: 1, to: { k: 'felt', x: 0, y: 0 } });
    expect(me().holding).toBeNull();
    expect(predict(sync)!.game!.slots[0]!.map((c) => c.id)).toEqual([ace.id]);
    for (const p of sync.pending) expect(s.apply(0, p.intent, p.seq)).toBe(true);
    sync = onSnapshot(sync, s.snapshot());
    expect(s.game.players[0]!.holding).toBeNull();
    expect(checkInvariants(predict(sync)!.game!)).toBeNull();
  });

  it('a hold the server refuses (Nertz was called first) drops out of the prediction: the drag is cancelled', () => {
    const base = dealWithAces();
    // Seat 1 is about to go out.
    const s = server({ ...base, players: base.players.map((p) => (p.seat === 1 ? { ...p, stock: [...p.stock, ...p.nertz], nertz: [] } : p)) }, 0);
    let sync = onSnapshot(freshSync, s.snapshot());
    const ace = s.game.players[0]!.work[0]![0]!;
    sync = send(sync, { k: 'hold', cardId: ace.id });
    expect(predict(sync)!.game!.players[0]!.holding).toBe(ace.id);

    expect(s.apply(1, { k: 'nertz' })).toBe(true); // reaches the server before our hold
    expect(s.apply(0, sync.pending[0]!.intent, sync.seq)).toBe(false);
    sync = onSnapshot(sync, s.snapshot());
    const game = predict(sync)!.game!;
    expect(game.players[0]!.holding).toBeNull();
    expect(game.grace).toEqual([]);
  });

  it('predicts through the grace window: the held card may still land, and only it', () => {
    const base = dealWithAces();
    const s = server({ ...base, players: base.players.map((p) => (p.seat === 1 ? { ...p, stock: [...p.stock, ...p.nertz], nertz: [] } : p)) }, 0);
    let sync = onSnapshot(freshSync, s.snapshot());
    const ace = s.game.players[0]!.work[0]![0]!;
    sync = send(sync, { k: 'hold', cardId: ace.id });
    s.apply(0, sync.pending[0]!.intent, sync.seq);
    s.apply(1, { k: 'nertz' }); // we were holding a playable card: we are in grace
    sync = onSnapshot(sync, { ...s.snapshot(), room: { ...s.snapshot().room, graceMs: 4000 } });
    expect(predict(sync)!.game!.grace).toEqual([0]);

    // A flip is refused locally-replayed too; the held card's move is predicted and empties grace.
    sync = send(sync, { k: 'flip' });
    expect(predict(sync)!.game!.players[0]!.waste).toHaveLength(0);
    sync = send(sync, { k: 'move', cardId: ace.id, count: 1, to: { k: 'felt', x: 0, y: 0 } });
    const game = predict(sync)!.game!;
    expect(game.slots[0]!.map((c) => c.id)).toEqual([ace.id]);
    expect(game.grace).toEqual([]);
    expect(game.players[0]!.holding).toBeNull();
    expect(checkInvariants(game)).toBeNull();
  });

  it('clearing a finished pile is predicted, and only for the player who placed the King', () => {
    const base = deal([0, 1], rng(7));
    // Seat 0's whole spade suit stands in slot 3.
    const spades = (p: GameState['players'][number]) => ([...p.nertz, ...p.work.flat(), ...p.stock] as Card[]).filter((c) => c.suit === 'S').sort((a, b) => a.rank - b.rank);
    const pile = spades(base.players[0]!);
    const strip = (cards: readonly unknown[]) => (cards as Card[]).filter((c) => !pile.includes(c));
    const rigged: GameState = {
      ...base,
      slots: base.slots.map((x, i) => (i === 3 ? pile : x)),
      places: base.places.map((at, i) => (i === 3 ? { x: 0, y: 0, r: 0 } : at)),
      players: base.players.map((p) => {
        if (p.seat !== 0) return p;
        const rest = strip([...p.nertz, ...p.work.flat(), ...p.stock]);
        return { ...p, nertz: rest.slice(0, 13), work: [[rest[13]!], [rest[14]!], [rest[15]!], [rest[16]!]], down: [0, 0, 0, 0], stock: rest.slice(17) };
      }),
    };
    expect(checkInvariants(rigged)).toBeNull();

    const theirs = server(rigged, 1);
    let sync = onSnapshot(freshSync, theirs.snapshot());
    sync = send(sync, { k: 'clear', slot: 3 });
    expect(predict(sync)!.game!.tray).toHaveLength(0); // not theirs to clear: the replay skips it

    const mine = server(rigged, 0);
    sync = onSnapshot(freshSync, mine.snapshot());
    sync = send(sync, { k: 'clear', slot: 3 });
    const game = predict(sync)!.game!;
    expect(game.slots[3]).toEqual([]);
    expect(game.tray.map((t) => t.at(-1)!.rank)).toEqual([13]);
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

  it('says create until it knows the table code, then join', () => {
    expect(hello(null, 'Ada', 'tokentoken')).toEqual({ t: 'create', name: 'Ada', token: 'tokentoken' });
    expect(hello('ABCD', 'Ada', 'tokentoken')).toEqual({ t: 'join', room: 'ABCD', name: 'Ada', token: 'tokentoken' });
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

describe('a refused drop in the replay', () => {
  it('ends the hold, as it will on the server: the predicted hand is empty once the race is known to be lost', () => {
    const s = server(dealWithAces(), 0);
    const [mine, theirs] = s.game.players.map((p) => p.work[0]![0]!) as [Card, Card];
    const to = { k: 'felt', x: 0, y: 0 } as const;
    let sync = onSnapshot(freshSync, s.snapshot());
    sync = send(sync, { k: 'hold', cardId: mine.id });
    sync = send(sync, { k: 'move', cardId: mine.id, count: 1, to });
    expect(predict(sync)!.game!.slots[0]!.map((c) => c.id)).toEqual([mine.id]);

    // The other Ace lands first. Our hold has reached the server, our move has not been answered yet.
    s.apply(0, { k: 'hold', cardId: mine.id }, 1);
    s.apply(1, { k: 'move', cardId: theirs.id, count: 1, to });
    sync = onSnapshot(sync, s.snapshot());
    expect(sync.server!.game!.players[0]!.holding).toBe(mine.id); // the server still thinks we hold it...
    const game = predict(sync)!.game!;
    expect(game.players[0]!.holding).toBeNull(); // ...the replay already knows the drop will put it down
    expect(game.players[0]!.work[0]!.map((c) => c.id)).toEqual([mine.id]);

    // And the server agrees when it gets there.
    expect(s.apply(0, { k: 'move', cardId: mine.id, count: 1, to }, 2)).toBe(false);
    sync = onSnapshot(sync, s.snapshot());
    expect(sync.pending).toHaveLength(0);
    expect(predict(sync)).toBe(sync.server);
    expect(sync.server!.game!.players[0]!.holding).toBeNull();
  });
});

describe('the store over a (fake) socket', () => {
  /** Just enough of a browser WebSocket: the test plays the server. */
  class FakeSocket {
    static OPEN = 1;
    static all: FakeSocket[] = [];
    readyState = 0;
    sent: unknown[] = [];
    onopen: (() => void) | null = null;
    onmessage: ((e: { data: string }) => void) | null = null;
    onclose: ((e: { code: number }) => void) | null = null;
    constructor(readonly url: string) {
      FakeSocket.all.push(this);
    }
    send(data: string): void {
      this.sent.push(JSON.parse(data));
    }
    close(): void {}
    open(): void {
      this.readyState = FakeSocket.OPEN;
      this.onopen?.();
    }
    deliver(msg: unknown): void {
      this.onmessage?.({ data: JSON.stringify(msg) });
    }
    drop(): void {
      this.readyState = 3;
      this.onclose?.({ code: 1006 });
    }
  }

  afterEach(() => {
    net.leave();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  // Regression: after a reconnect the socket is open before its first snapshot arrives. `send` judged the intent
  // against the old table, then rendered `predict` of a connection that had no snapshot: null, i.e. the home screen.
  it('sends and predicts nothing between a reconnect and its first snapshot, and keeps the table on screen', () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeSocket);
    vi.stubGlobal('location', { origin: 'http://localhost:5173' });
    FakeSocket.all = [];
    const s = server(deal([0, 1], rng(8)), 0);

    net.join('ABCD', 'Ada');
    const first = FakeSocket.all[0]!;
    first.open();
    expect(first.sent).toMatchObject([{ t: 'join', room: 'ABCD', name: 'Ada' }, { t: 'deck' }]);
    expect(net.send({ k: 'flip' })).toBe(false); // nothing to play on yet
    first.deliver({ t: 'state', ...s.snapshot() });
    expect(net.current()).toMatchObject({ status: 'online', room: { phase: 'playing' } });
    expect(net.send({ k: 'flip' })).toBe(true);
    expect(first.sent.at(-1)).toEqual({ t: 'intent', seq: 1, intent: { k: 'flip' } });

    first.drop();
    expect(net.current().status).toBe('reconnecting');
    vi.advanceTimersByTime(300);
    const second = FakeSocket.all[1]!;
    second.open();
    expect(second.sent).toHaveLength(2); // the join, and which deck
    const shown = net.current().room;
    expect(shown?.game).toBeTruthy();

    expect(net.send({ k: 'flip' })).toBe(false);
    expect(second.sent).toHaveLength(2); // nothing went out
    expect(net.current().room).toBe(shown); // and the table is still what is rendered

    second.deliver({ t: 'state', ...s.snapshot() });
    expect(net.current().status).toBe('online');
    expect(net.send({ k: 'flip' })).toBe(true);
    expect(second.sent.at(-1)).toEqual({ t: 'intent', seq: 1, intent: { k: 'flip' } }); // seq starts over with the connection
    expect(net.current().room!.game!.players[0]!.waste).toHaveLength(1);
  });
});
