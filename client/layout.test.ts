import { describe, expect, it } from 'vitest';
import { applyIntent, canDrop, checkInvariants, deal as dealRound, DEAL_MS, finishDeal, isHidden, NERTZ_SIZE, openPlay, startCountdown, viewFor } from '../shared/engine';
import { CARD_RATIO, cardSize, feltHw, offFelt, openPlace, pileGap, roomAt, TABLE, tiltAt, type Spot } from '../shared/table';
import type { AnyCard, Card, CentrePile, GameState } from '../shared/types';
import { LABEL, planFinale, restAt, TILT } from './Finale';
import { aloftAt, computeLayout, COUNTDOWN, countdownTop, DEAL, dealWait, dropTarget, fanOut, inside, isTall, keepOut, landingAt, seatDir, TAG_H, toScreen, toTable, type Layout, type Rect } from './layout';
import { CARD_H, CARD_W } from './cards/Face';

/** A round in play: dealt, and the deal over. (The deal itself has its own tests.) */
const deal = (seats: readonly number[], rng: () => number): GameState => openPlay(startCountdown(finishDeal(dealRound(seats, rng))));

/** The same round with a full middle: every Ace in it started as a pile, each wherever there is room, the middle first. */
function aced(game: GameState): GameState {
  const n = game.players.length;
  const aces: Card[] = [];
  const players = game.players.map((p) => {
    const ace = (c: AnyCard) => !isHidden(c) && c.rank === 1;
    aces.push(...([...p.nertz, ...p.work.flat(), ...p.waste, ...p.stock].filter(ace) as Card[]));
    // (Whatever lay where an Ace was gets a card off the stock in its place.)
    const stock = p.stock.filter((c) => !ace(c));
    const swap = (c: AnyCard) => (ace(c) ? stock.pop()! : c);
    return { ...p, nertz: p.nertz.map(swap), work: p.work.map((w) => w.map(swap)), waste: p.waste.map(swap), stock };
  });
  const placed: Spot[] = [];
  const slots = aces.map((c): CentrePile => {
    const at = openPlace(placed, n)!;
    placed.push({ ...at, r: tiltAt(at) });
    return { cards: [c], at: placed.at(-1)! };
  });
  return { ...game, players, slots };
}

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
const grow = (r: Rect, m: number): Rect => ({ x: r.x - m, y: r.y - m, w: r.w + 2 * m, h: r.h + 2 * m });
const slotsOf = (L: Layout) => L.slots.filter((r) => r !== null);
/** An opponent's hand with the name line above it. */
const tagged = (o: { box: Rect }): Rect => ({ ...o.box, y: o.box.y - TAG_H, h: o.box.h + TAG_H });
/** Is any point of the rectangle on the felt as drawn? (Nearer than the corner radius to the felt's inner box.) */
/** How many are at the table a layout was made for. */
const nOf = (L: Layout): number => L.opponents.length + (L.me ? 1 : 0);
const hwOf = (L: Layout): number => feltHw(nOf(L));
const onFelt = (L: Layout, r: Rect): boolean => {
  const [a, b] = [toTable(L.felt, r.x, r.y), toTable(L.felt, r.x + r.w, r.y + r.h)];
  const apart = (lo: number, hi: number, half: number) => Math.max(0, lo - half, -half - hi);
  return Math.hypot(apart(a.x, b.x, hwOf(L) - TABLE.corner), apart(a.y, b.y, 1 - TABLE.corner)) < TABLE.corner;
};
const cornersOf = (r: Rect) => [[r.x, r.y], [r.x + r.w, r.y], [r.x, r.y + r.h], [r.x + r.w, r.y + r.h]] as const;
/** The windows the table is checked in for the size of its cards. */
const DESKTOPS: [number, number][] = [
  [1280, 720],
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
    slots: game.slots.map((s, i) => (i === 1 ? { cards: [hearts[0]!, ...hearts.slice(1)], at: { x: 0, y: 0, r: 0 } } : s)),
    players: game.players.map((p) => {
      const rest = hand(p).filter((c) => !out(c));
      return { ...p, nertz: rest.slice(0, 3), work: [[rest[3]!], [rest[4]!], [rest[5]!], [rest[6]!]], down: [0, 0, 0, 0], stock: rest.slice(7) };
    }),
  };
}

