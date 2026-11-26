// A table put back together from the last snapshot a window had of it (`RoomView`): for a window that has lost its
// line, at a table where nobody else is but bots, to play it on by itself (client/local.ts). A snapshot is the table
// as one seat sees it, so some of it is not there, and is made up:
//   the faces of the cards that lie face-down. Every face in sight stays where it is; each deck's other faces are
//     shuffled over its face-down cards (their ids, and where they lie, are in the snapshot).
//   whose the hands put aside before Start were, and the round's snipes so far: none.
//   what was said in chat: nothing (a table of the window's own has no chat).
//   who anyone is signed in as: nobody (offline you are a name).
//   which sitting of the table it is, for the record: it is on no record from here on.
// What is on a timer (the deal, "1, 2, 3", the grace after a call) is not kept at all: `Room.restored` brings a table
// back with those over, as after an update.
import { KEPT, type Kept } from '../server/room';
import { isHidden, SUITS, type Rng } from '../shared/engine';
import type { AnyCard, Card, GameState, RoomView } from '../shared/types';

/** `game`, a seat's view of a round, with every face-down card given a face: for each deck, the faces not in sight, shuffled. */
function turnedUp(game: GameState, rng: Rng): GameState {
  const middle = [...game.slots.flatMap((pile) => pile?.cards ?? []), ...game.tray.flat()];
  return {
    ...game,
    players: game.players.map((p) => {
      const mine: AnyCard[] = [...p.nertz, ...p.work.flatMap((w) => w.cards), ...p.stock, ...p.waste, ...middle.filter((c) => c.owner === p.seat)];
      const seen = new Set(mine.flatMap((c) => (isHidden(c) ? [] : [`${c.suit}${c.rank}`])));
      const rest = SUITS.flatMap((suit) => Array.from({ length: 13 }, (_, r) => ({ suit, rank: r + 1 }))).filter((f) => !seen.has(`${f.suit}${f.rank}`));
      for (let i = rest.length - 1; i > 0; i--) {
        const j = Math.min(i, Math.floor(rng() * (i + 1)));
        [rest[i], rest[j]] = [rest[j]!, rest[i]!];
      }
      const up = (c: AnyCard): AnyCard => (isHidden(c) ? ({ id: c.id, owner: c.owner, ...rest.pop()! } satisfies Card) : c);
      return { ...p, nertz: p.nertz.map(up), work: p.work.map((w) => ({ ...w, cards: w.cards.map(up) })), stock: p.stock.map(up), waste: p.waste.map(up) };
    }),
  };
}

/**
 * The table `view` shows, as one is kept (`Kept`, for `Room.restored`): you (`token`, this window's) and the bots where
 * you all were, with your scores, names and cards' looks, the table's rules and seats, its last round, the round's clock
 * as it read, and the round itself with its face-down cards filled in (see above). Only for a table you are `alone` at.
 */
export function rebuild(view: RoomView, token: string, rng: Rng = Math.random): Kept {
  let queue = 0;
  return {
    v: KEPT,
    code: view.code,
    phase: view.phase,
    round: view.round,
    lastRound: view.lastRound,
    settings: view.settings,
    capacity: view.seats.of,
    social: { text: false, voice: false, watchText: true, watchVoice: true, lines: [], nextId: 1 },
    snipes: [],
    sitting: '',
    queue: view.players.filter((p) => p.queued).length,
    sittings: Math.max(-1, ...view.players.map((p) => p.sat ?? -1)) + 1,
    ids: Math.max(-1, ...view.players.map((p) => p.id)) + 1,
    state: view.game && turnedUp(view.game, rng),
    aside: [],
    players: view.players.map((p) => ({
      id: p.id,
      token: p.bot ? `bot:${p.id}` : token,
      account: null,
      name: p.name,
      seat: p.seat,
      ...(p.sat === undefined ? {} : { sat: p.sat }),
      queued: p.queued ? ++queue : null, // (the list is in the order they will be seated)
      ...(p.left ? { out: 'stood' as const } : {}), // (the only way you are up from your cards for good and still here)
      ...(p.standing ? { standing: true as const } : {}),
      score: p.score,
      rounds: p.rounds,
      calls: p.calls,
      look: p.look,
      ...(p.ready && !p.bot ? { ready: true } : {}),
      ...(p.bot ? { bot: p.bot } : {}),
    })),
    // (The table is yours if you deal at it: nobody else could.)
    host: view.players.find((p) => p.isHost && !p.bot)?.id ?? null,
    startTold: view.round,
    played: view.clock?.ms ?? null,
  };
}
