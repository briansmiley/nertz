import { describe, expect, it } from 'vitest';
import { roomWith, send as told, startRound } from '../server/testkit';
import { applyIntent, checkInvariants, deal as dealRound, finishDeal, inGrace, isHidden, landsAt, refused, startCountdown } from '../shared/engine';
import { STOCK_CARD_MS } from '../shared/protocol';
import { card as c, felt, inPlay, lcg, move, roomOf, table, toPlay, upWork, withPile, work } from '../shared/testkit';
import type { Card, GameState, Intent } from '../shared/types';
import { dealOut, dealtBy, freshDealing, freshSync, glideMs, hearsCall, hello, onSend, onSnapshot, predict, roundNow, type Sync } from './net';

/** How long a group that is down takes on screen to glide onto the waste (net.ts `glideMs`). */
const GLIDE = glideMs();

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
    const g = inPlay([0, 1], lcg(seed));
    if (g.players.every((p) => (p.work[0]!.cards[0] as Card).rank === 1)) return g;
  }
  throw new Error('no suitable deal');
}

const send = (sync: Sync, intent: Intent): Sync => onSend(sync, intent);

describe('prediction', () => {
  it('predicts nothing while the cards are being dealt, while the table waits and through the count, and plays on from the snapshot that opens the round', () => {
    const dealt = dealRound([0, 1], lcg(1));
    const s = server(dealt, 0);
    let sync = onSnapshot(freshSync, s.snapshot());
    expect(predict(sync)).toBe(sync.server);
    expect(sync.server!.game!.players.flatMap((p) => [...p.nertz, ...p.work.flatMap((w) => w.cards), ...p.stock]).every(isHidden)).toBe(true);
    // What `net.send` asks before sending anything: every intent is refused on the dealing view, so nothing goes out.
    const intents: Intent[] = [{ k: 'draw' }, { k: 'stuck', on: true }, { k: 'hold', cardId: dealt.players[0]!.nertz.at(-1)!.id }, { k: 'nertz' }];
    for (const intent of intents) expect(applyIntent(sync.server!.game!, 0, intent).ok).toBe(false);
    // Even an intent that did go out (a hostile or stale client) is refused by both sides: prediction stays the snapshot.
    sync = send(sync, { k: 'draw' });
    expect(predict(sync)).toBe(sync.server);
    expect(s.apply(0, { k: 'draw' }, sync.seq)).toBe(false);
    sync = onSnapshot(sync, s.snapshot());
    expect(sync.pending).toHaveLength(0);

    // Ready and "1, 2, 3": the work tops are showing, the nertz top is not, and still nothing is predicted or accepted.
    for (const waiting of [finishDeal(dealt), startCountdown(finishDeal(dealt))]) {
      const w = server(waiting, 0);
      sync = onSnapshot({ ...sync, rev: -1 }, w.snapshot());
      const me = sync.server!.game!.players[0]!;
      expect(me.nertz.every(isHidden)).toBe(true);
      expect(me.work.map((pile) => isHidden(pile.cards.at(-1)!))).toEqual([false, false, false, false]);
      const tries: Intent[] = [...intents, { k: 'hold', cardId: me.work[0]!.cards.at(-1)!.id }, { k: 'move', cardId: me.work[0]!.cards.at(-1)!.id, count: 1, to: { k: 'felt', x: 0, y: 0 } }];
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
    sync = send(sync, { k: 'draw' });
    expect(predict(sync)!.game!.players[0]!.waste).toHaveLength(3);
  });

  it('clear-first is predicted too: after my King nothing else of mine applies until the pile is in the tray; a King that lost its race holds nothing up', () => {
    // Seat 0's spades up to the Queen are a centre pile; its King of spades is the top of work pile 0.
    const g = withPile(inPlay([0, 1], lcg(4)), 0, 0, 'S', 12);
    const cards = g.players[0]!.nertz.concat(g.players[0]!.work.flatMap((w) => w.cards), g.players[0]!.stock) as Card[];
    const king = cards.find((c) => c.suit === 'S')!;
    const rest = cards.filter((c) => c !== king);
    const rigged: GameState = {
      ...g,
      players: g.players.map((p) => (p.seat === 0 ? { ...p, nertz: rest.slice(0, 3), work: upWork([[king], [], [], []]), stock: rest.slice(3), waste: [] } : p)),
    };
    expect(checkInvariants(rigged)).toBeNull();
    const kingMove: Intent = { k: 'move', cardId: king.id, count: 1, to: { k: 'slot', i: 0 } };
    const s = server(rigged, 0);
    let sync = onSnapshot(freshSync, s.snapshot());
    sync = send(sync, kingMove);
    const blocked = predict(sync)!.game!;
    expect(blocked.slots[0]!.cards).toHaveLength(13);
    // What `net.send` asks: everything but the clear is refused on the predicted table, before the server has said a word.
    const nertzTop = blocked.players[0]!.nertz.at(-1)!.id;
    for (const intent of [{ k: 'draw' }, { k: 'stuck', on: true }, { k: 'hold', cardId: nertzTop }] as Intent[]) expect(applyIntent(blocked, 0, intent).ok).toBe(false);
    expect(applyIntent(blocked, 0, { k: 'clear', slot: 0 }).ok).toBe(true);
    // King and clear in flight together; a flip sent between them (a stale client) is dropped by both sides.
    sync = send(send(sync, { k: 'draw' }), { k: 'clear', slot: 0 });
    expect(predict(sync)!.game!.slots[0]).toBeNull();
    expect(predict(sync)!.game!.tray.map((pile) => pile.length)).toEqual([13]);
    expect(predict(sync)!.game!.players[0]!.waste).toHaveLength(0);
    expect(sync.pending.map((p) => s.apply(0, p.intent, p.seq))).toEqual([true, false, true]);
    sync = onSnapshot(sync, s.snapshot());
    expect(predict(sync)).toBe(sync.server);
    sync = send(sync, { k: 'draw' });
    expect(predict(sync)!.game!.players[0]!.waste).toHaveLength(3);

    // The other way round: the server refuses my King (the pile is no longer there for it). I am not held up by a pile I never finished.
    const lost = server({ ...rigged, slots: rigged.slots.map(() => null) }, 0);
    sync = onSnapshot(freshSync, s2snap(rigged));
    sync = send(send(sync, kingMove), { k: 'draw' });
    expect(predict(sync)!.game!.players[0]!.waste).toHaveLength(0); // predicted: blocked behind my King
    expect(sync.pending.map((p) => lost.apply(0, p.intent, p.seq))).toEqual([false, true]);
    sync = onSnapshot(sync, lost.snapshot());
    expect(predict(sync)!.game!.players[0]!.waste).toHaveLength(3); // the truth: the King went home, the flip counted
    function s2snap(game: GameState) {
      return { rev: 0, ack: -1, room: roomOf(game, 0) };
    }
  });

  it('renders the snapshot untouched when nothing is pending', () => {
    const s = server(inPlay([0, 1], lcg(1)), 0);
    const sync = onSnapshot(freshSync, s.snapshot());
    expect(predict(sync)).toBe(sync.server);
  });

  it('predicts a draw: the whole group on the waste at once, face-down and in flight; the faces come in the server\'s one answer, and its top card plays when its time is up', () => {
    const s = server(inPlay([0, 1], lcg(2)), 0);
    let sync = onSnapshot(freshSync, s.snapshot());
    const mine = () => predict(sync)!.game!.players[0]!;
    sync = send(sync, { k: 'draw' });
    expect([mine().waste.length, mine().draw?.n]).toEqual([3, 3]);
    expect(mine().waste.every(isHidden)).toBe(true);
    expect(applyIntent(predict(sync)!.game!, 0, { k: 'draw' }).ok).toBe(false); // in flight: nothing more to send
    s.apply(0, { k: 'draw' }, 1);
    sync = onSnapshot(sync, s.snapshot());
    expect(sync.pending).toHaveLength(0);
    expect([mine().waste.length, mine().draw?.n]).toEqual([3, 3]); // one snapshot, and the group is all there
    expect(mine().waste.some(isHidden)).toBe(false);
    expect(checkInvariants(predict(sync)!.game!)).toBeNull();
    const top = mine().waste.at(-1)!.id;
    const down = landsAt(mine().draw!);
    expect(down).toBe(mine().draw!.at + 3 * STOCK_CARD_MS);
    expect(applyIntent(predict(sync)!.game!, 0, { k: 'hold', cardId: top }, down - 1).ok).toBe(false);
    expect(applyIntent(predict(sync)!.game!, 0, { k: 'hold', cardId: top }, down).ok).toBe(true);
    // What is sent is replayed by the round's clock as it read when it was sent.
    expect(predict(onSend(sync, { k: 'hold', cardId: top }, down - 1))!.game!.players[0]!.holding).toBeNull();
    expect(predict(onSend(sync, { k: 'hold', cardId: top }, down))!.game!.players[0]).toMatchObject({ holding: top, draw: null });
  });

  it('a group in flight is dealt out by the round\'s clock: a card off the stock every step, the rest on the stock yet, and the group down at its time', () => {
    const start = inPlay([0, 1], lcg(2));
    const AT = 1000;
    const r = applyIntent(start, 0, { k: 'draw' }, AT);
    if (!r.ok) throw new Error(r.reason);
    const p = r.state.players[0]!;
    const ids = (cards: readonly { id: string }[]) => cards.map((c) => c.id);
    const group = ids(p.waste.slice(-3)); // in the order dealt
    expect(p.draw).toEqual({ n: 3, at: AT });
    expect(dealtBy(start.players[0]!, AT, AT)).toBe(start.players[0]); // no draw: the hand as it is
    for (const k of [1, 2, 3]) {
      const seen = dealtBy(p, AT + (k - 1) * STOCK_CARD_MS, AT);
      expect(seen.draw).toEqual({ n: 3, at: AT, off: k }); // the group keeps its size
      expect(ids(seen.waste)).toEqual(group.slice(0, k));
      expect(ids(seen.stock)).toEqual([...ids(p.stock), ...group.slice(k).reverse()]); // the next to come off is on top
      expect([...seen.waste, ...seen.stock.slice(p.stock.length)].every(isHidden)).toBe(true);
    }
    expect(dealtBy(p, AT + STOCK_CARD_MS - 1, AT).draw!.off).toBe(1);
    expect(dealtBy(p, AT - 50, AT).draw!.off).toBe(1); // (the first card is off when the draw is seen)
    // The group is held whole a step, then down: the hand as it is, faces up, gliding onto the waste (the card under it
    // can still be taken: `down`), and once it is there, with no draw.
    expect(dealtBy(p, landsAt(p.draw!) - 1, AT).draw!.off).toBe(3);
    expect(dealtBy(p, landsAt(p.draw!), AT)).toEqual({ ...p, draw: { n: 3, at: AT, down: true } });
    expect(dealtBy(p, landsAt(p.draw!) + GLIDE - 1, AT).draw).toEqual({ n: 3, at: AT, down: true });
    expect(dealtBy(p, landsAt(p.draw!) + GLIDE, AT)).toEqual({ ...p, draw: null });
    // A window that has it late finds the cards due by then already off, and one long after, the group down.
    expect(dealtBy(p, AT + STOCK_CARD_MS + 5, AT).draw!.off).toBe(2);
    expect(dealtBy(p, AT + 60_000, AT).draw).toBeNull();
    // The cards leave from when the draw was first seen here; the group lands by the draw's own time (your own draw's is the server's, once it answers).
    const answered = { ...p, draw: { n: 3, at: AT + 80 } };
    expect(dealtBy(answered, AT + STOCK_CARD_MS, AT).draw!.off).toBe(2);
    expect(dealtBy(answered, AT + 3 * STOCK_CARD_MS, AT).draw!.off).toBe(3);
    expect(dealtBy(answered, AT + 80 + 3 * STOCK_CARD_MS, AT).draw!.down).toBe(true);
    // Seen a little late, its cards still leave a step apart from then, and it is down a step after the last of them.
    expect(dealtBy(p, landsAt(p.draw!), AT + 100).draw!.off).toBe(3);
    expect(dealtBy(p, AT + 100 + 3 * STOCK_CARD_MS, AT + 100).draw!.down).toBe(true);
    // Your own draw before the server has answered: its faces are not here, so it does not turn up, however late.
    const mine = applyIntent(roomOf(start, 0).game!, 0, { k: 'draw' }, AT);
    if (!mine.ok) throw new Error(mine.reason);
    expect(mine.state.players[0]!.waste.every(isHidden)).toBe(true);
    expect(dealtBy(mine.state.players[0]!, AT + 60_000, AT).draw).toEqual({ n: 3, at: AT, off: 3 });
  });

  it('deals out a group in flight at this window\'s own pace, from when it first had the draw, whenever the snapshots come', () => {
    const start = inPlay([0, 1], lcg(2));
    const AT = 1000;
    const r = applyIntent(start, 1, { k: 'draw' }, AT); // seat 1 draws: the group comes to this window in one snapshot
    if (!r.ok) throw new Error(r.reason);
    // (This window's clock and the round's read alike, until a quicker snapshot puts the round's forward.)
    const snap = (rev: number, game: GameState, ms: number) => ({ rev, ack: -1, room: { ...roomOf(game, 0), clock: { ms, running: true } } });
    const theirs = (out: ReturnType<typeof dealOut>) => out.room!.game!.players[1]!;
    // On screen before the draw: nothing is due.
    let sync = onSnapshot(freshSync, snap(0, start, AT - 500), AT - 500);
    let out = dealOut(freshDealing, sync, AT - 500);
    expect([out.wait, out.dealing.looking, out.dealing.flights.size]).toEqual([null, true, 0]);
    // Their draw reaches this window 400 ms late: its first card leaves now, and the next a step on.
    const seen = AT + 400;
    sync = onSnapshot(sync, snap(1, r.state, seen), seen);
    out = dealOut(out.dealing, sync, seen);
    expect([theirs(out).draw, out.wait, out.dealing.flights.get(1)]).toEqual([{ n: 3, at: AT, off: 1 }, STOCK_CARD_MS, { card: r.state.players[1]!.waste.at(-3)!.id, at: seen }]);
    // Dealt on when its timer is up: a card a step, then held whole a step, then down. The group keeps its size (`n`).
    out = dealOut(out.dealing, sync, seen + STOCK_CARD_MS);
    expect([theirs(out).draw, out.wait]).toEqual([{ n: 3, at: AT, off: 2 }, STOCK_CARD_MS]);
    out = dealOut(out.dealing, sync, seen + 2 * STOCK_CARD_MS);
    expect([theirs(out).draw, out.wait]).toEqual([{ n: 3, at: AT, off: 3 }, STOCK_CARD_MS]);
    const held = out.dealing;
    // Another snapshot of the same draw does not start it over; one that came 100 ms quicker puts its cards forward with the clock.
    const quicker = onSnapshot(sync, snap(2, r.state, seen + 2 * STOCK_CARD_MS + 100), seen + 2 * STOCK_CARD_MS);
    expect(dealOut(held, quicker, seen + 2 * STOCK_CARD_MS).dealing.flights.get(1)!.at).toBe(seen + 100);
    out = dealOut(held, onSnapshot(sync, snap(2, r.state, seen + 2 * STOCK_CARD_MS), seen + 2 * STOCK_CARD_MS), seen + 2 * STOCK_CARD_MS + 1);
    expect(out.dealing.flights.get(1)!.at).toBe(seen);
    out = dealOut(held, sync, seen + 3 * STOCK_CARD_MS);
    expect([theirs(out).draw, out.wait]).toEqual([{ n: 3, at: AT, down: true }, GLIDE]); // down here, though the snapshot has it in flight yet, and gliding onto the waste
    out = dealOut(out.dealing, sync, seen + 3 * STOCK_CARD_MS + GLIDE);
    expect([theirs(out).draw, out.wait]).toEqual([null, null]);
    // A window that was not looking when the draw was made (it has just sat back down) goes by the draw's own time,
    // and finds the cards due by then already off.
    const back = dealOut({ ...held, looking: false, flights: new Map() }, onSnapshot(freshSync, snap(0, r.state, seen), seen), seen);
    expect([back.dealing.flights.get(1)!.at, theirs(back).draw!.off]).toEqual([AT, 3]);
  });

  it('holds a group in flight where it lies once the round is not live, and starts afresh at no table', () => {
    const start = inPlay([0, 1], lcg(2));
    const r = applyIntent(start, 1, { k: 'draw' }, 1000);
    if (!r.ok) throw new Error(r.reason);
    const snap = (rev: number, game: GameState, ms: number) => ({ rev, ack: -1, room: { ...roomOf(game, 0), clock: { ms, running: true } } });
    let sync = onSnapshot(freshSync, snap(0, r.state, 1000), 1000);
    let out = dealOut(freshDealing, onSnapshot(freshSync, snap(0, start, 1000), 1000), 1000);
    out = dealOut(out.dealing, sync, 1000);
    expect(out.room!.game!.players[1]!.draw!.off).toBe(1);
    // Nertz is called: the group stays as it lies however long the window looks (until the round is over, and it is back on the stock).
    const called: GameState = { ...r.state, status: { at: 'grace', calledBy: 0, unheard: [1] } };
    sync = onSnapshot(sync, snap(1, called, 1000 + 2 * STOCK_CARD_MS), 1000 + 2 * STOCK_CARD_MS);
    out = dealOut(out.dealing, sync, 60_000);
    expect([out.room!.game!.players[1]!.draw!.off, out.wait, out.dealing.at]).toEqual([1, null, 1000]);
    // No table: nothing in flight and nothing remembered, but that the window was looking.
    out = dealOut(out.dealing, freshSync, 60_000);
    expect([out.room, out.wait, out.dealing]).toEqual([null, null, { flights: new Map(), led: null, looking: true, at: null }]);
  });

  it('reckons the round\'s clock from the snapshot that came quickest: steadily, never backwards, and afresh when it has been stopped or the round is another', () => {
    const s = server(inPlay([0, 1], lcg(6)), 0);
    const snap = (ms: number, running = true, round = 1) => ({ ...s.snapshot(), room: { ...s.snapshot().room, round, clock: { ms, running } } });
    expect([freshSync.lead, roundNow(freshSync, 123)]).toEqual([null, 0]);
    let sync = onSnapshot(freshSync, snap(1000), 5000);
    expect(roundNow(sync, 5100)).toBe(1100);
    sync = onSnapshot(sync, snap(1200), 5250); // 50 ms slower on the way: the clock is not put back
    expect(roundNow(sync, 5250)).toBe(1250);
    sync = onSnapshot(sync, snap(1400), 5380); // 20 ms quicker: nearer the server's
    expect(roundNow(sync, 5380)).toBe(1400);
    sync = onSnapshot(sync, snap(1500, false), 6000); // paused: it reads what the server said
    expect([sync.lead, roundNow(sync, 9000)]).toEqual([null, 1500]);
    sync = onSnapshot(sync, snap(1500), 20_000);
    expect(roundNow(sync, 20_010)).toBe(1510);
    sync = onSnapshot(sync, snap(0, true, 2), 30_000); // the next round's clock
    expect(roundNow(sync, 30_040)).toBe(40);
    // An intent is sent with what the clock read.
    expect(onSend(sync, { k: 'draw' }, 77).pending.at(-1)).toMatchObject({ at: 77 });
  });

  it('turns up a buried work card at once for a move between your own piles, and only once confirmed for a move to the middle', () => {
    const start = table([{ work: [{ down: 'C9', up: 'H6' }, 'S7', { down: 'D4', up: 'SA' }, []] }, {}]);
    const s = server(start, 0);
    let sync = onSnapshot(freshSync, s.snapshot());
    const pile = (i: number) => predict(sync)!.game!.players[0]!.work[i]!;
    // Onto your own pile: nobody can refuse it, and the C9 (sent ahead) shows at once.
    sync = send(sync, move('0:H6', work(1)));
    expect(pile(0).cards).toEqual([c('C9')]);
    // To the middle: it could lose a race, so the D4 lies face-up but unknown until the server says it landed...
    sync = send(sync, move('0:SA', felt(0, 0)));
    expect(pile(2)).toEqual({ cards: [{ id: '0:D4', owner: 0, hidden: true }], down: 0 });
    // ...and the snapshot that confirms it turns it up.
    s.apply(0, move('0:H6', work(1)), 1);
    s.apply(0, move('0:SA', felt(0, 0)), 2);
    sync = onSnapshot(sync, s.snapshot());
    expect(pile(2).cards).toEqual([c('D4')]);
  });

  it('turns up the next nertz card at once for a play onto your own pile, and only once confirmed for a play to the middle', () => {
    const start = table([{ nertz: 'D2 C9 H6 SA', work: ['S7', 'H10', [], []] }, {}]);
    const s = server(start, 0);
    let sync = onSnapshot(freshSync, s.snapshot());
    const nertz = () => predict(sync)!.game!.players[0]!.nertz;
    // To the middle: the H6 (sent ahead) lies face-up but unknown until the server says the ace landed...
    sync = send(sync, move('0:SA', felt(0, 0)));
    expect(nertz().at(-1)).toEqual({ id: '0:H6', owner: 0, hidden: true });
    // ...and the snapshot that confirms it turns it up.
    s.apply(0, move('0:SA', felt(0, 0)), 1);
    sync = onSnapshot(sync, s.snapshot());
    expect(nertz().at(-1)).toEqual(c('H6'));
    // Onto your own pile: nobody can refuse it, and the C9 (sent ahead with that snapshot) shows at once.
    sync = send(sync, move('0:H6', work(0)));
    expect(nertz().at(-1)).toEqual(c('C9'));
  });

  it('keeps unacknowledged intents applied over a snapshot that does not include them yet', () => {
    const s = server(dealWithAces(), 0);
    let sync = onSnapshot(freshSync, s.snapshot());
    const ace = s.game.players[0]!.work[0]!.cards[0]!;
    sync = send(sync, { k: 'move', cardId: ace.id, count: 1, to: { k: 'felt', x: 0, y: 0 } });
    sync = send(sync, { k: 'draw' });
    expect(sync.pending.map((p) => p.seq)).toEqual([1, 2]);

    // The opponent acts first; the snapshot reflects only that.
    s.apply(1, { k: 'draw' });
    sync = onSnapshot(sync, s.snapshot());
    expect(sync.pending).toHaveLength(2);
    let game = predict(sync)!.game!;
    expect(game.slots[0]!.cards.map((c) => c.id)).toEqual([ace.id]);
    expect(game.players[0]!.waste).toHaveLength(3);
    expect(game.players[1]!.waste).toHaveLength(3);

    // The server processes the first intent only.
    s.apply(0, sync.pending[0]!.intent, 1);
    sync = onSnapshot(sync, s.snapshot());
    expect(sync.pending.map((p) => p.seq)).toEqual([2]);
    game = predict(sync)!.game!;
    expect(game.slots.filter((pile) => pile !== null)).toHaveLength(1);
    expect(game.players[0]!.waste).toHaveLength(3);
    expect(checkInvariants(game)).toBeNull();
  });

  it('a lost race falls out of the replay: the card is simply back where the server says', () => {
    const base = dealWithAces();
    // Hand-build a race: one centre pile at its Ace, and both players hold that suit's 2 on a work pile.
    const suit = (base.players[0]!.work[0]!.cards[0] as Card).suit;
    const rig = (g: GameState): GameState => ({
      ...g,
      players: g.players.map((p) => {
        const all = [...p.nertz, ...p.stock, ...p.work.flatMap((w) => w.cards)] as Card[];
        const two = all.find((c) => c.suit === suit && c.rank === 2)!;
        const ace = all.find((c) => c.suit === suit && c.rank === 1)!;
        const rest = all.filter((c) => c !== two && c !== ace);
        return { ...p, nertz: rest.slice(0, 13), work: upWork([[ace], [two], [rest[13]!], [rest[14]!]]), stock: rest.slice(15), waste: [] };
      }),
    });
    const s = server(rig(base), 0);
    expect(checkInvariants(s.game)).toBeNull();
    const [mine, theirs] = s.game.players.map((p) => p.work[1]!.cards[0]!) as [Card, Card];
    const myAce = s.game.players[0]!.work[0]!.cards[0]!;
    s.apply(0, { k: 'move', cardId: myAce.id, count: 1, to: { k: 'felt', x: 0, y: 0 } });

    let sync = onSnapshot(freshSync, s.snapshot());
    const to = { k: 'slot', i: 0 } as const;
    sync = send(sync, { k: 'move', cardId: mine.id, count: 1, to });
    expect(predict(sync)!.game!.slots[0]!.cards.at(-1)!.id).toBe(mine.id);

    // The opponent's identical move reaches the server first.
    expect(s.apply(1, { k: 'move', cardId: theirs.id, count: 1, to })).toBe(true);
    sync = onSnapshot(sync, s.snapshot());
    // Still pending, but it no longer applies, so the replay skips it.
    expect(sync.pending).toHaveLength(1);
    let game = predict(sync)!.game!;
    expect(game.slots[0]!.cards.at(-1)!.id).toBe(theirs.id);
    expect(game.players[0]!.work[1]!.cards.map((c) => c.id)).toEqual([mine.id]);

    // The server rejects ours; ack still advances and pending empties.
    expect(s.apply(0, sync.pending[0]!.intent, 1)).toBe(false);
    sync = onSnapshot(sync, s.snapshot());
    expect(sync.pending).toHaveLength(0);
    game = predict(sync)!.game!;
    expect(game.players[0]!.work[1]!.cards.map((c) => c.id)).toEqual([mine.id]);
    expect(checkInvariants(game)).toBeNull();
  });

  it('a drag is two intents: hold is predicted at once, and release (or a move) puts the hand down again', () => {
    const s = server(dealWithAces(), 0);
    let sync = onSnapshot(freshSync, s.snapshot());
    const ace = s.game.players[0]!.work[0]!.cards[0]!;
    const me = () => predict(sync)!.game!.players[0]!;

    sync = send(sync, { k: 'hold', cardId: ace.id });
    expect(me().holding).toBe(ace.id);
    // Somebody else's move arrives first: the hold is still pending and still shown.
    s.apply(1, { k: 'draw' });
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
    expect(predict(sync)!.game!.slots[0]!.cards.map((c) => c.id)).toEqual([ace.id]);
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
    const ace = s.game.players[0]!.work[0]!.cards[0]!;
    sync = send(sync, { k: 'hold', cardId: ace.id });
    expect(predict(sync)!.game!.players[0]!.holding).toBe(ace.id);

    expect(s.apply(1, { k: 'nertz' })).toBe(true); // reaches the server before our hold
    expect(s.apply(0, sync.pending[0]!.intent, sync.seq)).toBe(false);
    sync = onSnapshot(sync, s.snapshot());
    const game = predict(sync)!.game!;
    expect(game.players[0]!.holding).toBeNull();
    expect(inGrace(game)).toEqual([]);
  });

  it('a hold on its way as the call comes, and the call on its way to us: the drag goes on, and the window says it heard', () => {
    const base = dealWithAces();
    const s = server({ ...base, players: base.players.map((p) => (p.seat === 1 ? { ...p, stock: [...p.stock, ...p.nertz], nertz: [] } : p)) }, 0);
    let sync = onSnapshot(freshSync, s.snapshot());
    const ace = s.game.players[0]!.work[0]!.cards[0]!;
    sync = send(sync, { k: 'hold', cardId: ace.id });
    expect(s.apply(1, { k: 'nertz', unheard: [0] })).toBe(true); // reaches the server before our hold, which is still on its way
    sync = onSnapshot(sync, s.snapshot());
    expect(hearsCall(sync.server)).toBe(true);
    expect(predict(sync)!.game!.players[0]!.holding).toBe(ace.id); // still in hand: the call had not reached us
    sync = send(sync, { k: 'heard' });
    const now = predict(sync)!;
    expect([hearsCall(now), inGrace(now.game!)]).toEqual([false, [0]]);
    const other = s.game.players[0]!.nertz.at(-1)!.id;
    expect(applyIntent(sync.server!.game!, 0, { k: 'hold', cardId: other }).ok).toBe(true); // a moment ago it could have been
    expect(applyIntent(now.game!, 0, { k: 'hold', cardId: other }).ok).toBe(false); // not now
    // The server sees it the same way, in the same order.
    expect(s.apply(0, sync.pending[0]!.intent, sync.pending[0]!.seq)).toBe(true);
    expect(s.apply(0, sync.pending[1]!.intent, sync.pending[1]!.seq)).toBe(true);
    sync = onSnapshot(sync, s.snapshot());
    expect(sync.pending).toEqual([]);
    expect(predict(sync)!.game).toEqual(now.game);
  });

  it('predicts through the grace window: the held card may still land, and only it', () => {
    const base = dealWithAces();
    const s = server({ ...base, players: base.players.map((p) => (p.seat === 1 ? { ...p, stock: [...p.stock, ...p.nertz], nertz: [] } : p)) }, 0);
    let sync = onSnapshot(freshSync, s.snapshot());
    const ace = s.game.players[0]!.work[0]!.cards[0]!;
    sync = send(sync, { k: 'hold', cardId: ace.id });
    s.apply(0, sync.pending[0]!.intent, sync.seq);
    s.apply(1, { k: 'nertz' }); // we were holding a playable card: we are in grace
    sync = onSnapshot(sync, { ...s.snapshot(), room: { ...s.snapshot().room, timerMs: 4000 } });
    expect(inGrace(predict(sync)!.game!)).toEqual([0]);

    // A flip is refused locally-replayed too; the held card's move is predicted and empties grace.
    sync = send(sync, { k: 'draw' });
    expect(predict(sync)!.game!.players[0]!.waste).toHaveLength(0);
    sync = send(sync, { k: 'move', cardId: ace.id, count: 1, to: { k: 'felt', x: 0, y: 0 } });
    const game = predict(sync)!.game!;
    expect(game.slots[0]!.cards.map((c) => c.id)).toEqual([ace.id]);
    expect(inGrace(game)).toEqual([]);
    expect(game.players[0]!.holding).toBeNull();
    expect(checkInvariants(game)).toBeNull();
  });

  it('clearing a finished pile is predicted, and only for the player who placed the King', () => {
    // Seat 0's whole spade suit stands in slot 3.
    const base = withPile(inPlay([0, 1], lcg(7)), 3, 0, 'S', 13);
    const rigged: GameState = {
      ...base,
      players: base.players.map((p) => {
        if (p.seat !== 0) return p;
        const rest = [...p.nertz, ...p.work.flatMap((w) => w.cards), ...p.stock] as Card[];
        return { ...p, nertz: rest.slice(0, 13), work: upWork([[rest[13]!], [rest[14]!], [rest[15]!], [rest[16]!]]), stock: rest.slice(17) };
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
    expect(game.slots[3]).toBeNull();
    expect(game.tray.map((t) => t.at(-1)!.rank)).toEqual([13]);
    expect(checkInvariants(game)).toBeNull();
  });

  it('ignores a snapshot older than the last one seen, and accepts an equal rev with a newer ack', () => {
    const s = server(inPlay([0, 1], lcg(3)), 0);
    const old = s.snapshot();
    s.apply(1, { k: 'draw' });
    let sync = onSnapshot(freshSync, s.snapshot());
    expect(onSnapshot(sync, old)).toBe(sync);

    sync = send(sync, { k: 'draw' });
    const same = { ...s.snapshot(), ack: sync.seq };
    expect(onSnapshot(sync, same).pending).toHaveLength(0);
  });

  it('does not replay outside a round', () => {
    const s = server(inPlay([0, 1], lcg(4)), 0);
    let sync = onSnapshot(freshSync, s.snapshot());
    sync = send(sync, { k: 'draw' });
    const results = { rev: 9, ack: -1, room: { ...s.snapshot().room, phase: 'results' as const } };
    sync = onSnapshot(sync, results);
    expect(predict(sync)).toBe(sync.server);
  });

  it('says create until it knows the table code, then join', () => {
    expect(hello(null, 'Ada', 'tokentoken')).toEqual({ t: 'create', name: 'Ada', token: 'tokentoken' });
    expect(hello('ABCD', 'Ada', 'tokentoken')).toEqual({ t: 'join', room: 'ABCD', name: 'Ada', token: 'tokentoken' });
  });

  it('a fresh connection starts seq and rev again', () => {
    let sync = send(send(freshSync, { k: 'draw' }), { k: 'draw' });
    expect(sync.seq).toBe(2);
    sync = freshSync;
    const s = server(inPlay([0, 1], lcg(5)), 0);
    sync = onSnapshot(sync, { ...s.snapshot(), rev: 0 }); // e.g. the server restarted: rev is low again
    expect(sync.server).not.toBeNull();
    expect(send(sync, { k: 'draw' }).pending[0]!.seq).toBe(1);
  });
});

describe('a refused drop in the replay', () => {
  it('ends the hold, as it will on the server: the predicted hand is empty once the race is known to be lost', () => {
    const s = server(dealWithAces(), 0);
    const [mine, theirs] = s.game.players.map((p) => p.work[0]!.cards[0]!) as [Card, Card];
    const to = { k: 'felt', x: 0, y: 0 } as const;
    let sync = onSnapshot(freshSync, s.snapshot());
    sync = send(sync, { k: 'hold', cardId: mine.id });
    sync = send(sync, { k: 'move', cardId: mine.id, count: 1, to });
    expect(predict(sync)!.game!.slots[0]!.cards.map((c) => c.id)).toEqual([mine.id]);

    // The other Ace lands first. Our hold has reached the server, our move has not been answered yet.
    s.apply(0, { k: 'hold', cardId: mine.id }, 1);
    s.apply(1, { k: 'move', cardId: theirs.id, count: 1, to });
    sync = onSnapshot(sync, s.snapshot());
    expect(sync.server!.game!.players[0]!.holding).toBe(mine.id); // the server still thinks we hold it...
    const game = predict(sync)!.game!;
    expect(game.players[0]!.holding).toBeNull(); // ...the replay already knows the drop will put it down
    expect(game.players[0]!.work[0]!.cards.map((c) => c.id)).toEqual([mine.id]);

    // And the server agrees when it gets there.
    expect(s.apply(0, { k: 'move', cardId: mine.id, count: 1, to }, 2)).toBe(false);
    sync = onSnapshot(sync, s.snapshot());
    expect(sync.pending).toHaveLength(0);
    expect(predict(sync)).toBe(sync.server);
    expect(sync.server!.game!.players[0]!.holding).toBeNull();
  });
});

describe('against the real Room', () => {
  it('what is predicted is what the Room then says, with a refused intent among mine and another player acting in between', () => {
    const { room, conns } = roomWith(2);
    const [me, them] = conns as [(typeof conns)[0], (typeof conns)[0]];
    startRound(room, me);
    room.flush();
    let sync = onSnapshot(freshSync, me.last);
    const seat = sync.server!.seat!;
    const sent = ([{ k: 'draw' }, { k: 'nertz' }, { k: 'stuck', on: true }, { k: 'draw' }] as Intent[]).map((intent) => {
      sync = send(sync, intent);
      return { t: 'intent', seq: sync.seq, intent };
    });
    const players = () => predict(sync)!.game!.players;
    const mine = () => players().find((p) => p.seat === seat)!;
    const predicted = mine().waste.map((c) => c.id);
    expect(predicted).toHaveLength(3); // (the second draw is refused: the first one's group is in flight)

    expect(told(room, them, { t: 'intent', seq: 1, intent: { k: 'draw' } })).toBe(true); // reaches the Room first
    for (const msg of sent.slice(0, 2)) told(room, me, msg);
    room.flush();
    sync = onSnapshot(sync, me.last);
    expect(sync.pending.map((p) => p.seq)).toEqual([3, 4]);
    expect(mine().waste.map((c) => c.id)).toEqual(predicted);
    expect(players().find((p) => p.seat !== seat)!.waste).toHaveLength(3);

    for (const msg of sent.slice(2)) told(room, me, msg);
    room.flush();
    sync = onSnapshot(sync, me.last);
    expect(sync.pending).toEqual([]);
    expect(predict(sync)).toBe(sync.server);
    expect(mine().waste.map((c) => c.id)).toEqual(predicted);
    expect(mine()).toMatchObject({ draw: { n: 3 }, stuck: true });
  });
});
