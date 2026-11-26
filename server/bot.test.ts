import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { applyIntent, calledBy, checkInvariants, CLEAR_FIRST, DRAW_COUNT, inGrace, isLive, landed, resolveStuck, SUITS, viewFor, type Rng } from '../shared/engine';
import { DEAL_MS, MAX_PLAYERS, parseClientMsg, PLAIN_LOOK, START_MS, STOCK_CARD_MS } from '../shared/protocol';
import { card, FUZZ_MS, inPlay, pile, seeded, slot, stepDraws, table as wholeTable, untilReached, work, type Hand } from '../shared/testkit';
import type { GameState, Intent, Suit } from '../shared/types';
import { BOTS, chooseIntent, freshMemory, type BotMemory } from './bot';
import { startServer, type NertzServer } from './index';
import type { Room } from './room';
import { Client, FakeConn, opening, roomWith } from './testkit';

// ---------------------------------------------------------------- helpers

const id = (owner: number, face: string) => card(face, owner).id;

/** A centre pile: Ace up to `upTo` in `suit`, all from `owner`'s deck. */
interface Centre {
  owner: number;
  suit: Suit;
  upTo: number;
}

/** A two-seat table with seat 0's (and optionally seat 1's) piles as given. */
const table = (mine: Hand, centre: Centre[] = [], theirs: Hand = { nertz: ['C13'] }): GameState =>
  wholeTable([mine, theirs], { slots: centre.map((c) => pile(`${c.suit}${c.upTo}`, c.owner)) });

/** Four work piles that take only Queens and can go nowhere but onto a Queen in the middle. */
const DEAD = [['S13'], ['C13'], ['H13'], ['D13']];
const always: Rng = () => 0; // notices everything (unless observance is 0), picks the first of equals
const look = (state: GameState, memory: BotMemory = freshMemory(), observance = 1, rng: Rng = always) =>
  chooseIntent(viewFor(state, 0), 0, memory, rng, observance);
const move = (face: string, to: Intent & { k: 'move' } extends { to: infer T } ? T : never, count = 1): Intent => ({ k: 'move', cardId: id(0, face), count, to });

// ---------------------------------------------------------------- chooseIntent

