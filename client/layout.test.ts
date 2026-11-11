import { describe, expect, it } from 'vitest';
import { deal as dealRound, DEAL_MS, finishDeal, NERTZ_SIZE, viewFor } from '../shared/engine';
import { CARD_RATIO, seatDir, toView, type TableMode } from '../shared/table';
import type { Card, GameState } from '../shared/types';
import { planFinale } from './Finale';
import { computeLayout, COUNTDOWN, countdownTop, DEAL, dealWait, dropTarget, fanOut, inside, TAG_H, toScreen, toTable, type Layout, type Rect } from './layout';
import { CARD_H, CARD_W } from './cards/Face';

/** A round in play: dealt, and the deal over. (The deal itself has its own tests.) */
const deal = (seats: readonly number[], rng: () => number, centre: TableMode = 'spots'): GameState => finishDeal(dealRound(seats, rng, { centre }));

function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
}

const seats = (n: number) => Array.from({ length: n }, (_, i) => i);
const overlap = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
/** The sizes the table is laid out for (desktop first), and a small laptop. */
const WINDOWS: [number, number][] = [
  [1280, 720],
  [1440, 900],
  [1920, 1080],
  [1024, 700],
];
const slotsOf = (L: Layout) => L.slots.filter((r) => r !== null);
/** An opponent's hand with the name line above it. */
const tagged = (o: { box: Rect }): Rect => ({ ...o.box, y: o.box.y - TAG_H, h: o.box.h + TAG_H });
/** Is any point of the rectangle on the disc as drawn (an ellipse)? */
const onEllipse = (L: Layout, r: Rect): boolean => {
  const d = L.disc;
  const x = Math.max(r.x, Math.min(d.cx, r.x + r.w));
  const y = Math.max(r.y, Math.min(d.cy, r.y + r.h));
  return ((x - d.cx) / d.rx) ** 2 + ((y - d.cy) / d.ry) ** 2 < 1;
};

/** Moves every player's whole spade suit into the tray and three hearts into slot 1, as if they had been played. */
function played(game: GameState): GameState {
  const out = (c: Card) => c.suit === 'S' || (c.suit === 'H' && c.rank <= 3 && c.owner === 0);
  const hand = (p: GameState['players'][number]) => [...p.nertz, ...p.work.flat(), ...p.stock] as Card[];
  const tray = game.players.map((p) => hand(p).filter((c) => c.suit === 'S').sort((a, b) => a.rank - b.rank));
  const hearts = hand(game.players[0]!).filter((c) => c.suit === 'H' && c.rank <= 3).sort((a, b) => a.rank - b.rank);
  return {
    ...game,
    tray,
    slots: game.slots.map((s, i) => (i === 1 ? hearts : s)),
    players: game.players.map((p) => {
      const rest = hand(p).filter((c) => !out(c));
      return { ...p, nertz: rest.slice(0, 3), work: [[rest[3]!], [rest[4]!], [rest[5]!], [rest[6]!]], down: [0, 0, 0, 0], stock: rest.slice(7) };
    }),
  };
}

