// Which cue fires for which change of the rendered table. The frames are
// produced the way the client really produces them: server snapshots with the
// player's unacknowledged intents replayed over them (net.ts).
import { describe, expect, it } from 'vitest';
import { applyIntent, deal as dealRound, finishDeal, refused, viewFor } from '../shared/engine';

/** A round in play: dealt, and the deal over. */
const deal: typeof dealRound = (...a) => finishDeal(dealRound(...a));
import type { Card, GameState, Intent, PileRef, RoomView, Suit } from '../shared/types';
import { freshSync, onSend, onSnapshot, predict, type Sync } from './net';
import { graceTicking, soundCues, type Cue, type Frame } from './soundEvents';

function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
}

/** Two players whose work piles are single face-up cards: A-spades, 2-spades, A-hearts and a black 5 on which nothing fits yet. */
function rigged(emptyNertz: number[] = []): GameState {
  const g = deal([0, 1], rng(7));
  return {
    ...g,
    players: g.players.map((p) => {
      const cards = [...p.nertz, ...p.work.flat(), ...p.stock] as Card[];
      const take = (suit: Suit, rank: number) => cards.splice(cards.findIndex((c) => c.suit === suit && c.rank === rank), 1)[0]!;
      const work = [[take('S', 1)], [take('S', 2)], [take('H', 1)], [take('C', 5)]];
      const waste = [take('D', 4)]; // fits on the black 5
      const nertz = emptyNertz.includes(p.seat) ? [] : cards.splice(0, 13);
      return { ...p, work, down: [0, 0, 0, 0], nertz, stock: cards, waste };
    }),
  };
}

const roomOf = (game: GameState, you: number, extra: Partial<RoomView> = {}): RoomView => ({
  code: 'ABCD',
  phase: 'playing',
  round: 1,
  you,
  players: game.players.map((p) => ({ seat: p.seat, name: `p${p.seat}`, connected: true, score: 0, isHost: p.seat === 0, stuck: p.stuck })),
  settings: { fewerDown: true, centre: 'spots' },
  game: viewFor(game, you),
  graceMs: null,
  dealMs: null,
  lastRound: null,
  ...extra,
});

/** The same two hands on a table without fixed places. */
const riggedFree = (): GameState => ({ ...rigged(), table: 'free', places: rigged().slots.map(() => null) });

/** One client (seat 0) and the server it talks to. Every step returns the cues for the change in what is rendered. */
function session(start: GameState) {
  let game = start;
  let rev = 0;
  let ack = 0;
  let sync: Sync = onSnapshot(freshSync, { rev, ack, room: roomOf(game, 0) });
  let frame: Frame = { room: predict(sync), online: true };
  const queue: { seq: number; intent: Intent }[] = [];
  const render = (online = true): Cue[] => {
    const next: Frame = { room: predict(sync), online };
    const cues = soundCues(frame, next);
    frame = next;
    return cues;
  };
  const apply = (seat: number, intent: Intent) => {
    const r = applyIntent(game, seat, intent);
    game = r.ok ? r.state : refused(game, seat, intent);
  };
  const snapshot = () => (sync = onSnapshot(sync, { rev: ++rev, ack, room: roomOf(game, 0) }));
  return {
    get game() {
      return game;
    },
    get frame() {
      return frame;
    },
    /** I do something: it is predicted and rendered at once, and is on its way to the server. */
    me(intent: Intent): Cue[] {
      sync = onSend(sync, intent);
      queue.push({ seq: sync.seq, intent });
      return render();
    },
    /** The server gets round to everything I have sent, and its snapshot arrives. */
    confirm(): Cue[] {
      for (const { seq, intent } of queue.splice(0)) {
        apply(0, intent);
        ack = seq;
      }
      snapshot();
      return render();
    },
    /** The other player does something and the snapshot arrives (my sent intents still in flight). */
    them(intent: Intent): Cue[] {
      apply(1, intent);
      snapshot();
      return render();
    },
    /** The connection drops: what was in flight is lost, the table stays on screen. Then a new socket's first snapshot. */
    reconnect(meanwhile: () => void): Cue[][] {
      queue.splice(0);
      sync = { ...sync, pending: [] };
      const dropped = render(false);
      meanwhile();
      sync = onSnapshot(freshSync, { rev: 0, ack: -1, room: roomOf(game, 0) });
      return [dropped, render(true)];
    },
    act: apply,
  };
}