describe('table layout', () => {
  it('seats 2 to 6 players around the felt with nothing overlapping anything, from every chair', () => {
    for (const [W, H] of WINDOWS) {
      for (let n = 2; n <= 6; n++) {
        const game = aced(deal(seats(n), rng(n)));
        expect(checkInvariants(game)).toBeNull();
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
          // The felt is in the middle of the window, on screen, above your hand, and no hand, tray or corner reaches onto it.
          expect(L.felt.cx, at).toBeCloseTo(W / 2);
          expect(L.middle, at).toEqual({ x: L.felt.cx - hwOf(L) * L.felt.u, y: L.felt.cy - L.felt.u, w: 2 * hwOf(L) * L.felt.u, h: 2 * L.felt.u });
          expect(L.middle.x, at).toBeGreaterThan(0);
          expect(L.middle.y, at).toBeGreaterThan(0);
          expect(L.middle.x + L.middle.w, at).toBeLessThan(W);
          expect(L.middle.y + L.middle.h, at).toBeLessThan(me.y);
          for (const r of things) expect(onFelt(L, r), at).toBe(false);
          // A full middle: 4 piles per player, each wholly on the felt, no two touching, none small.
          const piles = slotsOf(L);
          expect(piles, at).toHaveLength(4 * n);
          for (const [i, a] of piles.entries()) {
            expect(a.w, at).toBeGreaterThan(W >= 1280 ? 43 : 31); // (the small laptop: its side hands leave the felt less width)
            expect(a.w, at).toBeCloseTo(cardSize(n).w * L.felt.u);
            expect(a.h / a.w, at).toBeCloseTo(CARD_H / CARD_W);
            for (const [x, y] of cornersOf(a)) expect(offFelt(toTable(L.felt, x, y), nOf(L)), at).toBeLessThanOrEqual(1e-9);
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

  it('cards in the middle are a good size at desktop sizes: 50px and up at 1280x720', () => {
    const sizes: Record<string, number[]> = {};
    for (const [W, H] of DESKTOPS) {
      sizes[`${W}x${H}`] = [2, 3, 4, 5, 6].map((n) => {
        const L = computeLayout(W, H, deal(seats(n), rng(n)), 0);
        // Never larger than your own cards, and not much smaller than half of them even with six at the table.
        expect(L.fs).toBeLessThanOrEqual(L.me!.s);
        expect(L.fs).toBeGreaterThan(L.me!.s * 0.42);
        return Math.round(L.fs * CARD_W * 10) / 10;
      });
    }
    // The widths, in px, for 2, 3, 4, 5 and 6 players. (Before the felt stopped being turned for every seat, 1280x720
    // had 49/37/34/26/28.)
    expect(sizes).toEqual({
      '1280x720': [64.6, 66.8, 59.4, 54.8, 51.3],
      '1440x900': [84.7, 87.5, 77.6, 71.5, 66.9],
      '1920x1080': [104.9, 108.3, 95.9, 88.3, 82.5],
    });
  });

  it('is one felt for everybody, the same way up from every chair: only the seating differs', () => {
    for (const [W, H] of [[1280, 720], [1440, 900], [1920, 1080]] as const) {
      for (let n = 2; n <= 6; n++) {
        const game = aced(deal(seats(n), rng(n)));
        const layouts = seats(n).map((you) => computeLayout(W, H, game, you));
        for (const [you, L] of layouts.entries()) {
          // The same felt in the same place of the window, and every pile at the same place on it, whoever looks.
          expect(L.felt).toEqual(layouts[0]!.felt);
          expect(L.slots).toEqual(layouts[0]!.slots);
          expect(L.fs).toBe(layouts[0]!.fs);
          L.slots.forEach((r, i) => {
            const c = { x: r!.x + r!.w / 2, y: r!.y + r!.h / 2 };
            // Each pile is drawn at its place in table space: so far across and so far down the felt, not turned.
            expect((c.x - L.felt.cx) / L.felt.u).toBeCloseTo(game.slots[i]!.at.x, 6);
            expect((c.y - L.felt.cy) / L.felt.u).toBeCloseTo(game.slots[i]!.at.y, 6);
            const p = toTable(L.felt, c.x, c.y);
            expect(p.x).toBeCloseTo(game.slots[i]!.at.x, 6);
            expect(p.y).toBeCloseTo(game.slots[i]!.at.y, 6);
          });
          // You are at the bottom: your hand lies straight below the felt.
          expect(L.me!.seat).toBe(you);
          expect(L.me!.box.y).toBeGreaterThan(L.middle.y + L.middle.h);
          expect(L.me!.box.x + L.me!.box.w / 2).toBeCloseTo(W / 2);
          // Everyone else in seat order, clockwise from your left: where the kth chair round a table from yours is.
          expect(L.opponents.map((o) => o.seat)).toEqual(seats(n - 1).map((k) => (you + 1 + k) % n));
          L.opponents.forEach((o, k) => {
            const dir = seatDir(k + 1, n);
            const from = { x: o.box.x + o.box.w / 2 - L.felt.cx, y: o.box.y + o.box.h / 2 - L.felt.cy };
            if (Math.abs(dir.x) > 0.3) expect(Math.sign(from.x)).toBe(Math.sign(dir.x));
            if (dir.y < -0.4) expect(o.box.y + o.box.h).toBeLessThan(L.middle.y); // across: along the top edge
            else expect(Math.abs(from.x)).toBeGreaterThan(hwOf(L) * L.felt.u); // a neighbour: beside the felt
          });
        }
        // The hands are where they are for the chair, not for the player: every chair sees the same arrangement of
        // hands, with different people in them.
        for (const L of layouts) expect(L.opponents.map((o) => [o.box.x, o.box.y, o.flip])).toEqual(layouts[0]!.opponents.map((o) => [o.box.x, o.box.y, o.flip]));
        if (n % 2 === 0) {
          // The player opposite is at the top of my screen and I am at the top of theirs; the piles are where they are for both.
          const [mine, theirs] = [layouts[0]!, layouts[n / 2]!];
          expect(mine.opponents.find((o) => o.seat === n / 2)!.box.y).toBeLessThan(mine.middle.y);
          expect(theirs.opponents.find((o) => o.seat === 0)!.box.y).toBeLessThan(theirs.middle.y);
        }
      }
    }
    expect(seatDir(0, 4)).toEqual({ x: -0, y: 1 }); // your own chair: straight down
    for (const [k, n, x, y] of [[1, 4, -1, 0], [2, 4, 0, -1], [3, 4, 1, 0], [1, 2, 0, -1], [1, 6, -Math.sin(Math.PI / 3), 0.5]] as const) {
      expect(seatDir(k, n).x).toBeCloseTo(x);
      expect(seatDir(k, n).y).toBeCloseTo(y);
    }
  });

  it('draws the hand of a player across the table the other way round, and a neighbour\'s the same way as yours', () => {
    for (let n = 2; n <= 6; n++) {
      const L = computeLayout(1280, 720, deal(seats(n), rng(n)), 0);
      expect(L.me!.flip).toBe(false);
      expect(L.me!.nertz.x).toBeLessThan(L.me!.stock.x);
      for (const o of L.opponents) {
        const across = o.box.y + o.box.h < L.middle.y; // along the top edge
        expect(o.flip).toBe(across);
        if (o.turn) {
          // A neighbour's hand runs down the side, facing the felt: their left is up on your left, down on your right.
          expect(across).toBe(false);
          expect(o.turn).toBe(o.box.x < L.middle.x ? 90 : -90);
          expect(o.nertz.y < o.stock.y).toBe(o.turn === 90);
        } else {
          // Their left is your right: the nertz pile, leftmost for its owner, is at the right-hand end.
          expect(o.nertz.x < o.stock.x).toBe(!across);
        }
        for (const r of [o.nertz, o.stock, o.waste, ...o.work]) {
          // Each pile's middle is within the hand's box.
          expect(inside(grow(o.box, 0.01), r.x + r.w / 2, r.y + r.h / 2)).toBe(true);
        }
      }
    }
  });

  it('someone who is not in the round watches from the first player\'s chair, with that player\'s hand small at the bottom', () => {
    for (let n = 2; n <= 6; n++) {
      const L = computeLayout(1280, 720, aced(deal(seats(n), rng(n))), 99);
      expect(L.me).toBeNull();
      expect(L.opponents).toHaveLength(n);
      const hands = L.opponents.map(tagged);
      for (const [i, a] of hands.entries()) {
        expect(onFelt(L, a)).toBe(false);
        expect(a.y + a.h).toBeLessThanOrEqual(720);
        for (const b of hands.slice(i + 1)) expect(overlap(a, b)).toBe(false);
      }
      expect(L.opponents[0]!.box.y).toBeGreaterThan(L.middle.y + L.middle.h);
      expect(slotsOf(L)).toHaveLength(4 * n);
    }
  });

  it('maps table space to the screen and back exactly, on the felt and off it, the same from every chair', () => {
    const game = deal(seats(5), rng(5));
    const L = computeLayout(1280, 720, game, 3);
    for (const p of [{ x: 0, y: 0 }, { x: 0.3, y: -0.8 }, { x: -hwOf(L), y: 0 }, { x: 4.5, y: 1.7 }]) {
      const s = toScreen(L.felt, p);
      const back = toTable(L.felt, s.x, s.y);
      expect(back.x).toBeCloseTo(p.x, 9);
      expect(back.y).toBeCloseTo(p.y, 9);
      // The same point of the table is the same point of the window for every player (in windows of one size).
      for (let you = 0; you < 5; you++) expect(toScreen(computeLayout(1280, 720, game, you).felt, p)).toEqual(s);
    }
    // The centre of the table is the centre of the felt; one unit is the same distance across and down; the felt's
    // box is its box as drawn.
    expect(toScreen(L.felt, { x: 0, y: 0 })).toEqual({ x: L.felt.cx, y: L.felt.cy });
    expect(toScreen(L.felt, { x: 1, y: 1 })).toEqual({ x: L.felt.cx + L.felt.u, y: L.felt.cy + L.felt.u });
    expect(toScreen(L.felt, { x: -hwOf(L), y: -1 })).toEqual({ x: L.middle.x, y: L.middle.y });
    // In a larger window the felt is larger and somewhere else, and the same point of the table is still the same
    // share of the way across and down it.
    const big = computeLayout(1920, 1080, game, 0);
    expect(big.felt.u).toBeGreaterThan(L.felt.u);
    for (const p of [{ x: 1.3, y: -0.4 }, { x: -2, y: 0.7 }]) {
      const [a, b] = [toScreen(L.felt, p), toScreen(big.felt, p)];
      expect((a.x - L.middle.x) / L.middle.w).toBeCloseTo((b.x - big.middle.x) / big.middle.w, 9);
      expect((a.y - L.middle.y) / L.middle.h).toBeCloseTo((b.y - big.middle.y) / big.middle.h, 9);
    }
  });

  it('draws a pile exactly where it was put down and nothing where there is none', () => {
    const game = deal(seats(4), rng(4));
    const ace = (owner: number): Card => ({ id: `ace${owner}`, owner, suit: 'S', rank: 1 });
    const placed: GameState = { ...game, slots: game.slots.map((s, i) => (i === 2 ? { cards: [ace(0)], at: { x: 1.25, y: -0.4, r: 1.5 } } : s)) };
    const L = computeLayout(1280, 720, placed, 1);
    expect(L.slots.map((r) => r !== null)).toEqual(seats(16).map((i) => i === 2));
    const r = L.slots[2]!;
    const p = toTable(L.felt, r.x + r.w / 2, r.y + r.h / 2);
    expect([p.x, p.y]).toEqual([expect.closeTo(1.25, 6), expect.closeTo(-0.4, 6)]);
    expect(r.rot).toBe(1.5);
    const card = L.cards.find((c) => c.card.id === 'ace0')!;
    expect([card.x, card.y, card.rot, card.pile, card.at]).toEqual([r.x, r.y, 1.5, 'slot', 2]);
    // Everyone has it at that very place.
    for (let you = 0; you < 4; you++) expect(computeLayout(1280, 720, placed, you).slots[2]).toEqual(r);
    // What is drawn is what the rules go by: the card's rectangle on screen is its footprint in table space, and
    // the room a pile keeps round it is the same number of px all round.
    const size = cardSize(4);
    expect(r.w / L.felt.u).toBeCloseTo(size.w, 9);
    expect(r.h / L.felt.u).toBeCloseTo(size.h, 9);
    expect(pileGap(4) * L.felt.u).toBeGreaterThan(4);
    expect(pileGap(4) * L.felt.u).toBeLessThan(r.w * 0.2);
  });

  it('the picture is the rule: an Ace has room exactly where its outline is clear of every drawn keep-out and inside the drawn felt, on every screen', () => {
    // What Table.tsx draws while an Ace is in hand (`landingAt`, `keepOut`, the felt with its rounded corners) held
    // against what the engine accepts (`canDrop` on a point of the felt), in px, for every table size and window.
    // Random places, and places on purpose just either side of every line.
    const next = rng(77);
    let [yes, no, close] = [0, 0, 0];
    for (let n = 2; n <= 6; n++) {
      const { w, h } = cardSize(n);
      const gap = pileGap(n);
      for (const [W, H] of WINDOWS) {
        // A table with a good few piles on it, put down wherever the engine lets them go.
        let game = deal(seats(n), rng(n * 100 + W));
        const ace = (i: number): Card => ({ id: `pile${i}`, owner: i % n, suit: 'S', rank: 1 });
        const at: { x: number; y: number }[] = [];
        for (let tries = 0; at.length < 3 * n && tries < 2000; tries++) {
          const near = at.length > 0 && next() < 0.5 ? at[Math.floor(next() * at.length)]! : null;
          const p = near
            ? { x: near.x + (next() < 0.5 ? -1 : 1) * (w + gap + next() * 0.02), y: near.y + (next() - 0.5) * h }
            : { x: (next() * 2 - 1) * feltHw(n), y: next() * 2 - 1 };
          const q = { x: Math.round(p.x * 1000) / 1000, y: Math.round(p.y * 1000) / 1000 };
          if (roomAt(q, at, n)) at.push(q);
        }
        expect(at.length).toBeGreaterThanOrEqual(2 * n);
        game = { ...game, slots: game.slots.map((_, i) => (at[i] ? { cards: [ace(i)], at: { ...at[i]!, r: tiltAt(at[i]!) } } : null)) };
        // Seat 0 has an Ace on top of a work pile.
        const mine: Card = { id: 'mine', owner: 0, suit: 'H', rank: 1 };
        game = { ...game, players: game.players.map((p, i) => (i === 0 ? { ...p, work: [[...p.work[0]!, mine], ...p.work.slice(1)] } : p)) };
        const u0 = computeLayout(W, H, game, 0).felt.u;
        const eps = 0.75 / u0; // three quarters of a px either side of a line
        const points: { x: number; y: number }[] = [];
        for (const q of at) {
          for (const sx of [-1, 1]) for (const e of [-eps, eps]) points.push({ x: q.x + sx * (w + gap + e), y: q.y + (next() - 0.5) * 1.8 * h }, { x: q.x + (next() - 0.5) * 1.8 * w, y: q.y + sx * (h + gap + e) });
        }
        for (let i = 0; i < 60; i++) {
          const e = next() < 0.5 ? -eps : eps;
          points.push({ x: (next() < 0.5 ? -1 : 1) * (feltHw(n) - w / 2 + e), y: (next() * 2 - 1) * (1 - TABLE.corner) }, { x: (next() * 2 - 1) * (feltHw(n) - TABLE.corner), y: (next() < 0.5 ? -1 : 1) * (1 - h / 2 + e) });
          points.push({ x: (next() * 2 - 1) * feltHw(n), y: next() * 2 - 1 });
        }
        for (let you = 0; you < n; you += Math.max(1, n - 1)) {
          const L = computeLayout(W, H, game, you);
          const keep = L.slots.flatMap((r) => (r ? [keepOut(L, r, n)] : []));
          const r = L.felt.u * TABLE.corner;
          /** How far outside the felt as drawn (a box with corners of radius r) a point of the screen is, in px. */
          const outside = (x: number, y: number) => {
            const dx = Math.abs(x - L.felt.cx) - (L.middle.w / 2 - r);
            const dy = Math.abs(y - L.felt.cy) - (L.middle.h / 2 - r);
            return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0) - r;
          };
          for (const p of points) {
            // As Table.tsx does it: the outline about the card's centre on screen, the place sent to the thousandth.
            const centre = toScreen(L.felt, p);
            const there = toTable(L.felt, centre.x, centre.y);
            const to = { k: 'felt' as const, x: Math.round(there.x * 1000) / 1000, y: Math.round(there.y * 1000) / 1000 };
            const box = landingAt(L, centre);
            // How deep the outline is into the nearest keep-out, and how far its worst corner is off the felt (px; negative: clear).
            const into = Math.max(-Infinity, ...keep.map((k) => Math.min(Math.min(box.x + box.w, k.x + k.w) - Math.max(box.x, k.x), Math.min(box.y + box.h, k.y + k.h) - Math.max(box.y, k.y))));
            const off = Math.max(...cornersOf(box).map(([x, y]) => outside(x, y)));
            const worst = Math.max(into, off);
            const ok = canDrop(game, 0, 'mine', to);
            // (Within a tenth of a px of a line the thousandth the place is sent to can tip it either way.)
            if (Math.abs(worst) < 0.1) continue;
            if (Math.abs(worst) < 1) close++;
            expect([n, W, H, you, to.x, to.y, ok]).toEqual([n, W, H, you, to.x, to.y, worst < 0]);
            ok ? yes++ : no++;
          }
        }
      }
    }
    // It was a real test: plenty of places either way, many of them within a px of a line.
    expect(yes).toBeGreaterThan(1500);
    expect(no).toBeGreaterThan(1500);
    expect(close).toBeGreaterThan(1500);
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
            expect(w).toBeGreaterThanOrEqual(slotsOf(L)[0]!.w - 1e-9); // never smaller than in the middle
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
        const L = computeLayout(W, H, aced(deal(seats(n), rng(n))), 0);
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

  it('cascades tray piles so that a strip of each shows, face-down, and brings them out for the end of the round', () => {
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
    // A finished pile lies face-down in the tray from the moment it is put aside.
    expect([...live.cards, ...flip.cards].filter((c) => c.pile === 'tray').every((c) => !c.up)).toBe(true);
    // The centre piles are spread out first (on the finale's canvas); the tray's piles are still in the tray.
    const spread = computeLayout(1280, 800, game, 0, 'spread');
    expect(spread.cards.some((c) => c.pile === 'slot')).toBe(false);
    expect(spread.cards.filter((c) => c.pile === 'tray').every((c) => inside(spread.tray, c.x + 1, c.y + 1))).toBe(true);
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
    for (const [i, a] of plan.piles.entries()) for (const b of plan.piles.slice(i + 1)) expect(overlap(a, b)).toBe(false);
  });

  it('gathers each pile out in front of its player, on the felt and clear of the wash, with a label that touches nothing else: 2 to 6 players, every chair', () => {
    for (const [W, H] of [[1280, 720], [1440, 900]] as const) {
      for (let n = 2; n <= 6; n++) {
        const game = played(deal(seats(n), rng(n)));
        for (let you = 0; you < n; you++) {
          const L = computeLayout(W, H, game, you, 'wash');
          const plan = planFinale(L, game);
          const where = `${n} players at ${W}x${H}, seat ${you}`;
          const d = { cx: L.felt.cx, cy: L.felt.cy, rx: hwOf(L) * L.felt.u, ry: L.felt.u };
          expect(plan.piles.map((p) => p.seat), where).toEqual(game.players.map((p) => p.seat));
          const hands = [...L.opponents.map(tagged), { ...L.me!.box, h: H - L.me!.box.y }];
          for (const [i, pile] of plan.piles.entries()) {
            const at = `${where}, pile of seat ${pile.seat}`;
            // On the felt, every corner of it.
            for (const [x, y] of cornersOf(pile)) expect(offFelt(toTable(L.felt, x, y), nOf(L)), at).toBeLessThan(0);
            // Out towards its own player's chair as this window seats them: the way from the middle of the felt
            // to the pile is the way to that chair, as far out as the felt goes, so nearer to them than to anyone else.
            const v = seatDir((i - you + n) % n, n);
            const out = { x: (pile.x + pile.w / 2 - d.cx) / d.rx, y: (pile.y + pile.h / 2 - d.cy) / d.ry };
            expect(Math.hypot(out.x, out.y), at).toBeGreaterThan(0.45);
            expect((out.x * v.x + out.y * v.y) / Math.hypot(out.x, out.y), at).toBeGreaterThan(0.999);
            // A little further out that way and it would hang over the edge.
            const far = Math.hypot(out.x * d.rx, out.y * d.ry) / 16;
            const on = { x: (out.x * d.rx) / far, y: (out.y * d.ry) / far };
            expect(cornersOf({ ...pile, x: pile.x + on.x, y: pile.y + on.y }).some(([x, y]) => offFelt(toTable(L.felt, x, y), nOf(L)) > 0), at).toBe(true);
            const hand = pile.seat === you ? L.me! : L.opponents.find((o) => o.seat === pile.seat)!;
            const gap = (r: Rect) => Math.hypot(Math.max(r.x - (pile.x + pile.w / 2), 0, pile.x + pile.w / 2 - (r.x + r.w)), Math.max(r.y - (pile.y + pile.h / 2), 0, pile.y + pile.h / 2 - (r.y + r.h)));
            // (Your own hand runs the whole width of the window under the felt, so it is near every pile low on the
            // felt: a neighbour's pile is compared with the other opponents' hands only.)
            for (const other of pile.seat === you ? L.opponents : L.opponents.filter((o) => o !== hand)) expect(gap(hand.box), `${at} vs the hand of seat ${other.seat}`).toBeLessThan(gap(other.box));
            // Clear of the wash once it has been drawn in, and of every other pile.
            expect(overlap(pile, plan.heap), at).toBe(false);
            for (const other of plan.piles.slice(i + 1)) expect(overlap(pile, other), at).toBe(false);
            // Its label: the right size, right beside it, inside the window, and over nothing: no hand (the
            // NERTZ! stamp lies across a hand), no name, not the tray, not the wash, no pile, no other label.
            const label = pile.label;
            expect([label.w, label.h], at).toEqual([LABEL.w, LABEL.h]);
            expect(gap(label), at).toBeLessThan(Math.hypot(pile.w, pile.h) / 2 + 8 + pile.h * 0.2); // (beside the pile as drawn: it leans up and to the left)
            expect(label.x >= 0 && label.y >= 0 && label.x + label.w <= W && label.y + label.h <= H, at).toBe(true);
            for (const hand of hands) expect(overlap(label, hand), `${at}: label over a hand`).toBe(false);
            expect(overlap(label, L.tray), `${at}: label over the tray`).toBe(false);
            expect(overlap(label, plan.heap), `${at}: label over the wash`).toBe(false);
            for (const other of plan.piles) expect(overlap(label, other), `${at}: label over the pile of seat ${other.seat}`).toBe(false);
            // ...and no pile as it is DRAWN: a pile leans up and to the left as it grows, and its cards lie a little
            // askew. Regression: labels kept off the bare rectangle only, and one to the left of a tall pile (or
            // above it) had the ends of its lines under the cards. Every card of a pile of 5 and of 45, turned
            // as far as a card is turned either way.
            for (const other of plan.piles) {
              for (const of of [5, 45]) {
                for (let k = 0; k < of; k++) {
                  const c = restAt(other, k, of);
                  const [cos, sin] = [Math.cos(TILT / 2), Math.sin(TILT / 2)];
                  const hw = (other.w * cos + other.h * sin) / 2;
                  const hh = (other.h * cos + other.w * sin) / 2;
                  expect(overlap(label, { x: c.x - hw, y: c.y - hh, w: 2 * hw, h: 2 * hh }), `${at}: label under card ${k} of ${of} of the pile of seat ${other.seat}`).toBe(false);
                }
              }
            }
            for (const other of plan.piles.slice(i + 1)) expect(overlap(label, other.label), `${at}: label over the label of seat ${other.seat}`).toBe(false);
          }
          // The wash itself stays on the felt.
          expect(plan.rx + plan.w / 2, where).toBeLessThanOrEqual(d.rx);
          expect(plan.ry + plan.h / 2, where).toBeLessThanOrEqual(d.ry);
          expect(plan.heap.y >= d.cy - d.ry && plan.heap.y + plan.heap.h <= d.cy + d.ry, where).toBe(true);
        }
      }
    }
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
      const g = aced(deal(seats(n), rng(n)));
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
    it('rises into what cloth there is between its column and the felt, never onto the felt, without moving anything else', () => {
      const [W, H] = [1440, 900];
      const short = computeLayout(W, H, aced(deal(seats(2), rng(2))), 0);
      const game = longPile(2, 1, 7);
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
      expect(first.y).toBeGreaterThan(L.middle.y + L.middle.h); // ...and stops short of the felt,
      for (const hit of L.slotHit) expect(overlap(hit!, L.me!.workHit[1]!)).toBe(false); // as do the drop areas
      expect(L.me!.work[1]!.y + cardH).toBeLessThanOrEqual(H); // the top card is whole
      expect(inside(L.me!.workHit[1]!, first.x + 5, first.y + 5)).toBe(true); // the whole column takes a drop
      // The other piles and the rest of the hand stay exactly where they were.
      expect([L.me!.nertz, L.me!.stock, L.me!.work[0], L.me!.work[2]]).toEqual([short.me!.nertz, short.me!.stock, short.me!.work[0], short.me!.work[2]]);
      // A pile of ordinary length is not lifted at all.
      const usual = longPile(2, 1, 3);
      expect(computeLayout(W, H, usual, 0).cards.find((c) => c.card.id === usual.players[0]!.work[1]![0]!.id)!.y).toBe(L.me!.nertz.y);
    });

    it('in a low window (1280x720), where there is hardly any felt to rise into, the newest cards keep their whole rank', () => {
      const game = longPile(2, 1, 7);
      const L = computeLayout(1280, 720, game, 0);
      const cardH = L.me!.nertz.h;
      const s = strips(L, game);
      expect(s.slice(-3).every((step) => step >= cardH * 0.21 - 0.01)).toBe(true); // it used to be 17px (0.13) for every card
      expect(s.every((step) => step > 4)).toBe(true);
      expect(L.me!.work[1]!.y + cardH).toBeLessThanOrEqual(720);
      // Four face-up cards on one face-down card are all still readable.
      const seven = longPile(2, 1, 4);
      expect(strips(computeLayout(1280, 720, seven, 0), seven).slice(1).every((step) => step >= cardH * 0.21 - 0.01)).toBe(true);
    });

    it('a pile looked at fans out in full above everything in the middle; its drop area, its top card and the rest of the hand stay put', () => {
      for (const [W, H] of [[1280, 720], [1920, 1080]] as const) {
        const game = longPile(6, 2, 10);
        const L = computeLayout(W, H, game, 0);
        const P = computeLayout(W, H, game, 0, 'live', 1);
        const cardH = P.me!.nertz.h;
        expect(strips(L, game).some((step) => step < cardH * 0.21 - 0.01)).toBe(true); // squeezed...
        const full = strips(P, game);
        expect(full.slice(2).every((step) => step >= cardH * 0.29)).toBe(true); // ...and in full when looked at (after its two face-down cards)
        expect(full.slice(0, 2).every((step) => step >= cardH * 0.13)).toBe(true);
        const ids = new Set(game.players[0]!.work[1]!.map((c) => c.id));
        const zs = P.cards.filter((c) => ids.has(c.card.id)).map((c) => c.z);
        expect(Math.min(...zs)).toBeGreaterThan(Math.max(...P.cards.filter((c) => !ids.has(c.card.id)).map((c) => c.z), 0)); // and above the rest of your hand
        expect(Math.min(...P.cards.filter((c) => ids.has(c.card.id)).map((c) => c.y))).toBeGreaterThanOrEqual(8);
        expect(P.me!.workHit).toEqual(L.me!.workHit);
        expect(P.me!.work).toEqual(L.me!.work);
        expect(P.cards.filter((c) => !ids.has(c.card.id))).toEqual(L.cards.filter((c) => !ids.has(c.card.id)));
      }
    });

    it('with no felt to spare (six players) keeps the newest cards readable and lets only the oldest give way', () => {
      const game = longPile(6, 1, 7);
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
        expect(onFelt(L, pill)).toBe(false);
      }
    }
    expect(CARD_H / CARD_W).toBeCloseTo(1.4);
  });
});

describe("another player's card in the air", () => {
  /**
   * Seat `k` carries the top of their nertz pile in a straight line to the point `P` of the felt, on their own screen;
   * returns where seat 0's window draws it on the way. With `pile` there is a pile at `P` that takes the card: it
   * reports how far it has come. Without, it is an Ace over bare felt: it gets there, and is then held still.
   */
  function seen(n: number, k: number, W: number, H: number, P: { x: number; y: number }, pile: boolean) {
    const game = deal(seats(n), rng(n));
    const [mine, theirs] = [computeLayout(W, H, game, 0), computeLayout(W, H, game, k)];
    // On their screen: their own hand at the bottom.
    const own = theirs.me!;
    const from = { x: own.nertz.x + own.nertz.w / 2, y: own.nertz.y + own.nertz.h / 2 };
    const to = toScreen(theirs.felt, P);
    // On mine: their hand where I see them sit.
    const hand = mine.opponents.find((o) => o.seat === k)!;
    const home = { x: hand.nertz.x + hand.nertz.w / 2, y: hand.nertz.y + hand.nertz.h / 2 };
    const report = (t: number) => {
      const c = { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
      const p = toTable(theirs.felt, c.x, c.y);
      return { h: [(c.x - from.x) / own.nertz.w, (from.y - c.y) / own.nertz.w] as const, p: [p.x, p.y] as const };
    };
    const end = toScreen(mine.felt, P);
    const path = seats(41).map((i) => aloftAt(mine.felt, home, hand.nertz.w, hand, { ...report(i / 40), w: pile ? i / 40 : 0 }, pile ? end : undefined, 0));
    if (!pile) for (let i = 1; i <= 20; i++) path.push(aloftAt(mine.felt, home, hand.nertz.w, hand, { ...report(1), w: 0 }, undefined, i / 20));
    return { path, home, end, felt: mine.felt };
  }
  /** How much longer the path is than the straight line, and how far it ever backs away from where it ends (px). */
  function shape(path: { x: number; y: number }[]) {
    const end = path.at(-1)!;
    let [length, back, nearest] = [0, 0, Math.hypot(path[0]!.x - end.x, path[0]!.y - end.y)];
    for (let i = 1; i < path.length; i++) {
      length += Math.hypot(path[i]!.x - path[i - 1]!.x, path[i]!.y - path[i - 1]!.y);
      const d = Math.hypot(path[i]!.x - end.x, path[i]!.y - end.y);
      back = Math.max(back, d - nearest);
      nearest = Math.min(nearest, d);
    }
    return { ratio: length / Math.max(1, Math.hypot(path[0]!.x - end.x, path[0]!.y - end.y)), back };
  }
  const PLACES = [{ x: 0, y: 0 }, { x: -1.9, y: -0.5 }, { x: 1.9, y: -0.5 }, { x: -1.9, y: 0.5 }, { x: 1.9, y: 0.5 }, { x: 0.4, y: -0.7 }, { x: -0.9, y: 0.7 }];

  it('travels from their hand, wherever this window seats them, to its true place on the felt: no looping, no doubling back, from every seat', () => {
    const worst = { ratio: 0, back: 0 };
    for (const [W, H] of [[1280, 720], [1440, 900]] as const) {
      for (let n = 2; n <= 6; n++) {
        for (let k = 1; k < n; k++) {
          for (const P of PLACES) {
            // A card with a pile to go to (it says how far it has come), and an Ace (nothing is known until it lingers).
            for (const pile of [true, false]) {
              const at = `${pile ? 'a card for a pile' : 'an Ace'}, ${n} players at ${W}x${H}, seat ${k}, to ${P.x},${P.y}`;
              const { path, home, end, felt } = seen(n, k, W, H, P, pile);
              // It starts on its pile in their hand as drawn here, and ends at the very point of the felt.
              expect(path[0], at).toEqual(home);
              expect(path.at(-1)!.x, at).toBeCloseTo(end.x, 6);
              expect(path.at(-1)!.y, at).toBeCloseTo(end.y, 6);
              const { ratio, back } = shape(path);
              worst.ratio = Math.max(worst.ratio, ratio);
              worst.back = Math.max(worst.back, back);
              expect(ratio, at).toBeLessThan(1.4); // not much longer than the straight line
              expect(back, at).toBeLessThan(24); // and never more than half a small card further from its place than it has been
              // On the way it is on screen; and an Ace, until it lingers, is lifted out of the hand towards the felt.
              for (const c of path) expect(c.x > 0 && c.x < W && c.y > 0 && c.y < H, at).toBe(true);
              if (!pile) expect(Math.hypot(path[20]!.x - felt.cx, path[20]!.y - felt.cy), at).toBeLessThan(Math.hypot(home.x - felt.cx, home.y - felt.cy));
            }
          }
        }
      }
    }
    // (Measured over all of these: at worst 1.31 times the straight line, and 21px back, on the way out of the hand.)
    expect(worst.ratio).toBeGreaterThan(1); // (it is a path, not a jump)
  });

  it('a card going from pile to pile within a hand is drawn in that hand as this window draws it, mirrored for a hand across the table', () => {
    for (let n = 2; n <= 6; n++) {
      const game = deal(seats(n), rng(n));
      const mine = computeLayout(1280, 720, game, 0);
      for (let k = 1; k < n; k++) {
        const theirs = computeLayout(1280, 720, game, k);
        const own = theirs.me!;
        const hand = mine.opponents.find((o) => o.seat === k)!;
        // Their nertz card carried onto their third work pile, on their screen.
        const from = { x: own.nertz.x + own.nertz.w / 2, y: own.nertz.y + own.nertz.h / 2 };
        const to = { x: own.work[2]!.x + own.work[2]!.w / 2, y: from.y };
        const p = toTable(theirs.felt, to.x, to.y);
        const home = { x: hand.nertz.x + hand.nertz.w / 2, y: hand.nertz.y + hand.nertz.h / 2 };
        const drawn = aloftAt(mine.felt, home, hand.nertz.w, hand, { h: [(to.x - from.x) / own.nertz.w, 0], p: [p.x, p.y], w: 0 }, undefined, 0);
        // It is over that hand's third work pile here, whichever way round (or turned) the hand is drawn.
        const pile = { x: hand.workAt[2]!.x + hand.workAt[2]!.w / 2, y: hand.workAt[2]!.y + hand.workAt[2]!.h / 2 };
        expect(Math.hypot(drawn.x - pile.x, drawn.y - pile.y)).toBeLessThan(hand.nertz.w * 0.35);
        if (hand.turn) expect(drawn.x).toBeCloseTo(home.x, 6);
        else expect(drawn.y).toBeCloseTo(home.y, 6);
      }
    }
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

describe('a group dealt off the stock', () => {
  const flip = (g: GameState): GameState => {
    const r = applyIntent(g, 0, { k: 'flip' });
    if (!r.ok) throw new Error(r.reason);
    return r.state;
  };
  const at = (L: Layout, id: string) => L.cards.find((c) => c.card.id === id);

  it('is counted off card by card into a fan held over the stock, face-down, and turns over onto the waste when complete', () => {
    const start = deal(seats(2), rng(7));
    const three = start.players[0]!.stock.slice(-3).reverse().map((c) => c.id); // in the order dealt: the stock's top card first
    let g = start;
    for (let k = 1; k <= 2; k++) {
      g = flip(g);
      const L = computeLayout(1280, 720, g, 0);
      const group = three.map((id) => at(L, id)!);
      // Only the cards dealt so far have left the stock, each to its own place in the fan.
      const held = group.slice(0, k);
      expect(held.every((c) => c.pile === 'stock' && !c.up && c.x > L.me!.stock.x && c.x < L.me!.waste.x && c.y < L.me!.stock.y)).toBe(true);
      expect(new Set(held.map((c) => `${c.x},${c.y}`)).size).toBe(k);
      expect(held.every((c, i) => i === 0 || c.z < held[i - 1]!.z)).toBe(true); // each comes up under the one before
      expect(group.slice(k).every((c) => !c || c.x === L.me!.stock.x)).toBe(true); // the rest still lie on the stock (drawn or not)
      expect(L.cards.some((c) => c.pile === 'waste')).toBe(false);
    }
    g = flip(g);
    // The whole group is held a beat, all three off the stock, before it lands.
    const beat = computeLayout(1280, 720, g, 0, 'live', null, true, new Map([[0, 3]]));
    const whole = three.map((id) => at(beat, id)!);
    expect(whole.every((c) => c.pile === 'stock' && !c.up && c.y < beat.me!.stock.y)).toBe(true);
    expect(new Set(whole.map((c) => `${c.x},${c.y}`)).size).toBe(3);
    const L = computeLayout(1280, 720, g, 0);
    const landed = three.map((id) => at(L, id)!);
    expect(landed.every((c) => c.pile === 'waste' && c.x === L.me!.waste.x && c.y === L.me!.waste.y && c.rot === 0)).toBe(true);
    expect(landed[2]!.up).toBe(true);
    expect(landed[2]!.z).toBeGreaterThan(Math.max(landed[0]!.z, landed[1]!.z)); // the last card dealt covers the other two
  });

  it('lies over a pile of the middle that it reaches, as all of your own hand does; everyone else\'s hand lies under the middle', () => {
    const box = (c: Layout['cards'][number]): Rect => ({ x: c.x, y: c.y, w: c.s * CARD_W, h: c.s * CARD_H });
    for (const [W, H] of DESKTOPS) {
      const start = deal(seats(6), rng(6));
      // A pile as near your edge of the felt as the rules allow, straight above your stock.
      const stock = computeLayout(W, H, start, 0).me!.stock;
      const spot = { x: toTable(computeLayout(W, H, start, 0).felt, stock.x + stock.w / 2, 0).x, y: 1 - cardSize(6).h / 2 - 1e-6, r: 0 };
      expect(roomAt(spot, [], 6)).toBe(true);
      const club = (rank: number): Card => ({ id: `club${rank}`, owner: 1, suit: 'C', rank });
      let g: GameState = { ...start, slots: start.slots.map((s, i) => (i === 0 ? { cards: [club(1), club(2)], at: spot } : s)) };
      for (let k = 1; k <= 3; k++) {
        g = flip(g);
        // While it is counted off (the cards that come up under the ones held travel at the level they lie at), and held whole for its beat.
        const L = computeLayout(W, H, g, 0, 'live', null, true, k === 3 ? new Map([[0, 3]]) : undefined);
        const middle = L.cards.filter((c) => c.pile === 'slot');
        const held = L.cards.filter((c) => c.mine && c.pile === 'stock' && c.y < L.me!.stock.y);
        expect(middle.map((c) => c.card.id)).toEqual(['club1', 'club2']);
        expect(held).toHaveLength(k);
        if (k === 3) expect(held.some((c) => overlap(box(c), box(middle[1]!)))).toBe(true); // the whole group reaches onto the felt, and that pile
        expect(Math.min(...L.cards.filter((c) => c.mine).map((c) => c.z))).toBeGreaterThan(Math.max(...middle.map((c) => c.z)));
        expect(Math.max(...L.cards.filter((c) => !c.mine && c.pile !== 'slot' && c.pile !== 'tray').map((c) => c.z))).toBeLessThan(Math.min(...middle.map((c) => c.z)));
      }
    }
  });

  it('keeps the outline under the stock where its bottom card lies, the size of a card', () => {
    const g = deal(seats(2), rng(7));
    const L = computeLayout(1280, 720, g, 0);
    const bottom = at(L, g.players[0]!.stock[0]!.id)!;
    expect(L.me!.stockPad).toMatchObject({ x: bottom.x, y: bottom.y, w: L.me!.stock.w, h: L.me!.stock.h });
  });

  it('is dealt card by card onto the waste on a table that carries each card there', () => {
    const g = flip(deal(seats(2), rng(7)));
    const L = computeLayout(1280, 720, g, 0, 'live', null, false);
    const c = at(L, g.players[0]!.waste.at(-1)!.id)!;
    expect(c.pile === 'waste' && !c.up).toBe(true);
  });
});

describe('a phone held upright', () => {
  const sizes = [
    [360, 640],
    [375, 667],
    [390, 844],
    [430, 932],
  ] as const;
  const apart = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) => a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;

  it('is laid out its own way only when the window is narrow and tall', () => {
    expect(isTall(390, 844)).toBe(true);
    expect(isTall(844, 390)).toBe(false);
    expect(isTall(1280, 720)).toBe(false);
    expect(isTall(700, 1000)).toBe(false);
  });

  it('keeps every hand and the felt on the screen and clear of each other, for two to six players', () => {
    for (const [W, H] of sizes) {
      for (let n = 2; n <= 6; n++) {
        const L = computeLayout(W, H, deal(seats(n), rng(n)), 0);
        const at = `${W}x${H}, ${n} players`;
        expect(L.tall, at).toBe(true);
        const me = L.me!;
        // Your hand: two rows, the work piles over the nertz pile and the stock, all of it on the screen.
        expect(me.workAt.every((r) => r.y < me.nertz.y && r.x >= 0 && r.x + r.w <= W), at).toBe(true);
        expect(me.nertz.x < me.stock.x && me.stock.x < me.waste.x && me.waste.x + me.waste.w <= W && me.nertz.y + me.nertz.h <= H, at).toBe(true);
        expect(me.work.every((r) => r.y + r.h <= me.nertz.y), at).toBe(true); // a dealt pile ends above the second row
        expect(me.nertz.w, at).toBeGreaterThanOrEqual(56); // cards a thumb can take hold of
        // The felt: on the screen, under the others and above your hand.
        expect(L.middle.x >= 0 && L.middle.x + L.middle.w <= W, at).toBe(true);
        expect(L.middle.y + L.middle.h <= me.box.y, at).toBe(true);
        for (const o of L.opponents) {
          const box = { ...o.box, y: o.box.y - TAG_H, h: o.box.h + TAG_H };
          expect(box.x >= 0 && box.x + box.w <= W && box.y >= L.bar, at).toBe(true); // under the bar of buttons
          expect(box.y + box.h <= L.middle.y, at).toBe(true);
          expect(L.opponents.every((p) => p === o || apart(o.box, p.box)), at).toBe(true);
        }
        // Nothing of anyone's is drawn off the sides.
        expect(L.cards.filter((c) => c.pile !== 'tray').every((c) => c.x >= -1 && c.x + c.s * 90 <= W + 1), at).toBe(true);
      }
    }
  });
});
