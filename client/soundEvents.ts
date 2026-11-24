// Which sounds a change of the rendered table calls for. Pure: it compares
// two successive rendered states card by card (ids are stable for a round) and
// names the cues; client/sound.ts makes the noise.
//
// Going by what is RENDERED (the server snapshot with our own unacknowledged
// moves replayed over it) is what makes every event sound exactly once:
// - our own move sounds the moment it is predicted, and its confirmation is
//   no change at all;
// - a predicted move the server refuses shows up as the card going back, and
//   that is the 'home' cue;
// - nothing is compared across a reconnect, a reload or a change of table, so
//   whatever happened meanwhile is not replayed.
import { calledBy, hasOpened, inGrace, reshuffledSince } from '../shared/engine';
import { START_BEAT_MS, START_BEATS, START_MS } from '../shared/protocol';
import type { GameState, RoomView } from '../shared/types';

export type Who = 'me' | 'other';

export type Cue =
  /** A new round's cards appeared. `work` is how many cards go to the work piles of the hand you watch (7 under the small-table rule, else 10): they leave the deck first, then the 13 of the nertz pile. */
  | { k: 'deal'; work: number }
  /** A card (or run) was picked up. */
  | { k: 'pickup'; who: Who }
  /** Before play opens, a hand was reburied: `n` face-down cards moved between its stock and its work piles. */
  | { k: 'rebury'; n: number }
  /** A card or run landed on a work pile. */
  | { k: 'work'; who: Who }
  /** One card off the stock, face-down onto the waste. */
  | { k: 'stock'; who: Who }
  /** The waste went back under the stock. */
  | { k: 'recycle'; who: Who }
  /** The whole table was stuck: every hand's waste went back under its stock at once. The table's sound, in place of a `recycle` for each hand. */
  | { k: 'reshuffle' }
  /** A card other than a King landed in the middle. */
  | { k: 'centre'; who: Who }
  /** A King completed a centre pile. */
  | { k: 'king'; who: Who }
  /** A finished pile went to the tray. */
  | { k: 'clear'; who: Who }
  /** A card went back where it came from: put down nowhere, refused by the server, or taken out of the hand. */
  | { k: 'home'; who: Who }
  /**
   * Somebody got there first: a move of ours that we showed as made was refused by the server after all. (Being told
   * we were sniped makes the same womp: client/sound.ts `beaten`.)
   */
  | { k: 'lost' }
  /** Nertz is called. `bot`: by a bot (which may say so aloud: client/sound.ts `botSays`). */
  | { k: 'nertz'; bot?: boolean }
  /** The dealer said go: one tick per number of "1, 2, 3" still to come, each `at` that many seconds from now. */
  | { k: 'count'; at: number[] }
  /** The word at the start, "NERTZ!": play is open. (Not the call that ends a round: that is `nertz`.) */
  | { k: 'open' };

/** A number whose moment passed less than this long ago still ticks (the snapshot took a moment to get here). */
const BEAT_SLACK_MS = 150;

/** When each number of the count still to come is said, in seconds from now, given `startMs` left until play opens. */
export function startBeats(startMs: number): number[] {
  const elapsed = START_MS - startMs;
  return Array.from({ length: START_BEATS }, (_, i) => i * START_BEAT_MS - elapsed)
    .filter((ms) => ms > -BEAT_SLACK_MS)
    .map((ms) => Math.max(0, ms) / 1000);
}

/** One rendered state: the (predicted) room, and whether it is live on the current connection. */
export interface Frame {
  room: RoomView | null;
  online: boolean;
}

type Pile = 'nertz' | 'work' | 'stock' | 'waste' | 'slot' | 'tray';
interface Place {
  pile: Pile;
  /** The hand it is in; -1 in the middle. */
  seat: number;
  /** Which work pile, slot or tray pile. */
  i: number;
}

function places(game: GameState): Map<string, Place> {
  const at = new Map<string, Place>();
  for (const p of game.players) {
    for (const c of p.nertz) at.set(c.id, { pile: 'nertz', seat: p.seat, i: 0 });
    for (const c of p.stock) at.set(c.id, { pile: 'stock', seat: p.seat, i: 0 });
    for (const c of p.waste) at.set(c.id, { pile: 'waste', seat: p.seat, i: 0 });
    p.work.forEach((w, i) => w.cards.forEach((c) => at.set(c.id, { pile: 'work', seat: p.seat, i })));
  }
  game.slots.forEach((s, i) => s?.cards.forEach((c) => at.set(c.id, { pile: 'slot', seat: -1, i })));
  game.tray.forEach((s, i) => s.forEach((c) => at.set(c.id, { pile: 'tray', seat: -1, i })));
  return at;
}