describe('table layout', () => {
  it('seats 2 to 6 players around the disc with nothing overlapping anything, from every chair', () => {
    for (const [W, H] of WINDOWS) {
      for (let n = 2; n <= 6; n++) {
        const game = deal(seats(n), rng(n));
        for (let you = 0; you < n; you++) {
          const at = `${n} players, seat ${you}, ${W}x${H}`;
          const L = computeLayout(W, H, game, you);
          const me = L.me!.box;
          const hands = L.opponents.map(tagged);
          expect(L.opponents, at).toHaveLength(n - 1);
          // The corners that belong to something else: the chat button, the mute button and gear, the grace countdown.
          const chat: Rect = { x: 0, y: 0, w: 96, h: 46 };
          const knobs: Rect = { x: 0, y: H - 56, w: 104, h: 56 };
          const pill: Rect = { x: W - COUNTDOWN.right - COUNTDOWN.w, y: countdownTop(L, W), w: COUNTDOWN.w, h: COUNTDOWN.h };
          const trayOnScreen: Rect = { ...L.tray, w: W - L.tray.x };
          // (In a window narrower than the table is laid out for, your hand reaches the mute button's corner: a known limit.)
          const things = [...hands, me, trayOnScreen, chat, pill, ...(W >= 1280 ? [knobs] : [])];
          for (const [i, a] of things.entries()) for (const [j, b] of things.slice(i + 1).entries()) expect(overlap(a, b), `${at}: thing ${i} and thing ${i + 1 + j}`).toBe(false);
          for (const r of [...hands, me]) {
            expect(r.x, at).toBeGreaterThanOrEqual(0);
            expect(r.y, at).toBeGreaterThanOrEqual(0);
            expect(r.x + r.w, at).toBeLessThanOrEqual(W);
            expect(r.y + r.h, at).toBeLessThanOrEqual(H);
          }
          // The disc is in the middle of the window, on screen, and no hand, tray or corner reaches onto it.
          expect(L.disc.cx, at).toBeCloseTo(W / 2);
          expect(L.disc.cy - L.disc.ry, at).toBeGreaterThan(0);
          expect(L.disc.cy + L.disc.ry, at).toBeLessThan(me.y);
          for (const r of things) expect(onEllipse(L, r), at).toBe(false);
          // The piles: 4 per player, each wholly on the disc, no two touching, none tiny.
          const piles = slotsOf(L);
          expect(piles, at).toHaveLength(4 * n);
          for (const [i, a] of piles.entries()) {
            expect(a.w, at).toBeGreaterThan(n === 5 ? 26 : 32);
            expect(a.h / a.w, at).toBeCloseTo(CARD_H / CARD_W);
            for (const [x, y] of [[a.x, a.y], [a.x + a.w, a.y], [a.x, a.y + a.h], [a.x + a.w, a.y + a.h]] as const) {
              expect(((x - L.disc.cx) / L.disc.rx) ** 2 + ((y - L.disc.cy) / L.disc.ry) ** 2, at).toBeLessThanOrEqual(1.0001);
            }
            for (const b of piles.slice(i + 1)) expect(overlap({ x: a.x - 2, y: a.y - 2, w: a.w + 4, h: a.h + 4 }, b), at).toBe(false);
          }
          // The tray: as much of it beyond the right edge as on the table, beside your hand.
          expect(W - L.tray.x, at).toBeCloseTo(L.tray.w / 2);
          expect(L.tray.y, at).toBeGreaterThanOrEqual(me.y - 1);
        }
      }
    }
    expect(CARD_RATIO).toBeCloseTo(CARD_H / CARD_W); // the table's idea of a card is the one that is drawn
  });

  it('is one table for everybody, turned to each chair: positions agree in table space', () => {
    for (const [W, H] of [[1280, 720], [1440, 900]] as const) {
      for (let n = 2; n <= 6; n++) {
        const game = deal(seats(n), rng(n));
        const layouts = seats(n).map((you) => computeLayout(W, H, game, you));
        for (const [you, L] of layouts.entries()) {
          // You are at the bottom: your hand lies straight below the disc, and the disc is turned to your seat.
          expect(L.disc.i).toBe(you);
          expect(L.me!.box.y).toBeGreaterThan(L.disc.cy + L.disc.ry);
          L.slots.forEach((r, i) => {
            const c = { x: r!.x + r!.w / 2, y: r!.y + r!.h / 2 };
            // Each pile is drawn at its place in table space, as this chair sees it...
            const v = toView(game.places[i]!, you, n);
            expect((c.x - L.disc.cx) / L.disc.rx).toBeCloseTo(v.x, 6);
            expect((c.y - L.disc.cy) / L.disc.ry).toBeCloseTo(v.y, 6);
            // ...so the point of the table under it is the same point from every chair.
            const p = toTable(L.disc, c.x, c.y);
            expect(p.x).toBeCloseTo(game.places[i]!.x, 6);
            expect(p.y).toBeCloseTo(game.places[i]!.y, 6);
          });
          // Everyone else is where their seat is: to the left of the middle if they sit to your left, above if across.
          for (const o of L.opponents) {
            const dir = toView(seatDir(o.seat, n), you, n);
            const from = { x: o.box.x + o.box.w / 2 - L.disc.cx, y: o.box.y + o.box.h / 2 - L.disc.cy };
            if (Math.abs(dir.x) > 0.3) expect(Math.sign(from.x)).toBe(Math.sign(dir.x));
            if (dir.y < -0.4) expect(from.y).toBeLessThan(-L.disc.ry);
          }
        }
        if (n % 2 === 0) {
          // The player opposite sees it all the other way up: the pile nearest me is the farthest from them.
          const [mine, theirs] = [layouts[0]!, layouts[n / 2]!];
          const depth = (L: Layout, i: number) => (L.slots[i]!.y + L.slots[i]!.h / 2 - L.disc.cy) / L.disc.ry;
          const across = (L: Layout, i: number) => (L.slots[i]!.x + L.slots[i]!.w / 2 - L.disc.cx) / L.disc.rx;
          game.places.forEach((_, i) => {
            expect(depth(theirs, i)).toBeCloseTo(-depth(mine, i), 6);
            expect(across(theirs, i)).toBeCloseTo(-across(mine, i), 6);
          });
          const nearest = seats(4 * n).reduce((a, b) => (depth(mine, a) > depth(mine, b) ? a : b));
          expect(seats(4 * n).every((i) => depth(theirs, i) >= depth(theirs, nearest) - 1e-9)).toBe(true);
          // And each sits at the top of the other's screen.
          expect(mine.opponents.find((o) => o.seat === n / 2)!.box.y).toBeLessThan(mine.disc.cy - mine.disc.ry);
          expect(theirs.opponents.find((o) => o.seat === 0)!.box.y).toBeLessThan(theirs.disc.cy - theirs.disc.ry);
        }
      }
    }
  });

  it('draws the hand of a player across the table the other way round, and a neighbour\'s the same way as yours', () => {
    for (let n = 2; n <= 6; n++) {
      const L = computeLayout(1280, 720, deal(seats(n), rng(n)), 0);
      expect(L.me!.flip).toBe(false);
      expect(L.me!.nertz.x).toBeLessThan(L.me!.stock.x);
      for (const o of L.opponents) {
        const across = o.box.y < L.disc.cy - L.disc.ry; // along the top edge
        expect(o.flip).toBe(across);
        // Their left is your right: the nertz pile, leftmost for its owner, is at the right-hand end.
        expect(o.nertz.x < o.stock.x).toBe(!across);
        for (const r of [o.nertz, o.stock, o.waste, ...o.work]) {
          expect(r.x).toBeGreaterThanOrEqual(o.box.x - 0.01);
          expect(r.x + r.w).toBeLessThanOrEqual(o.box.x + o.box.w + 0.01);
        }
      }
    }
  });

  it('someone who is not in the round watches from the first player\'s chair, with that player\'s hand small at the bottom', () => {
    for (let n = 2; n <= 6; n++) {
      const L = computeLayout(1280, 720, deal(seats(n), rng(n)), 99);
      expect(L.me).toBeNull();
      expect(L.opponents).toHaveLength(n);
      const hands = L.opponents.map(tagged);
      for (const [i, a] of hands.entries()) {
        expect(onEllipse(L, a)).toBe(false);
        expect(a.y + a.h).toBeLessThanOrEqual(720);
        for (const b of hands.slice(i + 1)) expect(overlap(a, b)).toBe(false);
      }
      expect(L.opponents[0]!.box.y).toBeGreaterThan(L.disc.cy + L.disc.ry);
      expect(slotsOf(L)).toHaveLength(4 * n);
    }
  });

  it('maps table space to the screen and back exactly, on the disc and off it', () => {
    const L = computeLayout(1280, 720, deal(seats(5), rng(5)), 3);
    for (const p of [{ x: 0, y: 0 }, { x: 0.3, y: -0.8 }, { x: -1, y: 0 }, { x: 2.5, y: 1.7 }]) {
      const s = toScreen(L.disc, p);
      const back = toTable(L.disc, s.x, s.y);
      expect(back.x).toBeCloseTo(p.x, 9);
      expect(back.y).toBeCloseTo(p.y, 9);
    }
    // The centre of the table is the centre of the ellipse; the edge of the disc is the edge of the ellipse.
    expect(toScreen(L.disc, { x: 0, y: 0 })).toEqual({ x: L.disc.cx, y: L.disc.cy });
    for (let a = 0; a < 6.28; a += 0.4) {
      const s = toScreen(L.disc, { x: Math.cos(a), y: Math.sin(a) });
      expect(((s.x - L.disc.cx) / L.disc.rx) ** 2 + ((s.y - L.disc.cy) / L.disc.ry) ** 2).toBeCloseTo(1, 9);
    }
    // My own seat is straight down from the middle, whichever seat I have.
    const mine = toScreen(L.disc, seatDir(3, 5));
    expect(mine.x).toBeCloseTo(L.disc.cx, 6);
    expect(mine.y).toBeCloseTo(L.disc.cy + L.disc.ry, 6);
  });

  it('on a table without fixed places, draws a pile exactly where it was put down and nothing where there is none', () => {
    const game = deal(seats(4), rng(4), 'free');
    const ace = (owner: number): Card => ({ id: `ace${owner}`, owner, suit: 'S', rank: 1 });
    const placed: GameState = { ...game, slots: game.slots.map((s, i) => (i === 2 ? [ace(0)] : s)), places: game.places.map((at, i) => (i === 2 ? { x: 0.25, y: -0.4, r: 1.5 } : at)) };
    const L = computeLayout(1280, 720, placed, 1);
    expect(L.slots.map((r) => r !== null)).toEqual(seats(16).map((i) => i === 2));
    const r = L.slots[2]!;
    const p = toTable(L.disc, r.x + r.w / 2, r.y + r.h / 2);
    expect([p.x, p.y]).toEqual([expect.closeTo(0.25, 6), expect.closeTo(-0.4, 6)]);
    expect(r.rot).toBe(1.5);
    const card = L.cards.find((c) => c.card.id === 'ace0')!;
    expect([card.x, card.y, card.rot, card.pile, card.at]).toEqual([r.x, r.y, 1.5, 'slot', 2]);
    // Cards are smaller than on a table with spots, so that piles put down carelessly still all fit.
    expect(r.w).toBeLessThan(computeLayout(1280, 720, deal(seats(4), rng(4)), 1).slots[0]!.w);
  });

  it('keeps the tray where it is whatever is in it, shows the near side of every pile, and takes a drop anywhere out to the edge', () => {
    for (const [W, H] of [[1280, 720], [1440, 900]] as [number, number][]) {
      for (let n = 2; n <= 6; n++) {
        const full = played(deal(seats(n), rng(n)));
        const empty = computeLayout(W, H, { ...full, tray: [] }, 0);
        for (const piles of [0, 1, n]) {
          const game = { ...full, tray: full.tray.slice(0, piles) };
          const L = computeLayout(W, H, game, 0);
          expect(L.tray).toEqual(empty.tray);
          expect(L.slots).toEqual(empty.slots);
          const kings = L.cards.filter((c) => c.pile === 'tray' && 'rank' in c.card && c.card.rank === 13);
          expect(kings).toHaveLength(piles);
          for (const c of kings) {
            const w = c.s * CARD_W;
            expect(w).toBeGreaterThanOrEqual(L.slots[0]!.w); // never smaller than in the middle
            expect(inside(L.tray, c.x + 1, c.y + 1)).toBe(true);
            expect(W - c.x).toBeGreaterThan(w * 0.5); // more than half of the King is on the table...
            expect(c.x + w).toBeGreaterThan(W); // ...and the rest of it is over the edge
            expect(c.y + w * (CARD_H / CARD_W)).toBeLessThanOrEqual(L.tray.y + L.tray.h + 0.01);
          }
        }
        // The drop area: all of the visible tray and more, out past the edge of the window, and never a pile or your hand.
        const L = computeLayout(W, H, full, 0);
        const mid = L.tray.y + L.tray.h / 2;
        expect(inside(L.trayHit, L.tray.x + 2, L.tray.y + 2)).toBe(true);
        expect(inside(L.trayHit, L.tray.x - 5, mid)).toBe(true);
        expect(inside(L.trayHit, W - 1, mid)).toBe(true);
        expect(inside(L.trayHit, W + 200, mid)).toBe(true); // a captured pointer can be outside the window
        for (const r of slotsOf(L)) expect(overlap(L.trayHit, r)).toBe(false);
      }
    }
  });

  it('drop areas never touch: a card released between two piles is on neither', () => {
    for (const [W, H] of WINDOWS) {
      for (let n = 2; n <= 6; n++) {
        const L = computeLayout(W, H, deal(seats(n), rng(n)), 0);
        const hits = [...L.slotHit.filter((r) => r !== null), ...L.me!.workHit];
        for (const [i, a] of hits.entries()) for (const b of hits.slice(i + 1)) expect(overlap(a, b)).toBe(false);
        // Each area holds its own pile, and reaches only a little way past it.
        L.slots.forEach((r, i) => {
          expect(inside(L.slotHit[i]!, r!.x + r!.w / 2, r!.y + r!.h / 2)).toBe(true);
          expect(inside(L.slotHit[i]!, r!.x - r!.w * 0.07, r!.y + r!.h / 2)).toBe(false);
        });
        const [w0, w1] = [L.me!.work[0]!, L.me!.work[1]!];
        expect(hits.some((h) => inside(h, (w0.x + w0.w + w1.x) / 2, w0.y + 10))).toBe(false);
      }
    }
  });

  it('shows face-down work cards as backs under the face-up card, in every hand', () => {
    const game = viewFor(deal(seats(3), rng(9)), 0); // what a client is actually sent
    const L = computeLayout(1280, 800, game, 0);
    for (const p of game.players) {
      p.work.forEach((pile, i) => {
        const placed = pile.map((c) => L.cards.find((x) => x.card.id === c.id)!);
        expect(placed.map((c) => c.up)).toEqual(pile.map((_, j) => j >= p.down[i]!));
        for (let j = 1; j < placed.length; j++) expect(placed[j]!.y).toBeGreaterThan(placed[j - 1]!.y);
      });
    }
  });

  it('cascades tray piles so that every King shows, and brings them out for the end of the round', () => {
    const game = played(deal(seats(4), rng(11)));
    const live = computeLayout(1280, 800, game, 0);
    const kings = live.cards.filter((c) => c.pile === 'tray' && 'rank' in c.card && c.card.rank === 13).sort((a, b) => a.at - b.at);
    expect(kings).toHaveLength(4);
    for (let k = 1; k < kings.length; k++) {
      expect(kings[k]!.y - kings[k - 1]!.y).toBeGreaterThan(8); // a strip of each King stays visible
      expect(kings[k]!.z).toBeGreaterThan(kings[k - 1]!.z);
    }
    for (const c of kings) expect(inside(live.tray, c.x + 1, c.y + 1)).toBe(true);

    const flip = computeLayout(1280, 800, game, 0, 'flip');
    expect(flip.cards.filter((c) => c.pile === 'slot').every((c) => !c.up)).toBe(true);
    expect(flip.cards.filter((c) => c.pile === 'tray').every((c) => c.up)).toBe(true);
    const out = computeLayout(1280, 800, game, 0, 'out');
    expect(out.cards.filter((c) => c.pile === 'tray').every((c) => !c.up && !inside(out.tray, c.x + 1, c.y + 1))).toBe(true);
    // From the wash on, the middle's cards are the canvas's business.
    expect(computeLayout(1280, 800, game, 0, 'wash').cards.some((c) => c.pile === 'slot' || c.pile === 'tray')).toBe(false);
  });

  it('plans the wash: every card in the middle, sorted into one pile per player', () => {
    const game = played(deal(seats(4), rng(11)));
    const L = computeLayout(1280, 800, game, 0, 'wash');
    const plan = planFinale(L, game);
    expect(plan.movers).toHaveLength(4 * 13 + 3);
    expect(plan.piles.map((p) => p.total)).toEqual([16, 13, 13, 13]);
    for (const m of plan.movers) expect(plan.piles[m.pile]!.seat).toBe(m.owner);
    for (const [i, a] of plan.piles.entries()) for (const b of plan.piles.slice(i + 1)) expect(Math.abs(a.x - b.x)).toBeGreaterThan(plan.w);
  });

  // Regression: a drop was judged only by the centre of the grabbed card, so a card held by its corner and
  // pointed straight at a pile was refused.
  it('a release counts for the pile under the pointer, and only failing that for the pile under the card centre', () => {
    // Two piles side by side, a gap between them, and a hand-sized card.
    const a: Rect = { x: 300, y: 200, w: 50, h: 70 };
    const b: Rect = { x: 360, y: 200, w: 50, h: 70 };
    const hit = (r: Rect): Rect => ({ x: r.x - 3, y: r.y - 3, w: r.w + 6, h: r.h + 6 });
    const targets = [{ i: 7, hit: hit(a) }, { i: 8, hit: hit(b) }];
    const mid = (r: Rect) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
    // Grabbed 5px inside its top-left corner and pointed well inside pile 7: the card's centre is most of a card away.
    const card = { w: 95, h: 133 };
    const pointer = { x: a.x + a.w * 0.7, y: a.y + a.h * 0.7 };
    const centre = { x: pointer.x - 5 + card.w / 2, y: pointer.y - 5 + card.h / 2 };
    expect(inside(hit(a), centre.x, centre.y)).toBe(false); // the old rule: refused
    expect(dropTarget(targets, pointer, centre)?.i).toBe(7);
    // Pointer over no pile: the card's centre decides.
    expect(dropTarget(targets, { x: a.x + a.w / 2, y: a.y - 40 }, mid(b))?.i).toBe(8);
    // Neither over a pile (here: both in the gap between two slots): nothing, the card goes back.
    const gap = { x: (a.x + a.w + b.x) / 2, y: a.y + a.h / 2 };
    expect(dropTarget(targets, gap, gap)).toBeUndefined();
    expect(dropTarget(targets, gap, null)).toBeUndefined();
    // Only the targets offered count: a pile that does not take the card is never chosen, wherever the pointer is.
    expect(dropTarget(targets.filter((t) => t.i !== 7), pointer, null)).toBeUndefined();
  });

  describe('long work piles', () => {
    /** Seat 0's work pile 1 becomes `down` face-down cards under a run of `up` face-up ones (faces do not matter to the layout). */
    function longPile(n: number, down: number, up: number): GameState {
      const g = deal(seats(n), rng(n));
      return {
        ...g,
        players: g.players.map((p) => {
          if (p.seat !== 0) return p;
          const take = down + up - p.work[1]!.length;
          return { ...p, work: p.work.map((w, i) => (i === 1 ? [...w, ...p.stock.slice(0, take)] : w)), down: p.down.map((d, i) => (i === 1 ? down : d)), stock: p.stock.slice(take) };
        }),
      };
    }
    const strips = (L: ReturnType<typeof computeLayout>, game: GameState) => {
      const ys = game.players[0]!.work[1]!.map((c) => L.cards.find((x) => x.card.id === c.id)!.y);
      return ys.slice(1).map((y, j) => y - ys[j]!);
    };

    it('fanOut: full fan while it fits, then an even squeeze down to a whole rank, then only the oldest cards give way', () => {
      const up = (n: number) => Array.from({ length: n }, () => 1);
      const gaps = (at: number[]) => at.slice(1).map((y, j) => +(y - at[j]!).toFixed(3));
      expect(gaps(fanOut(up(4), 30, 20, 100))).toEqual([30, 30, 30]);
      expect(gaps(fanOut(up(5), 30, 20, 100))).toEqual([25, 25, 25, 25]);
      expect(gaps(fanOut(up(9), 30, 20, 100))).toEqual([8, 8, 8, 8, 8, 20, 20, 20]); // the newest stay readable, total still 100
      expect(gaps(fanOut([0.5, 0.5, 1, 1], 30, 20, 1000))).toEqual([15, 15, 30]); // face-down cards show half as much
      expect(fanOut([], 30, 20, 100)).toEqual([0]);
      expect(fanOut(up(1), 30, 20, 100)).toEqual([0]);
      expect(gaps(fanOut(up(30), 30, 20, 100)).every((g) => g > 3)).toBe(true); // absurdly long: just squeezed evenly
      expect(gaps(fanOut(up(6), 30, 0, 100))).toEqual([20, 20, 20, 20, 20]); // no minimum (opponents): always even
    });

    // Regression: a pile of 2 face-down + 10 face-up cards got about 17px a card: half a rank, no suit.
    it('rises into what felt there is between its column and the disc, never onto the disc, without moving anything else', () => {
      const [W, H] = [1440, 900];
      const short = computeLayout(W, H, deal(seats(2), rng(2)), 0);
      const game = longPile(2, 2, 10);
      const L = computeLayout(W, H, game, 0);
      const cardH = L.me!.nertz.h;
      const s = strips(L, game);
      // The newest cards show their whole rank; the face-down cards and the oldest give way first.
      for (const step of s.slice(-3)) expect(step).toBeGreaterThanOrEqual(cardH * 0.21 - 0.01);
      expect(s.every((step) => step > 4)).toBe(true);
      expect(L.slots).toEqual(short.slots);
      expect(L.tray).toEqual(short.tray);
      const first = L.cards.find((c) => c.card.id === game.players[0]!.work[1]![0]!.id)!;
      expect(first.y).toBeLessThan(L.me!.nertz.y); // it starts above the row...
      expect(first.y).toBeGreaterThan(L.disc.cy + L.disc.ry); // ...and stops short of the disc,
      for (const hit of L.slotHit) expect(overlap(hit!, L.me!.workHit[1]!)).toBe(false); // as do the drop areas
      expect(L.me!.work[1]!.y + cardH).toBeLessThanOrEqual(H); // the top card is whole
      expect(inside(L.me!.workHit[1]!, first.x + 5, first.y + 5)).toBe(true); // the whole column takes a drop
      // The other piles and the rest of the hand stay exactly where they were.
      expect([L.me!.nertz, L.me!.stock, L.me!.work[0], L.me!.work[2]]).toEqual([short.me!.nertz, short.me!.stock, short.me!.work[0], short.me!.work[2]]);
      // A pile of ordinary length is not lifted at all.
      const usual = longPile(2, 1, 4);
      expect(computeLayout(W, H, usual, 0).cards.find((c) => c.card.id === usual.players[0]!.work[1]![0]!.id)!.y).toBe(L.me!.nertz.y);
    });

    it('in a low window (1280x720), where there is hardly any felt to rise into, the newest cards keep their whole rank', () => {
      const game = longPile(2, 2, 10);
      const L = computeLayout(1280, 720, game, 0);
      const cardH = L.me!.nertz.h;
      const s = strips(L, game);
      expect(s.slice(-3).every((step) => step >= cardH * 0.21 - 0.01)).toBe(true); // it used to be 17px (0.13) for every card
      expect(s.every((step) => step > 4)).toBe(true);
      expect(L.me!.work[1]!.y + cardH).toBeLessThanOrEqual(720);
      // Seven face-up cards on one face-down card, a long pile by any normal standard, are all still readable.
      const seven = longPile(2, 1, 7);
      expect(strips(computeLayout(1280, 720, seven, 0), seven).slice(1).every((step) => step >= cardH * 0.21 - 0.01)).toBe(true);
    });

    it('with no felt to spare (six players) keeps the newest cards readable and lets only the oldest give way', () => {
      const game = longPile(6, 2, 10);
      const L = computeLayout(1280, 720, game, 0);
      const cardH = L.me!.nertz.h;
      const s = strips(L, game);
      const readable = s.filter((step) => step >= cardH * 0.21 - 0.01).length;
      expect(readable).toBeGreaterThanOrEqual(3);
      expect(s.slice(-readable).every((step) => step >= cardH * 0.21 - 0.01)).toBe(true); // and they are the newest ones
      expect(s.every((step) => step > 2)).toBe(true); // every card can still be seen to be there
      expect(L.me!.work[1]!.y + cardH).toBeLessThanOrEqual(720);
      for (const hit of L.slotHit) expect(overlap(hit!, L.me!.workHit[1]!)).toBe(false);
      // The longest pile there can be (3 face-down under King to Ace) still fits, every card a visible strip.
      const most = longPile(6, 3, 13);
      const M = computeLayout(1280, 720, most, 0);
      expect(strips(M, most).every((step) => step > 2)).toBe(true);
      expect(M.me!.work[1]!.y + cardH).toBeLessThanOrEqual(720);
    });
  });

  // Regression: the countdown was a 331px pill fixed in the top-right corner, over whoever sat there.
  it('puts the grace countdown where no opponent sits: the corner if it is free, otherwise the nearest clear place below', () => {
    for (const [W, H] of [...WINDOWS, [1280, 720]] as [number, number][]) {
      for (let n = 2; n <= 6; n++) {
        const L = computeLayout(W, H, deal(seats(n), rng(n)), 0);
        const pill: Rect = { x: W - COUNTDOWN.right - COUNTDOWN.w, y: countdownTop(L, W), w: COUNTDOWN.w, h: COUNTDOWN.h };
        for (const o of L.opponents) expect(overlap(pill, tagged(o))).toBe(false);
        expect(pill.y).toBe(12); // nobody is ever seated in the top-right corner: it is the countdown's
        expect(onEllipse(L, pill)).toBe(false);
      }
    }
    expect(CARD_H / CARD_W).toBeCloseTo(1.4);
  });
});

