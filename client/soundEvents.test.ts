// Which cue fires for which change of the rendered table. The frames are
// produced the way the client really produces them: server snapshots with the
// player's unacknowledged intents replayed over them (net.ts).
import { describe, expect, it } from 'vitest';
import { applyIntent, deal as dealRound, finishDeal, refused, startCountdown } from '../shared/engine';
import { START_BEAT_MS, START_MS } from '../shared/protocol';
import { felt, inPlay, lcg, move, rig, roomOf, slot, toPlay, withPile, work, workTop } from '../shared/testkit';
import type { Card, GameState, Intent, RoomView } from '../shared/types';
import { freshSync, onSend, onSnapshot, predict, type Sync } from './net';
import { beatenTo, graceTicking, soundCues, startBeats, type Cue, type Frame } from './soundEvents';

/** Two players whose work piles are single face-up cards: A-spades, 2-spades, A-hearts and a black 5 on which nothing fits yet; on the waste, a red 4 that fits on the 5. */
const rigged = (emptyNertz: number[] = []): GameState => rig(inPlay([0, 1], lcg(7)), { work: ['S1', 'S2', 'H1', 'C5'], waste: ['D4'], emptyNertz });

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

describe('sound cues from rendered state', () => {
  it('my own move sounds when it is predicted, and not again when the server confirms it', () => {
    const s = session(rigged());
    const ace = workTop(s.game, 0, 0);
    expect(s.me({ k: 'hold', cardId: ace })).toEqual([{ k: 'pickup', who: 'me' }]);
    expect(s.me(move(ace, felt(0, 0)))).toEqual([{ k: 'centre', who: 'me' }]);
    expect(s.confirm()).toEqual([]);
    // The next card up the pile: the same firm sound.
    const two = workTop(s.game, 0, 1);
    s.me({ k: 'hold', cardId: two });
    expect(s.me(move(two, slot(0)))).toEqual([{ k: 'centre', who: 'me' }]);
    expect(s.confirm()).toEqual([]);
  });

  it('a predicted move the server refuses (we lost the race) gets its own disappointed sound when the card comes back, once', () => {
    const s = session(rigged());
    const mine = workTop(s.game, 0, 0);
    expect(s.them(move(workTop(s.game, 1, 0), felt(0, 0)))).toEqual([{ k: 'centre', who: 'other' }]);
    // Both go for the 2 of spades on that ace. Theirs arrives first; mine is already on its way.
    s.me({ k: 'hold', cardId: workTop(s.game, 0, 1) });
    const two = workTop(s.game, 0, 1);
    expect(s.me(move(two, slot(0)))).toEqual([{ k: 'centre', who: 'me' }]);
    // Their snapshot: the pile already holds their 2, so my prediction no longer applies and my card is back.
    const lost = s.them(move(workTop(s.game, 1, 1), slot(0)));
    expect(lost).toContainEqual({ k: 'lost' });
    expect(lost).toContainEqual({ k: 'centre', who: 'other' });
    expect(lost).toHaveLength(2);
    expect(s.confirm()).toEqual([]); // the refusal itself changes nothing more
    expect(s.game.players[0]!.work[1]!.at(-1)!.id).toBe(two);
    expect(mine).toBe(workTop(s.game, 0, 0));
  });

  it('holding a card when someone else takes the pile it could have gone on makes no sound of its own; letting it go there is being beaten to it', () => {
    const s = session(rigged());
    s.them(move(workTop(s.game, 1, 0), felt(0, 0))); // their ace in the middle
    const two = workTop(s.game, 0, 1);
    s.me({ k: 'hold', cardId: two });
    s.confirm();
    expect(beatenTo(s.frame.room!.game!, 0, two, 0)).toBe(false); // the pile would still take it
    const sniped = s.them(move(workTop(s.game, 1, 1), slot(0)));
    expect(sniped).toEqual([{ k: 'centre', who: 'other' }]); // it may have somewhere else to go
    expect(beatenTo(s.frame.room!.game!, 0, two, 0)).toBe(true); // their two lies where ours was going
    expect(beatenTo(s.frame.room!.game!, 0, two, 1)).toBe(false); // not over any other place
  });

  it('a card picked up and put down nowhere gets the same quiet tap', () => {
    const s = session(rigged());
    expect(s.me({ k: 'hold', cardId: workTop(s.game, 0, 3) })).toEqual([{ k: 'pickup', who: 'me' }]);
    expect(s.me({ k: 'release' })).toEqual([{ k: 'home', who: 'me' }]);
    expect(s.confirm()).toEqual([]);
  });

  it('work-pile drops, one flick per card off the stock and the waste going back, for me and (marked as such) for the others', () => {
    const s = session(rigged());
    const four = s.game.players[0]!.waste.at(-1)!.id;
    s.me({ k: 'hold', cardId: four });
    expect(s.me(move(four, work(3)))).toEqual([{ k: 'work', who: 'me' }]);
    // Three cards, three flicks, each at the moment it is predicted: the confirmation, which brings the faces, is silent.
    expect(s.me({ k: 'flip' })).toEqual([{ k: 'stock', who: 'me' }]);
    expect(s.confirm()).toEqual([]);
    expect(s.me({ k: 'flip' })).toEqual([{ k: 'stock', who: 'me' }]);
    expect(s.me({ k: 'flip' })).toEqual([{ k: 'stock', who: 'me' }]);
    expect(s.confirm()).toEqual([]);
    expect(s.frame.room!.game!.players[0]).toMatchObject({ dealt: 0 });

    expect(s.them({ k: 'hold', cardId: s.game.players[1]!.waste.at(-1)!.id })).toEqual([{ k: 'pickup', who: 'other' }]);
    expect(s.them(move(s.game.players[1]!.waste.at(-1)!.id, work(3)))).toEqual([{ k: 'work', who: 'other' }]);
    expect(s.them({ k: 'flip' })).toEqual([{ k: 'stock', who: 'other' }]);
    expect(s.them({ k: 'flip' })).toEqual([{ k: 'stock', who: 'other' }]);
    expect(s.them({ k: 'flip' })).toEqual([{ k: 'stock', who: 'other' }]);
    // Four of their cards in one snapshot (a slow connection): a flick each.
    for (let i = 0; i < 3; i++) s.act(1, { k: 'flip' });
    expect(s.them({ k: 'flip' })).toEqual(Array<Cue>(4).fill({ k: 'stock', who: 'other' }));
    expect(s.game.players[1]!.dealt).toBe(1);
    // A run of two cards moved together is one drop, not two.
    const run = s.game.players[0]!.work[3]![0]!.id;
    s.me({ k: 'hold', cardId: run });
    expect(s.game.players[0]!.work[3]).toHaveLength(2);
    // Deal until the stock is gone, then once more: the waste goes back under.
    let cues: Cue[] = [];
    for (let i = 0; i < 60 && s.frame.room!.game!.players[0]!.stock.length > 0; i++) cues = s.me({ k: 'flip' });
    expect(cues).toEqual([{ k: 'stock', who: 'me' }]);
    expect(s.me({ k: 'flip' })).toEqual([{ k: 'recycle', who: 'me' }]);
  });

  it('a King gets the chime instead of a ding, and clearing the pile the slide', () => {
    // Seat 0's spades up to the Queen are already in slot 2, and its King lies on a work pile.
    const g = withPile(rigged(), 2, 0, 'S', 12);
    const kingCard = ([...g.players[0]!.nertz, ...g.players[0]!.stock, ...g.players[0]!.waste] as Card[]).find((c) => c.suit === 'S')!;
    const start: GameState = {
      ...g,
      players: g.players.map((p) => {
        if (p.seat !== 0) return p;
        const keep = (pile: readonly (typeof p.stock)[number][]) => pile.filter((c) => c.id !== kingCard.id);
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
    s.me({ k: 'hold', cardId: workTop(s.game, 0, 3) }); // the 5: nowhere to go, so no grace for it
    s.confirm();
    const cues = s.them({ k: 'nertz' });
    expect(cues).toContainEqual({ k: 'nertz' });
    expect(cues).toContainEqual({ k: 'home', who: 'me' });
  });

  it('nothing is replayed across a reconnect, however much happened meanwhile', () => {
    const s = session(rigged());
    const ace = workTop(s.game, 0, 0);
    s.me({ k: 'hold', cardId: ace });
    s.me(move(ace, felt(0, 0))); // predicted, never reaches the server
    const [dropped, back] = s.reconnect(() => {
      s.act(1, move(workTop(s.game, 1, 0), felt(0.5, 0)));
      s.act(1, { k: 'flip' });
      s.act(1, move(workTop(s.game, 1, 1), slot(0)));
    });
    expect(dropped).toEqual([]); // my lost prediction snapping back is not a refusal
    expect(back).toEqual([]);
    // And from there on the table is live again.
    expect(s.them({ k: 'flip' })).toEqual([{ k: 'stock', who: 'other' }]);
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
    expect(soundCues({ room: lobby, online: true }, { room: first, online: true })).toEqual([{ k: 'deal', work: 4 }]); // (the rigged hand: four single cards)
    const sheet: RoomView = { ...first, phase: 'results' };
    const second = roomOf(inPlay([0, 1], lcg(8)), 0, { round: 2 });
    expect(soundCues({ room: sheet, online: true }, { room: second, online: true })).toEqual([{ k: 'deal', work: 4 }]); // two players: no face-down cards
    // The flicks follow the cards that really leave the deck: 4 to the work piles at two players, 7 at three, 10 from four up
    // (then the 13 of the nertz pile). Someone sitting the round out hears the first hand's.
    const small = roomOf(dealRound([0, 1, 2], lcg(9)), 0, { round: 3 });
    expect(soundCues({ room: sheet, online: true }, { room: small, online: true })).toEqual([{ k: 'deal', work: 7 }]);
    const four = roomOf(dealRound([0, 1, 2, 3], lcg(9)), 2, { round: 3 });
    expect(soundCues({ room: sheet, online: true }, { room: four, online: true })).toEqual([{ k: 'deal', work: 10 }]);
    expect(soundCues({ room: sheet, online: true }, { room: { ...small, me: 5, seat: 5 }, online: true })).toEqual([{ k: 'deal', work: 7 }]);
    // The round being scored is not a deal, and the scored table makes no card sounds.
    expect(soundCues({ room: first, online: true }, { room: sheet, online: true })).toEqual([]);
    expect(soundCues({ room: sheet, online: true }, { room: { ...sheet, players: [] }, online: true })).toEqual([]);
  });

  it('the opening: silence while the table waits, a tick per number when the dealer starts, one bright hit as play opens', () => {
    const dealt = dealRound([0, 1], lcg(7));
    const stages = { dealing: dealt, ready: finishDeal(dealt), countdown: startCountdown(finishDeal(dealt)), play: toPlay(dealt) };
    const frame = (stage: keyof typeof stages, extra: Partial<RoomView> = {}): Frame => ({ room: roomOf(stages[stage], 0, extra), online: true });
    const beat = START_BEAT_MS / 1000;
    expect(soundCues(frame('dealing', { dealMs: 5 }), frame('ready'))).toEqual([]);
    expect(soundCues(frame('ready'), frame('ready'))).toEqual([]);
    expect(soundCues(frame('ready'), frame('countdown', { startMs: START_MS }))).toEqual([{ k: 'count', at: [0, beat, 2 * beat] }]);
    // More snapshots during the count (someone reconnected, a refused intent) do not start it again.
    expect(soundCues(frame('countdown', { startMs: START_MS }), frame('countdown', { startMs: START_MS - 900 }))).toEqual([]);
    expect(soundCues(frame('countdown', { startMs: 300 }), frame('play'))).toEqual([{ k: 'open' }]);
    expect(soundCues(frame('play'), frame('play'))).toEqual([]);
    // The word at the start is its own cue: never the call that ends a round.
    expect(soundCues(frame('countdown'), frame('play')).some((c) => c.k === 'nertz')).toBe(false);
    // A window that arrives mid-count (reload, reconnect) has nothing to compare with: silent, as everywhere.
    expect(soundCues(null, frame('countdown', { startMs: 1000 }))).toEqual([]);
    expect(soundCues({ ...frame('ready'), online: false }, frame('countdown', { startMs: START_MS }))).toEqual([]);
    expect(soundCues({ ...frame('countdown'), online: false }, frame('play'))).toEqual([]);
    // Opening play moves no card: nothing but the hit, for a player and for someone watching.
    expect(soundCues({ room: roomOf(stages.countdown, 5), online: true }, { room: roomOf(stages.play, 5), online: true })).toEqual([{ k: 'open' }]);
  });

  it('the ticks are scheduled from the duration the snapshot carried: late by a little still ticks, a number already said does not', () => {
    const beat = START_BEAT_MS / 1000;
    expect(startBeats(START_MS)).toEqual([0, beat, 2 * beat]);
    expect(startBeats(START_MS - 40)).toEqual([0, 0.66, 1.36]); // the snapshot took 40 ms: "1" now, the rest on time
    expect(startBeats(START_MS - 400)).toEqual([0.3, 1]); // "1" was said a while ago
    expect(startBeats(START_BEAT_MS)).toEqual([0]); // just in time for "3"
    expect(startBeats(100)).toEqual([]);
    expect(startBeats(0)).toEqual([]);
  });

  it('the grace countdown ticks only for a player still holding a card', () => {
    const g = rigged([1]);
    const held = workTop(g, 0, 0); // an ace: it has somewhere to go, so seat 0 is given grace
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

describe('an Ace on the felt', () => {
  it('an Ace put down on the felt sounds like any card to the middle, once', () => {
    const s = session(rigged());
    const ace = workTop(s.game, 0, 0);
    expect(s.me({ k: 'hold', cardId: ace })).toEqual([{ k: 'pickup', who: 'me' }]);
    expect(s.me(move(ace, felt(0.1, 0.3)))).toEqual([{ k: 'centre', who: 'me' }]);
    expect(s.confirm()).toEqual([]);
  });

  it('is silent when the server files my pile under another slot than I predicted: it has not moved', () => {
    const s = session(rigged());
    const mine = workTop(s.game, 0, 0);
    const theirs = workTop(s.game, 1, 2);
    // Their Ace reaches the server first and takes slot 0; mine, predicted into slot 0, ends up in slot 1 at the same place.
    s.act(1, move(theirs, felt(-0.5, -0.3)));
    expect(s.me(move(mine, felt(0.4, 0.3)))).toEqual([{ k: 'centre', who: 'me' }]);
    expect(s.frame.room!.game!.slots[0]!.cards.map((c) => c.id)).toEqual([mine]);
    expect(s.confirm()).toEqual([{ k: 'centre', who: 'other' }]); // their card arriving, and nothing for mine
    expect(s.frame.room!.game!.slots.slice(0, 2).map((p) => p!.cards[0].id)).toEqual([theirs, mine]);
    expect(s.frame.room!.game!.slots[1]!.at).toMatchObject({ x: 0.4, y: 0.3 });
  });

  it('an Ace that lost the race for its patch of felt just goes home: it has other places to go, so no disappointed sound', () => {
    const s = session(rigged());
    const mine = workTop(s.game, 0, 0);
    const theirs = workTop(s.game, 1, 2);
    s.act(1, move(theirs, felt(0.42, 0.28)));
    s.me({ k: 'hold', cardId: mine });
    expect(s.me(move(mine, felt(0.4, 0.3)))).toEqual([{ k: 'centre', who: 'me' }]);
    const cues = s.confirm();
    expect(cues).not.toContainEqual({ k: 'lost' });
    expect(cues).toContainEqual({ k: 'home', who: 'me' });
    expect(cues).toContainEqual({ k: 'centre', who: 'other' });
    expect(workTop(s.frame.room!.game!, 0, 0)).toBe(mine);
  });
});
