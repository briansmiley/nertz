import { describe, expect, it } from 'vitest';
import { deal as dealRound, DEAL_MS, finishDeal, NERTZ_SIZE, openPlay, startCountdown, viewFor } from '../shared/engine';
import type { Card, GameState } from '../shared/types';
import { planFinale } from './Finale';
import { computeLayout, COUNTDOWN, countdownTop, DEAL, dealWait, dropTarget, fanOut, inside, type Rect } from './layout';
import { CARD_H, CARD_W } from './cards/Face';

/** A round in play: dealt, and the deal over. (The deal itself has its own tests.) */
const deal = (seats: readonly number[], rng: () => number): GameState => openPlay(startCountdown(finishDeal(dealRound(seats, rng))));

function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
}

const seats = (n: number) => Array.from({ length: n }, (_, i) => i);
const overlap = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const WINDOWS: [number, number][] = [
  [1024, 700],
  [1280, 800],
  [1440, 900],
  [1920, 1080],
];

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
  it('fits 4 slots per player on the table for 2 to 6 players, centred, with the tray half off the right edge and nothing overlapping', () => {
    for (const [W, H] of [...WINDOWS, [1280, 720]] as [number, number][]) {
      for (let n = 2; n <= 6; n++) {
        const L = computeLayout(W, H, deal(seats(n), rng(n)), 0);
        expect(L.slots).toHaveLength(4 * n);
        for (const r of L.slots) {
          expect(r.x).toBeGreaterThanOrEqual(0);
          expect(r.x + r.w).toBeLessThanOrEqual(W);
          expect(r.y).toBeGreaterThanOrEqual(0);
          expect(r.w).toBeGreaterThan(20);
        }
        const left = Math.min(...L.slots.map((r) => r.x));
        const right = Math.max(...L.slots.map((r) => r.x + r.w));
        expect(left + right).toBeCloseTo(W); // the grid is centred in the window
        // The tray: as much of it beyond the edge as on the table, and on the table enough to show most of a pile.
        expect(W - L.tray.x).toBeCloseTo(L.tray.w / 2);
        expect(W - L.tray.x).toBeGreaterThan(L.slots[0]!.w * 0.6);
        expect(L.tray.y).toBeGreaterThanOrEqual(0);
        const boxes = [...L.slots, L.tray];
        for (const [i, a] of boxes.entries()) for (const b of boxes.slice(i + 1)) expect(overlap(a, b)).toBe(false);
        expect(L.tray.x - right).toBeGreaterThan(10); // and a clear strip of felt between the slots and the tray
        for (const o of L.opponents) expect(overlap(L.tray, { ...o.box, y: o.box.y - 28, h: o.box.h + 28 })).toBe(false);
        // The middle stays clear of your own hand.
        for (const r of boxes) expect(r.y + r.h).toBeLessThanOrEqual(L.me!.box.y);
      }
    }
  });

  it('keeps the tray where it is whatever is in it, shows the near side of every pile, and takes a drop anywhere out to the edge', () => {
    const base = played(deal(seats(6), rng(11))); // six finished piles
    for (const [W, H] of [[1280, 720], [1440, 900]] as [number, number][]) {
      for (let n = 2; n <= 6; n++) {
        const full = played(deal(seats(n), rng(n)));
        const empty = computeLayout(W, H, { ...full, tray: [] }, 0);
        for (const piles of [0, 1, n]) {
          const game = { ...full, tray: full.tray.slice(0, piles) };
          const L = computeLayout(W, H, game, 0);
          expect(L.tray).toEqual(empty.tray);
          expect(L.slots).toEqual(empty.slots);
          const w = L.slots[0]!.w;
          const kings = L.cards.filter((c) => c.pile === 'tray' && 'rank' in c.card && c.card.rank === 13);
          expect(kings).toHaveLength(piles);
          for (const c of kings) {
            expect(inside(L.tray, c.x + 1, c.y + 1)).toBe(true);
            expect(W - c.x).toBeGreaterThan(w * 0.5); // more than half of the King is on the table...
            expect(c.x + w).toBeGreaterThan(W); // ...and the rest of it is over the edge
            expect(c.y + w * (CARD_H / CARD_W)).toBeLessThanOrEqual(L.tray.y + L.tray.h + 0.01);
          }
        }
        // The drop area: all of the visible tray and more, out past the edge of the window, and never a slot.
        const L = computeLayout(W, H, full, 0);
        const mid = L.tray.y + L.tray.h / 2;
        expect(inside(L.trayHit, L.tray.x + 2, L.tray.y + 2)).toBe(true);
        expect(inside(L.trayHit, L.tray.x - 5, mid)).toBe(true);
        expect(inside(L.trayHit, W - 1, mid)).toBe(true);
        expect(inside(L.trayHit, W + 200, mid)).toBe(true); // a captured pointer can be outside the window
        for (const r of L.slots) expect(overlap(L.trayHit, r)).toBe(false);
      }
    }
    expect(base.tray).toHaveLength(6);
  });

  it('drop areas never touch: a card released between two piles is on neither', () => {
    for (const [W, H] of WINDOWS) {
      for (let n = 2; n <= 6; n++) {
        const L = computeLayout(W, H, deal(seats(n), rng(n)), 0);
        const hits = [...L.slotHit, ...L.me!.workHit];
        for (const [i, a] of hits.entries()) for (const b of hits.slice(i + 1)) expect(overlap(a, b)).toBe(false);
        // Each area holds its own pile, and the midpoint between two neighbours is in neither.
        L.slots.forEach((r, i) => expect(inside(L.slotHit[i]!, r.x + r.w / 2, r.y + r.h / 2)).toBe(true));
        const [a, b] = [L.slots[0]!, L.slots[1]!];
        const between = { x: (a.x + a.w + b.x) / 2, y: a.y + a.h / 2 };
        expect(hits.some((h) => inside(h, between.x, between.y))).toBe(false);
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
    const L = computeLayout(1280, 720, deal(seats(6), rng(6)), 0);
    const targets = L.slotHit.map((hit, i) => ({ i, hit }));
    const mid = (r: Rect) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
    const [a, b] = [L.slots[7]!, L.slots[8]!];
    // Grabbed 5px inside its top-left corner and pointed well inside slot 7: the card's centre is most of a card away.
    const card = { w: L.me!.nertz.w, h: L.me!.nertz.h };
    const pointer = { x: a.x + a.w * 0.7, y: a.y + a.h * 0.7 };
    const centre = { x: pointer.x - 5 + card.w / 2, y: pointer.y - 5 + card.h / 2 };
    expect(inside(L.slotHit[7]!, centre.x, centre.y)).toBe(false); // the old rule: refused
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
    it('rises into the free felt above its column instead of being squeezed, without moving the slots or leaving the window', () => {
      const [W, H] = [1440, 900];
      const short = computeLayout(W, H, deal(seats(2), rng(2)), 0);
      const game = longPile(2, 2, 10);
      const L = computeLayout(W, H, game, 0);
      const cardH = L.me!.nertz.h;
      const s = strips(L, game);
      // Every face-up card but the oldest shows its whole rank; the face-down cards and that one give way first.
      for (const step of s.slice(3)) expect(step).toBeGreaterThanOrEqual(cardH * 0.21 - 0.01);
      expect(s[2]).toBeGreaterThan(cardH * 0.15);
      expect(L.slots).toEqual(short.slots);
      expect(L.tray).toEqual(short.tray);
      const first = L.cards.find((c) => c.card.id === game.players[0]!.work[1]![0]!.id)!;
      const gridBottom = Math.max(...L.slots.map((r) => r.y + r.h));
      expect(first.y).toBeLessThan(L.me!.nertz.y - cardH * 0.5); // it starts well above the row...
      expect(first.y).toBeGreaterThan(gridBottom + 10); // ...and stops short of the slots,
      for (const hit of L.slotHit) expect(overlap(hit, L.me!.workHit[1]!)).toBe(false); // as do the drop areas
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
      for (const hit of L.slotHit) expect(overlap(hit, L.me!.workHit[1]!)).toBe(false);
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
        for (const o of L.opponents) expect(overlap(pill, { ...o.box, y: o.box.y - 28, h: o.box.h + 28 })).toBe(false);
        expect(pill.y + pill.h).toBeLessThan(L.me!.box.y); // still the top of the table, never down in your own hand
        if (n === 2) expect(pill.y).toBe(12); // one opponent sits in the middle of the top edge: the corner is free
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