describe('the deal', () => {
  const LEAVING = NERTZ_SIZE + 1 + 2 + 3 + 4; // the nertz pile and the four work piles; the rest is the stock

  it('has every card down, with a beat to spare, before the server turns the faces over', () => {
    const waits = Array.from({ length: LEAVING }, (_, i) => dealWait(i, DEAL_MS)!);
    expect(waits.every((w, i) => w !== null && (i === 0 || w > waits[i - 1]!))).toBe(true); // one after another
    expect(DEAL.step).toBeLessThan(DEAL.duration * 1000); // overlapping: the next has left before this one lands
    const landed = waits[LEAVING - 1]! + DEAL.duration * 1000;
    expect(landed).toBeLessThanOrEqual(DEAL_MS - 200);
    expect(landed).toBeGreaterThan(DEAL_MS / 2); // and it fills the time: this is a deal, not a flash
  });

  it('in a window that arrives late, leaves the cards already dealt in place and deals the rest on the same schedule', () => {
    const late = 900;
    const waits = Array.from({ length: LEAVING }, (_, i) => dealWait(i, DEAL_MS - late));
    const gone = waits.filter((w) => w === null).length;
    expect(gone).toBeGreaterThan(0);
    expect(gone).toBeLessThan(LEAVING);
    waits.forEach((w, i) => expect(w).toBe(i < gone ? null : dealWait(i, DEAL_MS)! - late));
    expect(Array.from({ length: LEAVING }, (_, i) => dealWait(i, 0)).every((w) => w === null)).toBe(true); // nothing left to deal
  });
});