const move = (cardId: string, to: PileRef, count = 1): Intent => ({ k: 'move', cardId, count, to });
const slot = (i: number): PileRef => ({ k: 'slot', i });
const work = (i: number): PileRef => ({ k: 'work', i });
const top = (g: GameState, seat: number, pile: number) => g.players[seat]!.work[pile]!.at(-1)!.id;

describe('sound cues from rendered state', () => {
  it('my own move sounds when it is predicted, and not again when the server confirms it', () => {
    const s = session(rigged());
    const ace = top(s.game, 0, 0);
    expect(s.me({ k: 'hold', cardId: ace })).toEqual([{ k: 'pickup', who: 'me' }]);
    expect(s.me(move(ace, slot(3)))).toEqual([{ k: 'centre', who: 'me', rank: 1 }]);
    expect(s.confirm()).toEqual([]);
    // The next card up the pile is one step up the scale.
    const two = top(s.game, 0, 1);
    s.me({ k: 'hold', cardId: two });
    expect(s.me(move(two, slot(3)))).toEqual([{ k: 'centre', who: 'me', rank: 2 }]);
    expect(s.confirm()).toEqual([]);
  });

  it('a predicted move the server refuses gets the going-home tap when the card comes back, once', () => {
    const s = session(rigged());
    const mine = top(s.game, 0, 0);
    expect(s.them(move(top(s.game, 1, 0), slot(3)))).toEqual([{ k: 'centre', who: 'other', rank: 1 }]);
    // Both go for the 2 of spades on that ace. Theirs arrives first; mine is already on its way.
    s.me({ k: 'hold', cardId: top(s.game, 0, 1) });
    const two = top(s.game, 0, 1);
    expect(s.me(move(two, slot(3)))).toEqual([{ k: 'centre', who: 'me', rank: 2 }]);
    // Their snapshot: the pile already holds their 2, so my prediction no longer applies and my card is back.
    const lost = s.them(move(top(s.game, 1, 1), slot(3)));
    expect(lost).toContainEqual({ k: 'home', who: 'me' });
    expect(lost).toContainEqual({ k: 'centre', who: 'other', rank: 2 });
    expect(lost).toHaveLength(2);
    expect(s.confirm()).toEqual([]); // the refusal itself changes nothing more
    expect(s.game.players[0]!.work[1]!.at(-1)!.id).toBe(two);
    expect(mine).toBe(top(s.game, 0, 0));
  });

  it('a card picked up and put down nowhere gets the same quiet tap', () => {
    const s = session(rigged());
    expect(s.me({ k: 'hold', cardId: top(s.game, 0, 3) })).toEqual([{ k: 'pickup', who: 'me' }]);
    expect(s.me({ k: 'release' })).toEqual([{ k: 'home', who: 'me' }]);
    expect(s.confirm()).toEqual([]);
  });

  it('work-pile drops, stock flips and turning the waste over, for me and (marked as such) for the others', () => {
    const s = session(rigged());
    const four = s.game.players[0]!.waste.at(-1)!.id;
    s.me({ k: 'hold', cardId: four });
    expect(s.me(move(four, work(3)))).toEqual([{ k: 'work', who: 'me' }]);
    expect(s.me({ k: 'flip' })).toEqual([{ k: 'flip', who: 'me' }]);
    expect(s.confirm()).toEqual([]);

    expect(s.them({ k: 'hold', cardId: s.game.players[1]!.waste.at(-1)!.id })).toEqual([{ k: 'pickup', who: 'other' }]);
    expect(s.them(move(s.game.players[1]!.waste.at(-1)!.id, work(3)))).toEqual([{ k: 'work', who: 'other' }]);
    expect(s.them({ k: 'flip' })).toEqual([{ k: 'flip', who: 'other' }]);
    // A run of two cards moved together is one drop, not two.
    const run = s.game.players[0]!.work[3]![0]!.id;
    s.me({ k: 'hold', cardId: run });
    expect(s.game.players[0]!.work[3]).toHaveLength(2);
    // Flip until the stock is gone, then once more: the waste goes back under.
    let cues: Cue[] = [];
    for (let i = 0; i < 20 && s.frame.room!.game!.players[0]!.stock.length > 0; i++) cues = s.me({ k: 'flip' });
    expect(cues).toEqual([{ k: 'flip', who: 'me' }]);
    expect(s.me({ k: 'flip' })).toEqual([{ k: 'recycle', who: 'me' }]);
  });

  it('a King gets the chime instead of a ding, and clearing the pile the slide', () => {
    const g = rigged();
    const spades = (seat: number) => {
      const p = g.players[seat]!;
      return ([...p.nertz, ...p.work.flat(), ...p.stock, ...p.waste] as Card[]).filter((c) => c.suit === 'S').sort((a, b) => a.rank - b.rank);
    };
    // Seat 0's spades up to the Queen are already in slot 2, and its King lies on a work pile.
    const mine = spades(0);
    const kingCard = mine[12]!;
    const start: GameState = {
      ...g,
      slots: g.slots.map((s, i) => (i === 2 ? mine.slice(0, 12) : s)),
      players: g.players.map((p) => {
        if (p.seat !== 0) return p;
        const gone = new Set(mine.map((c) => c.id));
        const keep = (pile: readonly (typeof p.stock)[number][]) => pile.filter((c) => !gone.has(c.id));
        return { ...p, nertz: keep(p.nertz), stock: keep(p.stock), waste: keep(p.waste), work: [[kingCard], [], p.work[2]!, p.work[3]!] };
      }),
    };
    const s = session(start);
    s.me({ k: 'hold', cardId: kingCard.id });
    expect(s.me(move(kingCard.id, slot(2)))).toEqual([{ k: 'king', who: 'me' }]);
    expect(s.me({ k: 'clear', slot: 2 })).toEqual([{ k: 'clear', who: 'me' }]); // thirteen cards, one sound
    expect(s.confirm()).toEqual([]);
  });

  it('Nertz is announced once, to everyone, whoever called it', () => {
    const s = session(rigged([1]));
    expect(s.them({ k: 'nertz' })).toEqual([{ k: 'nertz' }]);
    expect(s.them({ k: 'flip' })).toEqual([]); // the table is frozen: nothing more
    const mine = session(rigged([0]));
    expect(mine.me({ k: 'nertz' })).toEqual([{ k: 'nertz' }]);
    expect(mine.confirm()).toEqual([]);
  });

  it('a card the Nertz call takes out of my hand goes home with a tap, alongside the call', () => {
    const s = session(rigged([1]));
    s.me({ k: 'hold', cardId: top(s.game, 0, 3) }); // the 5: nowhere to go, so no grace for it
    s.confirm();
    const cues = s.them({ k: 'nertz' });
    expect(cues).toContainEqual({ k: 'nertz' });
    expect(cues).toContainEqual({ k: 'home', who: 'me' });
  });

  it('nothing is replayed across a reconnect, however much happened meanwhile', () => {
    const s = session(rigged());
    const ace = top(s.game, 0, 0);
    s.me({ k: 'hold', cardId: ace });
    s.me(move(ace, slot(0))); // predicted, never reaches the server
    const [dropped, back] = s.reconnect(() => {
      s.act(1, move(top(s.game, 1, 0), slot(1)));
      s.act(1, { k: 'flip' });
      s.act(1, move(top(s.game, 1, 1), slot(1)));
    });
    expect(dropped).toEqual([]); // my lost prediction snapping back is not a refusal
    expect(back).toEqual([]);
    // And from there on the table is live again.
    expect(s.them({ k: 'flip' })).toEqual([{ k: 'flip', who: 'other' }]);
  });

  it('a first render, a reload into a running round, and re-rendering the same state are silent', () => {
    const room = roomOf(rigged(), 0);
    expect(soundCues(null, { room, online: true })).toEqual([]);
    expect(soundCues({ room: null, online: true }, { room, online: true })).toEqual([]);
    expect(soundCues({ room, online: true }, { room, online: true })).toEqual([]);
    expect(soundCues({ room, online: true }, { room: { ...room }, online: true })).toEqual([]);
    expect(soundCues({ room, online: true }, { room: { ...room, code: 'WXYZ' }, online: true })).toEqual([]);
  });

  it('a new round is dealt: the deal cue, from the lobby and from the score sheet, and nothing else', () => {
    const game = rigged();
    const lobby = roomOf(game, 0, { phase: 'lobby', round: 0, game: null });
    const first = roomOf(game, 0);
    expect(soundCues({ room: lobby, online: true }, { room: first, online: true })).toEqual([{ k: 'deal' }]);
    const sheet: RoomView = { ...first, phase: 'results' };
    const second = roomOf(deal([0, 1], rng(8)), 0, { round: 2 });
    expect(soundCues({ room: sheet, online: true }, { room: second, online: true })).toEqual([{ k: 'deal' }]);
    // The round being scored is not a deal, and the scored table makes no card sounds.
    expect(soundCues({ room: first, online: true }, { room: sheet, online: true })).toEqual([]);
    expect(soundCues({ room: sheet, online: true }, { room: { ...sheet, players: [] }, online: true })).toEqual([]);
  });

  it('the grace countdown ticks only for a player still holding a card', () => {
    const g = rigged([1]);
    const held = top(g, 0, 0); // an ace: it has somewhere to go, so seat 0 is given grace
    let state = applyIntent(g, 0, { k: 'hold', cardId: held });
    if (!state.ok) throw new Error(state.reason);
    state = applyIntent(state.state, 1, { k: 'nertz' });
    if (!state.ok) throw new Error(state.reason);
    expect(state.state.grace).toEqual([0]);
    expect(graceTicking(roomOf(state.state, 0))).toBe(true);
    expect(graceTicking(roomOf(state.state, 1))).toBe(false); // the caller just waits
    expect(graceTicking(roomOf(g, 0))).toBe(false);
    expect(graceTicking({ ...roomOf(state.state, 0), phase: 'results' })).toBe(false);
    expect(graceTicking(null)).toBe(false);
  });
});