/** The cues for going from one rendered frame to the next, each at most once (cards to the middle: once per card). */
export function soundCues(prev: Frame | null, next: Frame): Cue[] {
  const a = prev?.room;
  const b = next.room;
  if (!a || !b || !prev.online || !next.online || a.code !== b.code) return [];
  if (a.round !== b.round) {
    if (b.phase !== 'playing' || !b.game) return [];
    const hand = b.game.players.find((p) => p.seat === b.seat) ?? b.game.players[0];
    return [{ k: 'deal', work: hand?.work.flatMap((w) => w.cards).length ?? 10 }];
  }
  if (!a.game || !b.game || a.phase !== 'playing') return []; // nothing moves on a table that was already scored
  const you = b.seat;
  const who = (seat: number): Who => (seat === you ? 'me' : 'other');
  const cues = new Map<string, Cue>();
  const add = (cue: Cue, key = '') => cues.set(`${cue.k}:${'who' in cue ? cue.who : ''}:${key}`, cue);

  // The opening: the count starts once (its ticks are scheduled from the duration the snapshot carried), play opens once.
  if (b.game.status.at === 'countdown' && a.game.status.at !== 'countdown') add({ k: 'count', at: startBeats(b.timerMs ?? START_MS) });
  if (hasOpened(b.game) && !hasOpened(a.game)) add({ k: 'open' });

  // The table was stuck and the server turned every stock over: said once, for the table, not hand by hand.
  const reshuffled = reshuffledSince(a.game, b.game);
  if (reshuffled) add({ k: 'reshuffle' });

  const before = places(a.game);
  const after = places(b.game);
  const moved = new Set<string>();
  let reburied = 0;
  for (const [id, to] of after) {
    const from = before.get(id);
    if (!from || (from.pile === to.pile && from.seat === to.seat && from.i === to.i)) continue;
    moved.add(id);
    // Before play opens the only cards that move between a hand's stock and work piles are face-downs reburied for a changed table.
    if (!hasOpened(b.game) && from.seat === to.seat && ((from.pile === 'stock' && to.pile === 'work') || (from.pile === 'work' && to.pile === 'stock'))) {
      reburied++;
      continue;
    }
    if (to.pile === 'slot') {
      if (from.seat < 0) continue;
      const pile = b.game.slots[to.i]!;
      if (pile.cards.find((c) => c.id === id)!.rank === 13) add({ k: 'king', who: who(from.seat) }, id);
      else add({ k: 'centre', who: who(from.seat) }, id);
    } else if (to.pile === 'tray') {
      if (from.pile === 'slot') add({ k: 'clear', who: who(b.game.tray[to.i]!.at(-1)!.owner) }, `${to.i}`);
    } else if (from.pile === 'slot' || (from.pile === 'work' && to.pile !== 'work')) {
      // No move goes that way: a predicted one was undone. Ours: we lost a race for that place. (Not with an Ace:
      // someone started a pile where ours was going, and it has other places to go. It just comes home.)
      const ace = from.pile === 'slot' && a.game.slots[from.i]?.cards.find((c) => c.id === id)?.rank === 1;
      add(who(to.seat) === 'me' && !ace ? { k: 'lost' } : { k: 'home', who: who(to.seat) });
    } else if (to.pile === 'work') {
      add({ k: 'work', who: who(to.seat) }, `${to.seat}.${to.i}`);
    } else if (to.pile === 'waste' && from.pile === 'stock') {
      add({ k: 'stock', who: who(to.seat) }, id); // once per card
    } else if (to.pile === 'stock' && from.pile === 'waste') {
      if (!reshuffled) add({ k: 'recycle', who: who(to.seat) });
    }
  }

  if (reburied > 0) add({ k: 'rebury', n: reburied });

  for (const p of b.game.players) {
    const was = a.game.players.find((q) => q.seat === p.seat)?.holding ?? null;
    if (p.holding !== null && p.holding !== was) add({ k: 'pickup', who: who(p.seat) });
    else if (p.holding === null && was !== null && !moved.has(was)) add({ k: 'home', who: who(p.seat) });
  }

  const caller = calledBy(b.game);
  if (calledBy(a.game) === null && caller !== null) add({ k: 'nertz', ...(b.players.find((p) => p.seat === caller)?.bot ? { bot: true } : {}) });
  return [...cues.values()];
}

/** The grace countdown ticks only for someone who still has a card to put down. */
export const graceTicking = (room: RoomView | null): boolean => !!room?.game && room.seat !== null && inGrace(room.game).includes(room.seat);