describe('chooseIntent', () => {
  it('a. carries a pile it finished to the tray before anything else, calling Nertz included, and leaves other people\'s finished piles alone', () => {
    const mine = table({ nertz: ['S5'], work: [['H6'], [], [], []] }, [{ owner: 1, suit: 'D', upTo: 2 }, { owner: 0, suit: 'C', upTo: 13 }]);
    expect(look(mine)?.intent).toEqual({ k: 'clear', slot: 1 });
    expect(look(mine, freshMemory(), 0)?.intent).toEqual({ k: 'clear', slot: 1 }); // always noticed: nothing else is allowed
    // Everything else it might have wanted to do is refused by the engine until the pile is gone.
    for (const intent of [{ k: 'draw' }, { k: 'stuck', on: true }, move('S5', work(0))] as Intent[]) expect(applyIntent(mine, 0, intent)).toEqual({ ok: false, reason: CLEAR_FIRST });
    // Out of nertz cards AND a pile waiting: the pile first, then the call.
    const out = table({ nertz: [], work: [['S1'], ['H2'], [], []] }, [{ owner: 0, suit: 'C', upTo: 13 }]);
    expect(look(out)?.intent).toEqual({ k: 'clear', slot: 0 });
    expect(applyIntent(out, 0, { k: 'nertz' })).toEqual({ ok: false, reason: CLEAR_FIRST });
    const cleared = applyIntent(out, 0, look(out)!.intent);
    expect(cleared.ok && look(cleared.state)?.intent).toEqual({ k: 'nertz' });
    const theirs = table({ nertz: ['S5'], work: DEAD }, [{ owner: 1, suit: 'C', upTo: 13 }], { nertz: ['D13'] });
    expect(look(theirs)?.intent).toEqual({ k: 'draw' });
  });

  it('b. calls Nertz when its nertz pile is empty, before any move', () => {
    const state = table({ nertz: [], work: [['S1'], ['H2'], [], []] });
    expect(look(state)?.intent).toEqual({ k: 'nertz' });
    expect(look(state, freshMemory(), 0)?.intent).toEqual({ k: 'nertz' }); // always noticed
  });

  it('d. plays the nertz top to a work pile: a build-down target before an empty pile, an empty pile if there is no target', () => {
    const target = table({ nertz: ['S5'], work: [[], ['H6'], ['C9'], ['D2']] });
    expect(look(target)?.intent).toEqual(move('S5', work(1)));
    const empty = table({ nertz: ['S5'], work: [['H9'], ['C9'], [], ['D2']] });
    expect(look(empty)?.intent).toEqual(move('S5', work(2)));
  });

  it('c beats d: the nertz card goes to the middle when it fits there, though a work pile would take it too', () => {
    const state = table({ nertz: ['S2'], work: [['H3'], ['C9'], ['D9'], ['H9']] }, [{ owner: 1, suit: 'S', upTo: 1 }]);
    expect(look(state)?.intent).toEqual(move('S2', slot(0)));
    const ace = table({ nertz: ['S1'], work: [['H2'], ['C9'], [], ['D9']] });
    expect(look(ace)?.intent).toMatchObject({ k: 'move', cardId: id(0, 'S1'), to: { k: 'felt' } }); // an Ace above all: not onto the red 2, nor the empty pile
    expect(look(ace, freshMemory(), 0)?.intent).toMatchObject({ k: 'move', cardId: id(0, 'S1'), to: { k: 'felt' } }); // and never overlooked
  });

  it('c. plays the nertz top to the middle: an Ace to bare felt, anything else to the exact pile', () => {
    const ace = table({ nertz: ['S1'], work: DEAD }, [{ owner: 1, suit: 'H', upTo: 3 }]);
    const intent = look(ace)!.intent;
    expect(intent).toMatchObject({ k: 'move', cardId: id(0, 'S1'), to: { k: 'felt' } });
    expect(applyIntent(ace, 0, intent).ok).toBe(true);
    const four = table({ nertz: ['H4'], work: DEAD }, [{ owner: 1, suit: 'S', upTo: 3 }, { owner: 1, suit: 'H', upTo: 3 }]);
    expect(look(four)?.intent).toEqual(move('H4', slot(1)));
  });

  it('e. plays the waste top and work-pile tops to the middle, after the nertz card', () => {
    const centre: Centre[] = [{ owner: 1, suit: 'H', upTo: 3 }, { owner: 1, suit: 'D', upTo: 5 }];
    const waste = table({ nertz: ['S9'], work: DEAD, waste: ['C2', 'H4'] }, centre);
    expect(look(waste)?.intent).toEqual(move('H4', slot(0)));
    const top = table({ nertz: ['S9'], work: [['S13'], ['C13', 'H12'], ['H13'], ['S7', 'D6']], waste: ['C2'] }, centre);
    expect(look(top)?.intent).toEqual(move('D6', slot(1)));
    const both = table({ nertz: ['H4'], work: [['S13'], ['C13'], ['H13'], ['S7', 'D6']] }, centre);
    expect(look(both)?.intent).toEqual(move('H4', slot(0))); // d before e
  });

  it('f. moves a whole face-up run to turn over a face-down card or to empty a pile, uncovering first', () => {
    // Pile 1: one face-down card under 8-7. Pile 2 is a lone 8. Both fit on the 9 in pile 0.
    const state = table({ nertz: ['S13'], work: [['C13', 'H12', 'S11', 'D10', 'S9'], { down: ['C2'], up: ['H8', 'C7'] }, ['D8'], ['H13']] });
    expect(look(state)?.intent).toEqual(move('H8', work(0), 2));
    const emptying = table({ nertz: ['S13'], work: [['C13', 'H12', 'S11', 'D10', 'S9'], ['D13'], ['D8'], ['H13']] });
    expect(look(emptying)?.intent).toEqual(move('D8', work(0)));
    // To an empty pile only when that uncovers something. (It takes missing the nertz move to get there: the first roll is a miss.)
    const toEmpty = table({ nertz: ['S9'], work: [[], { down: ['C2'], up: ['H8'] }, ['D13'], ['H13']] });
    const rolls = [0.99, 0, 0, 0];
    expect(look(toEmpty, freshMemory(), 0.9, () => rolls.shift()!)?.intent).toEqual(move('H8', work(0)));
  });

  it('never makes a pointless run move, and never undoes its own last one', () => {
    // The 8 on top of pile 0 fits on the 9 in pile 1, but moving it uncovers nothing and empties nothing.
    const pointless = table({ nertz: ['S13'], work: [['S9', 'H8'], ['C9'], ['H13'], ['D13']] });
    expect(look(pointless)?.intent).toEqual({ k: 'draw' });
    // A lone 8 fits the 9 in pile 1: normally taken (it empties pile 0), but not if it has just come from there.
    const back = table({ nertz: ['S13'], work: [['H8'], ['C9'], ['H13'], ['D13']] });
    expect(look(back)?.intent).toEqual(move('H8', work(1)));
    expect(look(back, { draws: 0, last: { cardId: id(0, 'H8'), from: 1 } })?.intent).toEqual({ k: 'draw' });
    expect(look(back)?.memory.last).toEqual({ cardId: id(0, 'H8'), from: 0 });
  });

  it('g. plays the waste top to a work pile, below every other move', () => {
    const state = table({ nertz: ['S13'], work: [['S9'], ['C13'], ['H13'], ['D13']], waste: ['C2', 'H8'] });
    expect(look(state)?.intent).toEqual(move('H8', work(0)));
    const emptier = table({ nertz: ['S13'], work: [['S9'], ['C13'], ['D8'], ['D13']], waste: ['C2', 'H8'] });
    expect(look(emptier)?.intent).toEqual(move('D8', work(0))); // f before g
  });

  it('h. draws off the stock when there is nothing else, says stuck after one whole fruitless cycle, and starts over after a move', () => {
    // A dead hand: the middle is full of finished and barely started piles, the 3s and Queens lie under the nertz top,
    // and none of the 31 cards in the stock goes anywhere.
    const full: Centre[] = [...SUITS.map((suit) => ({ owner: 1, suit, upTo: 13 })), ...SUITS.map((suit) => ({ owner: 0, suit, upTo: 2 }))];
    const dead: Hand = { nertz: ['S3', 'H3', 'D3', 'C3', 'S12', 'H12', 'D12', 'C12', 'S9'], work: DEAD };
    let state = table(dead, full, { nertz: [] });
    expect(state.players[0]!.stock).toHaveLength(31);
    let memory = freshMemory();
    const intents: string[] = [];
    const step = () => {
      const choice = look(state, memory)!;
      const result = applyIntent(state, 0, choice.intent);
      if (!result.ok) throw new Error(result.reason);
      state = landed(result.state, Infinity); // (the group is down before the bot looks again)
      memory = choice.memory;
      intents.push(choice.intent.k);
    };
    const cycle = Math.ceil(31 / DRAW_COUNT) + 1; // a draw per group to run out, one to turn the waste over: the same state again
    for (let i = 0; i <= cycle; i++) step();
    expect(intents).toEqual([...Array<string>(cycle).fill('draw'), 'stuck']);
    expect(state.players[0]).toMatchObject({ stuck: true, waste: [] });
    // Stuck, it keeps drawing (the middle may change) without saying so again.
    for (let i = 0; i < 2 * cycle; i++) step();
    expect(intents.slice(cycle + 1)).toEqual(Array(2 * cycle).fill('draw'));
    // Everyone stuck at this dead table ends the round (nothing can move anywhere). Were it only stuck for now, the flags
    // would clear: it goes through the whole stock again before saying stuck.
    expect(resolveStuck({ ...state, players: state.players.map((p) => ({ ...p, stuck: true })) }, [0, 1]).status).toEqual({ at: 'over', end: { by: 'jam' } });
    state = { ...state, players: state.players.map((p) => ({ ...p, stuck: false })) };
    expect(state.players[0]!.stuck).toBe(false);
    intents.length = 0;
    for (let i = 0; i <= cycle; i++) step();
    expect(intents).toEqual([...Array<string>(cycle).fill('draw'), 'stuck']);
    // A real move clears the memory.
    expect(look(table({ nertz: ['S5'], work: [['H6'], [], [], []] }), { draws: 9, last: { cardId: 'x', from: 2 } })?.memory).toEqual(freshMemory());
    // Nothing left to draw and nothing to play: stuck at once, then nothing.
    const bare = table(dead, full, { nertz: [] });
    const none = { ...bare, players: bare.players.map((p) => (p.seat === 0 ? { ...p, stock: [], nertz: [...p.stock, ...p.nertz] } : p)) };
    expect(look(none)?.intent).toEqual({ k: 'stuck', on: true });
    expect(look({ ...none, players: none.players.map((p) => ({ ...p, stuck: true })) })).toBeNull();
  });

  it('draws with one intent, and while the group is in flight waits to see what comes up: it leaves the waste alone and notices nothing', () => {
    const draw = (state: GameState) => {
      const r = applyIntent(state, 0, { k: 'draw' });
      if (!r.ok) throw new Error(r.reason);
      return r.state;
    };
    // The waste top would go to the middle: it does, until a draw covers it. Then the bot waits for the group.
    const centre: Centre[] = [{ owner: 1, suit: 'H', upTo: 3 }];
    const waste = table({ nertz: ['S9'], work: DEAD, waste: ['C2', 'H4'] }, centre);
    expect(look(waste)?.intent).toEqual(move('H4', slot(0)));
    const flying = draw(waste);
    expect(flying.players[0]).toMatchObject({ draw: { n: 3 }, waste: { length: 5 } });
    for (const observance of [1, 0]) expect(look(flying, freshMemory(), observance)).toBeNull();
    expect(look(landed(flying, Infinity))).not.toBeNull();
    // A draw counts as one (but not while the bot is flagged stuck).
    const nothing = table({ nertz: ['H6'], work: DEAD });
    expect(look(nothing, { draws: 7, last: null })).toEqual({ intent: { k: 'draw' }, memory: { draws: 8, last: null } });
    const stuck = { ...nothing, players: nothing.players.map((p) => (p.seat === 0 ? { ...p, stuck: true } : p)) };
    expect(look(stuck, { draws: 7, last: null })).toEqual({ intent: { k: 'draw' }, memory: { draws: 7, last: null } });
  });

  it('observance 0 only ever draws (and says stuck), but for an Ace; observance 1 always takes the best move', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const state = inPlay([0, 1], seeded(seed));
      const rng = seeded(seed + 100);
      // (The one thing it cannot miss is an Ace showing: that goes out to the middle.)
      const blind = look(state, freshMemory(), 0, rng)!.intent;
      expect(blind.k === 'draw' || (blind.k === 'move' && blind.to.k !== 'work')).toBe(true);
      // With observance 1 the choice does not depend on the dice (short of where an Ace starts its pile).
      const a = look(state, freshMemory(), 1, seeded(1))!.intent;
      const b = look(state, freshMemory(), 1, seeded(2))!.intent;
      expect({ ...a, to: null }).toEqual({ ...b, to: null });
    }
    const state = table({ nertz: ['S5'], work: [[], ['H6'], ['S9'], ['D2']] }, [{ owner: 0, suit: 'C', upTo: 13 }]);
    expect(look(state, freshMemory(), 1, seeded(3))?.intent).toEqual({ k: 'clear', slot: 0 });
  });

  it('a move it misses on one look is found on a later one, and nertz moves are missed less often than plays from the waste', () => {
    const nertzMove = table({ nertz: ['S5'], work: [['H6'], ['C13'], ['H13'], ['D13']] });
    const wasteToCentre = table({ nertz: ['S9'], work: DEAD, waste: ['H4'] }, [{ owner: 1, suit: 'H', upTo: 3 }]);
    const rng = seeded(5);
    const found = (state: GameState) => Array.from({ length: 2000 }, () => look(state, freshMemory(), BOTS.medium.observance, rng)!.intent.k).filter((k) => k === 'move').length;
    const [n, w] = [found(nertzMove), found(wasteToCentre)];
    expect(n).toBeGreaterThan(2000 * 0.83);
    expect(n).toBeLessThan(2000 * 0.9); // 0.75 ** 0.5 = 0.87: the miss chance about halved
    expect(w).toBeGreaterThan(2000 * 0.65);
    expect(w).toBeLessThan(2000 * 0.74); // 0.75 ** 1.25 = 0.70
  });

  it('does nothing when the round is called, when it is not in the round, before play opens, or when it cannot see its own face-up cards', () => {
    const state = table({ nertz: ['S5'], work: [['H6'], [], [], []] });
    for (const stage of ['dealing', 'ready', 'countdown'] as const) expect(look({ ...state, status: { at: stage } })).toBeNull();
    expect(look({ ...state, status: { at: 'grace', calledBy: 1, unheard: [] } })).toBeNull();
    expect(look({ ...state, status: { at: 'over', end: { by: 'vote', voters: 1 } } })).toBeNull();
    expect(chooseIntent(viewFor(state, 5), 5, freshMemory(), always)).toBeNull();
    const hide = (c: { id: string; owner: number }) => ({ id: c.id, owner: c.owner, hidden: true as const });
    const dark: GameState = { ...state, players: state.players.map((p) => ({ ...p, nertz: p.nertz.map(hide), work: p.work.map((w) => ({ ...w, cards: w.cards.map(hide) })), waste: p.waste.map(hide), stock: p.stock.map(hide) })) };
    expect(chooseIntent(dark, 0, freshMemory(), always)).toBeNull();
  });

  it('never emits an intent the engine refuses, never loops on run moves, and keeps every invariant (bots alone, many deals)', () => {
    let nertzCalls = 0;
    for (let seed = 1; seed <= 8; seed++) {
      const seats = Array.from({ length: 2 + (seed % 3) }, (_, i) => i);
      const rng = seeded(seed);
      let state = inPlay(seats, rng);
      const observance = [1, 0.9, 0.75, 0.6][seed % 4]!;
      const memory = new Map(seats.map((s) => [s, freshMemory()]));
      const sinceFlip = new Map(seats.map((s) => [s, 0]));
      for (let step = 0; step < 6000 && isLive(state); step++) {
        state = stepDraws(state, rng); // (the round's clock: the groups in flight come down)
        const seat = seats[Math.floor(rng() * seats.length)]!;
        const before = memory.get(seat)!;
        const choice = chooseIntent(viewFor(state, seat), seat, before, rng, observance);
        if (!choice) continue;
        const result = applyIntent(state, seat, choice.intent);
        if (!result.ok) throw new Error(`seed ${seed}: ${JSON.stringify(choice.intent)} refused: ${result.reason}`);
        const { intent } = choice;
        // A run move is never the reverse of the bot's previous run move.
        if (intent.k === 'move' && intent.to.k === 'work' && before.last) expect([intent.cardId, intent.to.i]).not.toEqual([before.last.cardId, before.last.from]);
        // Between two draws a bot can only make so many moves: nothing goes round in circles.
        sinceFlip.set(seat, intent.k === 'draw' || intent.k === 'stuck' ? 0 : sinceFlip.get(seat)! + 1);
        expect(sinceFlip.get(seat)).toBeLessThan(40);
        state = resolveStuck(result.state, seats);
        memory.set(seat, choice.memory);
        expect(checkInvariants(state)).toBeNull();
      }
      if (calledBy(state) !== null) nertzCalls++;
    }
    expect(nertzCalls).toBeGreaterThan(4); // most deals are played out to a call (tables of two mostly jam, tables of four never)
  }, FUZZ_MS);
});