describe('a table without fixed places', () => {
  const felt = (x: number, y: number): PileRef => ({ k: 'felt', x, y });

  it('an Ace put down on the felt sounds like any card to the middle, once', () => {
    const s = session(riggedFree());
    const ace = top(s.game, 0, 0);
    expect(s.me({ k: 'hold', cardId: ace })).toEqual([{ k: 'pickup', who: 'me' }]);
    expect(s.me(move(ace, felt(0.1, 0.3)))).toEqual([{ k: 'centre', who: 'me', rank: 1 }]);
    expect(s.confirm()).toEqual([]);
  });

  it('is silent when the server files my pile under another slot than I predicted: it has not moved', () => {
    const s = session(riggedFree());
    const mine = top(s.game, 0, 0);
    const theirs = top(s.game, 1, 2);
    // Their Ace reaches the server first and takes slot 0; mine, predicted into slot 0, ends up in slot 1 at the same place.
    s.act(1, move(theirs, felt(-0.5, -0.3)));
    expect(s.me(move(mine, felt(0.4, 0.3)))).toEqual([{ k: 'centre', who: 'me', rank: 1 }]);
    expect(s.frame.room!.game!.slots[0]!.map((c) => c.id)).toEqual([mine]);
    expect(s.confirm()).toEqual([{ k: 'centre', who: 'other', rank: 1 }]); // their card arriving, and nothing for mine
    expect(s.frame.room!.game!.slots.slice(0, 2).map((p) => p[0]!.id)).toEqual([theirs, mine]);
    expect(s.frame.room!.game!.places[1]).toMatchObject({ x: 0.4, y: 0.3 });
  });

  it('an Ace that lost the race for its patch of felt goes home with the dull tap', () => {
    const s = session(riggedFree());
    const mine = top(s.game, 0, 0);
    const theirs = top(s.game, 1, 2);
    s.act(1, move(theirs, felt(0.42, 0.28)));
    s.me({ k: 'hold', cardId: mine });
    expect(s.me(move(mine, felt(0.4, 0.3)))).toEqual([{ k: 'centre', who: 'me', rank: 1 }]);
    const cues = s.confirm();
    expect(cues).toContainEqual({ k: 'home', who: 'me' });
    expect(cues).toContainEqual({ k: 'centre', who: 'other', rank: 1 });
    expect(top(s.frame.room!.game!, 0, 0)).toBe(mine);
  });
});
