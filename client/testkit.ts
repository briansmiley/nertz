// A window at a table, for the tests of what its player does with a pointer: gestures go in as the browser reports
// them, hand.ts decides, and what it decides is carried out as Table.tsx and net.ts would, with nothing drawn. For
// tests only.
//
// Time is the test's own: whatever runs on a timer (the reports of where a carried card is) uses the ordinary clock
// and `setTimeout`, so under `vi.useFakeTimers()` it runs when the test advances the clock.
import { expect } from 'vitest';
import { applyIntent, isLive, viewFor } from '../shared/engine';
import type { DragAt } from '../shared/protocol';
import type { Pt } from '../shared/table';
import { roomOf } from '../shared/testkit';
import type { GameState, Intent, RoomView } from '../shared/types';
import { CARD_H, CARD_W } from './cards/Face';
import { waitingPile } from './clearFirst';
import { cardDue, decide, EMPTY, reporter, sight, type Effect, type Gesture, type Grasp, type Hand, type Scene, type Sight } from './hand';
import { computeLayout, inside, type Layout, type Placed, type Rect } from './layout';

/** `seatAt`: a player at their window. */
export interface Seated {
  /** The round as the server has it: what this window sends is played there at once, as is what `plays` has the others do. */
  readonly game: GameState;
  /** The table as it is laid out in this window. */
  readonly L: Layout;
  readonly hand: Hand | null;
  /** What there is to show of the hand: null if nothing is in it. */
  readonly sight: Sight | null;
  /** The next card of a group coming off the stock is due (hand.ts `cardDue`). */
  readonly cardDue: boolean;
  /** Every intent this window sent, in order. */
  sent: Intent[];
  /** Everything else hand.ts asked for: a snipe to be judged, a deal off the stock, a nag, a pile fanned out. */
  did: Exclude<Effect, { k: 'send' }>[];
  /** Where the card in hand was reported to be, to the others: as many reports as really went out. */
  reports: DragAt[];
  /** The card `id` as it is laid out, and the middle of it. */
  card(id: string): Placed;
  at(id: string): Pt;
  /** The middle of the top card of your work pile `i`, and of the pile in slot `i` of the middle. */
  work(i: number): Pt;
  slot(i: number): Pt;
  /** One gesture, as the browser reports it. `on` is whatever lies under the point, unless it is given. */
  down(p: Pt, on?: Extract<Gesture, { k: 'down' }>['on']): void;
  move(p: Pt): void;
  up(p: Pt): void;
  /** Down and up at one point. */
  tap(p: Pt): void;
  /** Down at `from`, across to `to` in a few moves, and up there. */
  drag(from: Pt, to: Pt): void;
  /** Any gesture at all (another pointer, a cancel, Escape). */
  act(g: Gesture): void;
  /** Someone else at the table plays, and the snapshot reaches this window. */
  plays(seat: number, intent: Intent): void;
}

const mid = (r: Rect): Pt => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });

/**
 * `you` at a table where `game` is being played, in a window `W` by `H`, with a mouse or (`touch`) a finger. `room`
 * is anything else about the room (paused, scored); `scene` overrides what the table says of itself (`frozen`, the
 * end of a round playing out, the tap-to-move rule).
 */
export function seatAt(game: GameState, { you = 0, W = 1440, H = 900, touch = false, room = {}, scene = {} }: { you?: number; W?: number; H?: number; touch?: boolean; room?: Partial<RoomView>; scene?: Partial<Scene> } = {}): Seated {
  let grasp: Grasp = EMPTY;
  let view = viewFor(game, you);
  let L = computeLayout(W, H, view, you);
  const telling = reporter((at) => seat.reports.push(at));
  const look = (): Scene => ({
    game: view,
    you,
    L,
    byId: new Map(L.cards.map((c) => [c.card.id, c])),
    live: true,
    playingOut: false,
    frozen: !isLive(view) || !!room.paused,
    tapToMove: true,
    waiting: waitingPile(roomOf(game, you, room)),
    plays: (intent) => applyIntent(view, you, intent).ok,
    ...scene,
  });
  const snapshot = (next: GameState) => {
    game = next;
    view = viewFor(game, you);
    L = computeLayout(W, H, view, you);
  };
  const under = (p: Pt): Extract<Gesture, { k: 'down' }>['on'] => {
    const top = L.cards.filter((c) => inside({ x: c.x, y: c.y, w: c.s * CARD_W, h: c.s * CARD_H }, p.x, p.y)).sort((a, b) => b.z - a.z)[0];
    return top ? { card: top.card.id } : L.me && inside(L.me.stockPad, p.x, p.y) ? 'stock' : null;
  };
  /** As Table.tsx's `aim`: after the hand has moved, and when the table changes under it. */
  const aim = () => {
    const report = seat.sight?.report;
    if (report) telling.tell(report);
  };
  const seat: Seated = {
    get game() {
      return game;
    },
    get L() {
      return L;
    },
    get hand() {
      return grasp.hand;
    },
    get sight() {
      const d = grasp.hand;
      return d && d.phase !== 'pressed' ? sight(d, look()) : null;
    },
    get cardDue() {
      return cardDue(look());
    },
    sent: [],
    did: [],
    reports: [],
    card(id) {
      const c = L.cards.find((c) => c.card.id === id);
      if (!c) throw new Error(`no card ${id} on the table`);
      return c;
    },
    at: (id) => mid({ ...seat.card(id), w: seat.card(id).s * CARD_W, h: seat.card(id).s * CARD_H }),
    work: (i) => mid(L.me!.work[i]!),
    slot: (i) => mid(L.slots[i]!),
    down: (p, on = under(p)) => seat.act({ k: 'down', pointer: 1, ...p, touch, main: true, on }),
    move: (p) => seat.act({ k: 'move', pointer: 1, ...p }),
    up: (p) => seat.act({ k: 'up', pointer: 1, ...p, touch }),
    tap(p) {
      seat.down(p);
      seat.up(p);
    },
    drag(from, to) {
      seat.down(from);
      for (let i = 1; i <= 4; i++) seat.move({ x: from.x + ((to.x - from.x) * i) / 4, y: from.y + ((to.y - from.y) * i) / 4 });
      seat.up(to);
    },
    act(g) {
      const [was, before] = [grasp.hand, game];
      const { effects, ...next } = decide(grasp, g, look());
      grasp = next;
      for (const fx of effects) {
        if (fx.k !== 'send') seat.did.push(fx);
        else {
          // (As net.ts: what is sent has been asked about, and is played at once.)
          const played = applyIntent(game, you, fx.intent);
          expect(played.ok, `sent an intent that is not playable: ${JSON.stringify(fx.intent)}`).toBe(true);
          seat.sent.push(fx.intent);
          if (played.ok) snapshot(played.state);
        }
      }
      if (next.hand !== was && next.hand?.phase === 'carried') aim();
      if (was && was.phase !== 'pressed' && !next.hand) telling.stop();
      // (As Table.tsx after every render: the table may have taken the card back, and a hand holding still aims again.)
      if (g.k === 'table') return;
      seat.act({ k: 'table' });
      if (game !== before) aim();
    },
    plays(by, intent) {
      const played = applyIntent(game, by, intent);
      if (!played.ok) throw new Error(`seat ${by} cannot play ${JSON.stringify(intent)}: ${played.reason}`);
      snapshot(played.state);
      seat.act({ k: 'table' });
      aim();
    },
  };
  return seat;
}