// ---------------------------------------------------------------- Room

function hosted(seed = 1): { room: Room; host: FakeConn } {
  const { room } = roomWith(0, { rng: seeded(seed) });
  const host = new FakeConn();
  expect(room.join(host, 'Ann', 'tok-host', true)).toBeNull();
  return { room, host };
}
const names = (room: Room, conn: FakeConn) => {
  room.flush();
  return conn.last.room.players.map((p) => p.name);
};

describe('Room with bots', () => {
  afterEach(() => void vi.useRealTimers());

  it('validates the add and remove messages', () => {
    expect(parseClientMsg({ t: 'addBot', level: 'fast', junk: 1 })).toEqual({ t: 'addBot', level: 'fast' });
    expect(parseClientMsg({ t: 'addBot' })).toEqual({ t: 'addBot', level: 'medium' });
    for (const level of ['FAST', 'godlike', 2, null, {}]) expect(parseClientMsg({ t: 'addBot', level })).toBeNull();
    expect(parseClientMsg('{"t":"removeBot","seat":3}')).toEqual({ t: 'removeBot', seat: 3 });
    for (const seat of [-1, MAX_PLAYERS, 1.5, '1', null, undefined]) expect(parseClientMsg({ t: 'removeBot', seat })).toBeNull();
  });

  it('only the host adds and removes bots; a bot is a marked, connected player with its own seat and is never the host', () => {
    const { room, host } = hosted();
    const guest = new FakeConn();
    room.join(guest, 'Bea', 'tok-guest', true);
    room.handle(guest, { t: 'addBot', level: 'fast' });
    expect(names(room, host)).toEqual(['Ann', 'Bea']);
    room.handle(host, { t: 'addBot', level: 'fast' });
    room.handle(host, { t: 'addBot', level: 'slow' });
    room.flush();
    expect(host.last.room.players).toEqual([
      { id: 0, seat: 0, sat: 0, name: 'Ann', connected: true, score: 0, rounds: 0, calls: 0, isHost: true, look: PLAIN_LOOK },
      { id: 1, seat: 1, sat: 1, name: 'Bea', connected: true, score: 0, rounds: 0, calls: 0, isHost: false, look: PLAIN_LOOK },
      { id: 2, seat: 2, sat: 2, name: 'Bot Ada', connected: true, score: 0, rounds: 0, calls: 0, isHost: false, bot: 'fast', look: PLAIN_LOOK },
      { id: 3, seat: 3, sat: 3, name: 'Bot Bix', connected: true, score: 0, rounds: 0, calls: 0, isHost: false, bot: 'slow', look: PLAIN_LOOK },
    ]);
    room.handle(guest, { t: 'removeBot', seat: 2 }); // not the host
    room.handle(host, { t: 'removeBot', seat: 1 }); // not a bot
    room.handle(host, { t: 'removeBot', seat: 5 }); // nobody
    expect(names(room, host)).toEqual(['Ann', 'Bea', 'Bot Ada', 'Bot Bix']);
    room.handle(host, { t: 'removeBot', seat: 2 });
    expect(names(room, host)).toEqual(['Ann', 'Bea', 'Bot Bix']);
    room.handle(host, { t: 'addBot', level: 'medium' }); // the freed seat and name are used again
    room.flush();
    expect(host.last.room.players[2]).toMatchObject({ seat: 2, name: 'Bot Ada', bot: 'medium' });

    // The host goes away: the next person deals, never a bot. The host leaves for good: the same.
    room.disconnect(host);
    room.flush();
    expect(guest.last.room.players.find((p) => p.isHost)?.name).toBe('Bea');
    const back = new FakeConn();
    room.join(back, 'Ann', 'tok-host', true);
    room.handle(back, { t: 'leave' });
    room.handle(guest, { t: 'leave' });
    expect(room.empty).toBe(true); // only bots are left: nobody is
    expect(room.connected).toBe(0);
  });

  it('fills the table up to its ten seats and no further, and nobody can join into a bot\'s seat', () => {
    const { room, host } = hosted();
    for (let i = 0; i < 11; i++) room.handle(host, { t: 'addBot', level: 'medium' });
    expect(names(room, host)).toEqual(['Ann', 'Bot Ada', 'Bot Bix', 'Bot Cleo', 'Bot Dot', 'Bot Eli', 'Bot Fay', 'Bot Gus', 'Bot Hal', 'Bot Ivy']);
    expect(room.join(new FakeConn(), 'Late', 'tok-late', true)).toBeNull(); // full: they come in to watch, and wait for a seat
    expect(parseClientMsg({ t: 'join', room: 'TEST', name: 'Sly', token: 'bot:1-padding' })).toBeNull(); // a bot's token is not a token
    room.handle(host, { t: 'removeBot', seat: 1 }); // a seat comes free: whoever was watching has it
    expect(names(room, host)).toEqual(['Ann', 'Late', 'Bot Bix', 'Bot Cleo', 'Bot Dot', 'Bot Eli', 'Bot Fay', 'Bot Gus', 'Bot Hal', 'Bot Ivy']);
  });

  it('one person and one bot make a round; bots cannot be added or removed while it is on', () => {
    vi.useFakeTimers();
    const { room, host } = hosted();
    room.handle(host, { t: 'start' });
    opening(room, host);
    expect(room.phase).toBe('lobby');
    room.handle(host, { t: 'addBot', level: 'medium' });
    expect(vi.getTimerCount()).toBe(0); // a bot in the lobby has no timer
    room.handle(host, { t: 'start' });
    // The bot does not wake when the cards are down: the table waits, for as long as it takes, for the person to press Start...
    vi.advanceTimersByTime(DEAL_MS);
    expect(room.game!.status.at).toBe('ready');
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(10 * 60_000);
    expect(room.game).toMatchObject({ status: { at: 'ready' }, slots: [null, null, null, null, null, null, null, null] });
    expect(room.game!.players.every((p) => p.waste.length === 0 && p.nertz.length === 13)).toBe(true);
    // ...nor during "1, 2, 3": only the start timer runs. It wakes on NERTZ!, like everyone.
    room.handle(host, { t: 'go' });
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(START_MS - 1);
    expect(room.game!.status.at).toBe('countdown');
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(1);
    expect(room.game!.status.at).toBe('play');
    expect(room.phase).toBe('playing');
    expect(room.game!.players.map((p) => p.seat)).toEqual([0, 1]);
    expect(vi.getTimerCount()).toBe(1);
    room.handle(host, { t: 'addBot', level: 'medium' });
    room.handle(host, { t: 'removeBot', seat: 1 });
    expect(names(room, host)).toEqual(['Ann', 'Bot Ada']);
    room.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  /** Runs the room's timers one at a time until the round is over, checking the table after every one. Returns simulated ms, or null if the round is still on after `limitMs`. */
  function playOut(room: Room, limitMs: number): number | null {
    const t0 = Date.now();
    let rev = room.rev;
    while (room.phase === 'playing') {
      expect(vi.getTimerCount()).toBeGreaterThan(0);
      vi.advanceTimersToNextTimer(); // one bot's look: at most one intent
      expect(room.rev - rev).toBeLessThanOrEqual(4); // (several bots may look in the same millisecond)
      rev = room.rev;
      expect(checkInvariants(room.game!)).toBeNull();
      if (Date.now() - t0 > limitMs) return null;
    }
    return Date.now() - t0;
  }

  it('a person and two bots play whole rounds to a Nertz call, and the bots are scored like anyone', () => {
    vi.useFakeTimers();
    // Deals until three have been played out. Not every deal is: a table of two or three can jam for good, as in the real game.
    untilReached({ 'played out': 3 }, 8, (rng, reached, seed) => {
      const { room, host } = hosted(100 + seed); // (the room's own dice, apart from the person's)
      room.handle(host, { t: 'addBot', level: 'fast' });
      room.handle(host, { t: 'addBot', level: 'slow' });
      room.handle(host, { t: 'start' });
      opening(room, host);
      // The person plays through their connection, from the snapshots they are sent, about once a second.
      let memory = freshMemory();
      let seq = 0;
      let turn = Date.now() + 1000;
      const t0 = Date.now();
      while (room.phase === 'playing') {
        vi.advanceTimersToNextTimer();
        expect(checkInvariants(room.game!)).toBeNull();
        if (room.phase !== 'playing' || Date.now() < turn) continue;
        turn = Date.now() + 1000;
        room.flush();
        const choice = chooseIntent(host.last.room.game!, 0, memory, rng, 0.9);
        const before = room.game;
        if (choice) room.handle(host, { t: 'intent', seq: ++seq, intent: choice.intent });
        if (choice && room.game !== before) memory = choice.memory;
        expect(checkInvariants(room.game!)).toBeNull();
        if (Date.now() - t0 > 30 * 60_000) return room.close(); // jammed
      }
      reached('played out');
      expect(vi.getTimerCount()).toBe(0); // round over: no bot timer left, and no grace timer (nobody held a card)
      const round = room.lastRound!;
      expect(inGrace(room.game!)).toEqual([]);
      expect(round.scores.map((s) => s.name)).toEqual(['Ann', 'Bot Ada', 'Bot Bix']);
      expect(round.end.by).toBe('nertz');
      const caller = round.scores.find((s) => s.seat === calledBy(room.game!))!;
      expect(caller).toMatchObject({ nertzLeft: 0, delta: caller.played, total: caller.played });
      for (const s of round.scores) expect(s.delta).toBe(s.played - 2 * s.nertzLeft);
      expect(round.scores.every((s) => s.played > 0)).toBe(true); // everybody, bots included, got cards into the middle
      room.flush();
      expect(host.last.room).toMatchObject({ phase: 'results', players: [{ score: round.scores[0]!.total }, { bot: 'fast', score: round.scores[1]!.total }, { bot: 'slow', score: round.scores[2]!.total }] });
      // A bot sent away between rounds is off the score sheet too: its line is kept only for the cards it left on the table.
      room.handle(host, { t: 'removeBot', seat: 2 });
      room.flush();
      expect(host.last.room.players.map((p) => p.seat)).toEqual([0, 1]);
      expect(host.last.room.lastRound!.scores.map((l) => [l.seat, !!l.gone])).toEqual([[0, false], [1, false], [2, true]]); // prettier-ignore
      room.close();
    });
  }, FUZZ_MS);

  it('bots alone, driven only by their timers, finish rounds (the person is away, so the stuck vote is theirs)', () => {
    vi.useFakeTimers();
    // Deals until two have been played out.
    untilReached({ 'played out': 2 }, 8, (_, reached, seed) => {
      const { room, host } = hosted(seed);
      for (const level of ['slow', 'medium', 'fast', 'medium'] as const) room.handle(host, { t: 'addBot', level });
      room.handle(host, { t: 'start' });
      opening(room, host);
      room.disconnect(host);
      expect(room.connected).toBe(0); // four bots playing do not make the room look alive
      expect(vi.getTimerCount()).toBe(4);
      const took = playOut(room, 60 * 60_000);
      if (took === null) return room.close(); // jammed
      reached('played out');
      expect(took).toBeGreaterThan(20_000); // human pace, not a burst
      expect(vi.getTimerCount()).toBe(0);
      expect(room.phase).toBe('results');
      expect(calledBy(room.game!)).toBeGreaterThan(0);

      // Next round: a removed bot has no timer, the others get theirs back.
      const back = new FakeConn();
      room.join(back, 'Ann', 'tok-host', true);
      room.handle(back, { t: 'removeBot', seat: 2 });
      room.handle(back, { t: 'start' });
      opening(room, back);
      expect(room.round).toBe(2);
      expect(room.game!.players.map((p) => p.seat)).toEqual([0, 1, 3, 4]);
      expect(vi.getTimerCount()).toBe(3);
      vi.advanceTimersByTime(30_000);
      expect(room.game!.players.find((p) => p.seat === 0)).toMatchObject({ waste: [], stuck: false }); // the person did nothing
      expect(room.game!.players.filter((p) => p.seat !== 0).some((p) => p.waste.length + p.nertz.length !== 13)).toBe(true);
      room.close();
      expect(vi.getTimerCount()).toBe(0);
    });
  }, FUZZ_MS);

  it('a pause stops the bots and every move until it is unpaused', () => {
    vi.useFakeTimers();
    const { room, host } = hosted(5);
    const guest = new FakeConn();
    room.join(guest, 'Bo', 'tok-guest', true);
    room.handle(host, { t: 'addBot', level: 'fast' });
    room.handle(host, { t: 'start' });
    opening(room, host);
    room.handle(guest, { t: 'pause', on: true });
    room.flush();
    expect(host.last.room.paused).toEqual({ by: 'player', id: 1 });
    const frozen = JSON.stringify(room.game);
    vi.advanceTimersByTime(30_000);
    room.handle(host, { t: 'intent', seq: 1, intent: { k: 'draw' } });
    expect(JSON.stringify(room.game)).toBe(frozen); // no bot moved, and nobody can
    room.handle(host, { t: 'pause', on: true }); // already paused: nothing changes
    room.handle(host, { t: 'pause', on: false }); // anyone in the round may unpause it
    room.flush();
    expect(guest.last.room.paused).toBeNull();
    vi.advanceTimersByTime(10_000);
    expect(JSON.stringify(room.game)).not.toBe(frozen); // the bot is playing again
    room.handle(guest, { t: 'pause', on: true });
    room.handle(guest, { t: 'pause', on: false });
    room.flush();
    expect(host.last.room.paused).toBeNull();
    room.close();
  });

  it("a bot decides at its level's pace (half to one and a half times the mean), and after a draw waits out its group's time, as everyone must", () => {
    vi.useFakeTimers();
    for (const level of ['slow', 'medium', 'fast'] as const) {
      const { room, host } = hosted(3);
      room.handle(host, { t: 'addBot', level });
      room.handle(host, { t: 'start' });
      opening(room, host); // the deal and the count: bots wake when play opens
      const delay = BOTS[level].delayMs;
      const bot = () => room.game!.players.find((p) => p.seat === 1)!;
      const gaps = { look: [] as number[], step: [] as number[] };
      let last = Date.now();
      let flights = 0;
      let groups = 0;
      for (let i = 0; i < 400; i++) {
        const was = bot();
        const carrying = was.holding !== null;
        vi.advanceTimersToNextTimer();
        // A card being carried over (its made-up drag reports, then the drop) is part of the action that picked it up.
        if (carrying) {
          if (bot().holding === null) flights++; // landed
          continue;
        }
        const gap = Date.now() - last;
        last = Date.now();
        if (was.draw) {
          // Its group in flight: a step for each card, and nothing of the bot's own meanwhile. Then the group is down, and it looks.
          expect(gap).toBe(was.draw.n * STOCK_CARD_MS);
          expect(bot()).toEqual({ ...was, draw: null, drew: { n: was.draw.n, at: was.draw.at, top: was.waste.at(-1)!.id } });
          groups++;
          gaps.step.push(gap);
        } else {
          expect(gap).toBeGreaterThanOrEqual(delay * 0.5);
          expect(gap).toBeLessThanOrEqual(delay * 1.5);
          gaps.look.push(gap);
        }
      }
      const mean = (xs: number[]) => xs.reduce((n, x) => n + x, 0) / xs.length;
      expect(gaps.look.length).toBeGreaterThan(8);
      expect(groups).toBeGreaterThan(5); // one draw each, its time waited out
      expect(flights).toBeGreaterThan(3); // it did carry cards over
      expect(mean(gaps.look)).toBeGreaterThan(delay * 0.7);
      expect(mean(gaps.look)).toBeLessThan(delay * 1.3);
      room.close();
    }
  });
});

// ---------------------------------------------------------------- over real sockets

describe('bots on the real server', () => {
  let server: NertzServer;
  beforeAll(async () => {
    server = await startServer({ port: 0, dist: '/nonexistent' });
  });
  afterAll(() => server.close());

  const connect = (name: string) => Client.open(server.port, null, name);

  it('a lobby of only bots is forgotten at once, and a game of only bots is swept like any abandoned table', { timeout: 60_000 }, async () => {
    const a = await connect('Ann');
    const code = a.last.room.code;
    a.send({ t: 'addBot', level: 'fast' });
    a.send({ t: 'addBot', level: 'warp' }); // malformed: answered with an error, seats nothing
    await vi.waitFor(() => expect(a.last.room.players.map((p) => p.name)).toEqual(['Ann', 'Bot Ada']));
    a.send({ t: 'leave' });
    await vi.waitFor(() => expect(server.rooms.has(code)).toBe(false));
    a.ws.close();

    const b = await connect('Bob');
    const room = server.rooms.get(b.last.room.code)!;
    b.send({ t: 'addBot', level: 'fast' });
    b.send({ t: 'start' });
    await vi.waitFor(() => expect(b.last.room.phase).toBe('playing'));
    expect(b.last.room.players).toMatchObject([{ name: 'Bob' }, { name: 'Bot Ada', bot: 'fast', connected: true }]);
    // The bot waits for Bob like anyone: cards dealt, nothing happens until he presses Start and the count is done.
    const dealt = JSON.stringify(room.game!.players[1]);
    await vi.waitFor(() => expect(b.last.room.game!.status.at).toBe('ready'), { timeout: 5000 });
    await new Promise((done) => setTimeout(done, 1200)); // (a fast bot would have looked twice by now)
    expect(JSON.stringify(room.game!.players[1])).toBe(dealt);
    b.send({ t: 'go' });
    await vi.waitFor(() => expect(b.last.room).toMatchObject({ game: { status: { at: 'countdown' } } }));
    expect(b.last.room.timerMs).toBeGreaterThan(START_MS - 500);
    await vi.waitFor(() => expect(b.last.room).toMatchObject({ timerMs: null, game: { status: { at: 'play' } } }), { timeout: 4000 });
    // Then the bot plays by itself.
    await vi.waitFor(() => expect(JSON.stringify(room.game!.players[1])).not.toBe(dealt), { timeout: 25_000 });
    b.ws.close();
    await vi.waitFor(() => expect(room.connected).toBe(0));
    server.sweep(Date.now() + 60 * 60_000);
    expect(server.rooms.size).toBe(0);
    // Deleted means stopped: the bot never moves again.
    const frozen = JSON.stringify(room.game);
    await new Promise((done) => setTimeout(done, 2500));
    expect(JSON.stringify(room.game)).toBe(frozen);
  });
});

describe('a bot at a crowded table', () => {
  it('is exactly its level at two players, and slower and less observant for every player more: a careful bot loses less', async () => {
    const { botAt, BOTS } = await import('./bot');
    for (const level of ['slow', 'medium', 'fast'] as const) {
      expect(botAt(level, 2)).toEqual(BOTS[level]);
      expect(botAt(level, 1)).toEqual(BOTS[level]);
      for (let n = 3; n <= 10; n++) {
        expect(botAt(level, n).delayMs).toBeGreaterThan(botAt(level, n - 1).delayMs);
        expect(botAt(level, n).observance).toBeLessThan(botAt(level, n - 1).observance);
      }
    }
    // At a full table: about two fifths slower; what the fast bot keeps of its observance is more than what the slow one keeps.
    expect(botAt('fast', 10).delayMs / BOTS.fast.delayMs).toBeCloseTo(1.4);
    expect(botAt('fast', 10).observance / BOTS.fast.observance).toBeGreaterThan(botAt('slow', 10).observance / BOTS.slow.observance);
    expect(botAt('slow', 10).observance).toBeGreaterThan(0.4);
  });
});

