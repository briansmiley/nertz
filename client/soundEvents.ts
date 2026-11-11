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
import type { GameState, RoomView } from '../shared/types';

export type Who = 'me' | 'other';

export type Cue =
  /** A new round's cards appeared. */
  | { k: 'deal' }
  /** A card (or run) was picked up. */
  | { k: 'pickup'; who: Who }
  /** A card or run landed on a work pile. */
  | { k: 'work'; who: Who }
  /** Three off the stock. */
  | { k: 'flip'; who: Who }
  /** The waste went back under the stock. */
  | { k: 'recycle'; who: Who }
  /** A card landed in the middle; `rank` is 1 (Ace) to 12 (Queen). */
  | { k: 'centre'; who: Who; rank: number }
  /** A King completed a centre pile. */
  | { k: 'king'; who: Who }
  /** A finished pile went to the tray. */
  | { k: 'clear'; who: Who }
  /** A card went back where it came from: put down nowhere, refused by the server, or taken out of the hand. */
  | { k: 'home'; who: Who }
  | { k: 'nertz' };

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
    p.work.forEach((w, i) => w.forEach((c) => at.set(c.id, { pile: 'work', seat: p.seat, i })));
  }
  game.slots.forEach((s, i) => s.forEach((c) => at.set(c.id, { pile: 'slot', seat: -1, i })));
  game.tray.forEach((s, i) => s.forEach((c) => at.set(c.id, { pile: 'tray', seat: -1, i })));
  return at;
}

/** The cues for going from one rendered frame to the next, each at most once (cards to the middle: once per card). */
export function soundCues(prev: Frame | null, next: Frame): Cue[] {
  const a = prev?.room;
  const b = next.room;
  if (!a || !b || !prev.online || !next.online || a.code !== b.code) return [];
  if (a.round !== b.round) return b.phase === 'playing' && b.game ? [{ k: 'deal' }] : [];
  if (!a.game || !b.game || a.phase !== 'playing') return []; // nothing moves on a table that was already scored
  const you = b.you;
  const who = (seat: number): Who => (seat === you ? 'me' : 'other');
  const cues = new Map<string, Cue>();
  const add = (cue: Cue, key = '') => cues.set(`${cue.k}:${'who' in cue ? cue.who : ''}:${key}`, cue);

  const before = places(a.game);
  const after = places(b.game);
  const moved = new Set<string>();
  for (const [id, to] of after) {
    const from = before.get(id);
    if (!from || (from.pile === to.pile && from.seat === to.seat && from.i === to.i)) continue;
    moved.add(id);
    if (to.pile === 'slot') {
      if (from.seat < 0) continue;
      const pile = b.game.slots[to.i]!;
      const rank = pile.find((c) => c.id === id)!.rank;
      if (rank === 13) add({ k: 'king', who: who(from.seat) }, id);
      else add({ k: 'centre', who: who(from.seat), rank }, id);
    } else if (to.pile === 'tray') {
      if (from.pile === 'slot') add({ k: 'clear', who: who(b.game.tray[to.i]!.at(-1)!.owner) }, `${to.i}`);
    } else if (from.pile === 'slot' || (from.pile === 'work' && to.pile !== 'work')) {
      add({ k: 'home', who: who(to.seat) }); // no move goes that way: a predicted one was undone
    } else if (to.pile === 'work') {
      add({ k: 'work', who: who(to.seat) }, `${to.seat}.${to.i}`);
    } else if (to.pile === 'waste' && from.pile === 'stock') {
      add({ k: 'flip', who: who(to.seat) });
    } else if (to.pile === 'stock' && from.pile === 'waste') {
      add({ k: 'recycle', who: who(to.seat) });
    }
  }

  for (const p of b.game.players) {
    const was = a.game.players.find((q) => q.seat === p.seat)?.holding ?? null;
    if (p.holding !== null && p.holding !== was) add({ k: 'pickup', who: who(p.seat) });
    else if (p.holding === null && was !== null && !moved.has(was)) add({ k: 'home', who: who(p.seat) });
  }

  if (a.game.nertzCalledBy === null && b.game.nertzCalledBy !== null) add({ k: 'nertz' });
  return [...cues.values()];
}

/** The grace countdown ticks only for someone who still has a card to put down. */
export const graceTicking = (room: RoomView | null): boolean => room?.phase === 'playing' && !!room.game?.grace.includes(room.you);
