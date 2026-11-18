// What stands round the cards (layout.ts, `corners` and `furnish`) has a place of its own in every window: the
// buttons in the corners, the round's clock, your own line, "I'm stuck" and the vote, your cards, the tray.
import { describe, expect, it } from 'vitest';
import { inPlay, lcg, seats } from '../shared/testkit';
import type { Card, GameState } from '../shared/types';
import { CARD_H, CARD_W } from './cards/Face';
import { computeLayout, countBox, nameWidth, type ChatButton, type Fittings, type Insets, type Layout, type Rect } from './layout';

/** Phones upright and on their sides, small and low desktop windows, and the usual ones. */
const WINDOWS: [number, number][] = [
  [320, 568],
  [360, 640],
  [390, 844],
  [402, 359],
  [480, 320],
  [568, 320],
  [640, 360],
  [667, 375],
  [736, 414],
  [844, 390],
  [640, 500],
  [800, 520],
  [800, 600],
  [1024, 520],
  [1280, 600],
  [1366, 625],
  [1280, 800],
  [1024, 768],
  [1920, 1080],
];
const PLAYERS = [2, 3, 4, 5, 6, 7, 8];
/** No notch; or the notch and the bar of a phone, at the sides and the bottom when it is on its side, at the bottom when it is upright. */
const insetsOf = (W: number, H: number): Insets[] => [{ l: 0, r: 0, b: 0 }, W > H ? { l: 47, r: 47, b: 21 } : { l: 0, r: 0, b: 34 }];
const CHATS: Record<'out' | 'voice' | 'watched, muted', ChatButton[]> = { out: ['text', 'icon'], voice: ['text', 'count', 'mute'], 'watched, muted': ['text', 'count2', 'mute', 'badge', 'count2'] };

/** A round in play in which every one of your work piles is a long run: `long` cards more than it was dealt. */
function longPiles(n: number, long: number): GameState {
  const game = inPlay(seats(n), lcg(n));
  const players = game.players.map((p) =>
    p.seat !== 0 ? p : { ...p, work: p.work.map((w, i) => ({ ...w, cards: [...w.cards, ...Array.from({ length: long }, (_, j): Card => ({ id: `long${i}.${j}`, owner: 0, suit: j % 2 ? 'H' : 'S', rank: 12 - j }))] })) },
  );
  return { ...game, players };
}

const meets = (a: Rect, b: Rect) => a.x < b.x + b.w - 0.01 && b.x < a.x + a.w - 0.01 && a.y < b.y + b.h - 0.01 && b.y < a.y + a.h - 0.01;

/** Everything that has a place of its own, by name. Your cards are one thing: they lie on each other. */
function things(L: Layout, W: number, H: number, vote: boolean): Record<string, Rect[]> {
  const me = L.me!;
  return {
    chat: [L.at.chat],
    knobs: [L.at.knobs],
    clock: L.clock ? [L.clock] : [],
    name: L.name ? [L.name] : [],
    count: [countBox(me.count, W, H, L.keep)],
    stuck: [L.stuck!],
    vote: vote ? [L.vote!] : [],
    cards: [...L.cards.filter((c) => c.mine).map((c) => ({ x: c.x, y: c.y, w: c.s * CARD_W, h: c.s * CARD_H })), me.nertz, ...me.workAt, me.stockPad, me.waste],
    tray: [{ x: L.tray.x, y: L.tray.y, w: W - L.tray.x, h: L.tray.h }],
  };
}

/** What is wrong in a layout: two things that meet, or one that is not wholly in the window (the buttons and words: nor under a notch). */
function wrong(L: Layout, W: number, H: number, keep: Insets, vote: boolean): string[] {
  const all = things(L, W, H, vote);
  const names = Object.keys(all);
  const out: string[] = [];
  names.forEach((a, i) =>
    names.slice(i + 1).forEach((b) => {
      if (a === 'count' && b === 'cards') return; // (the count lies on the pile it counts)
      if (all[a]!.some((p) => all[b]!.some((q) => meets(p, q)))) out.push(`${a} on ${b}`);
    }),
  );
  for (const name of names) {
    const loose = name === 'cards' || name === 'tray'; // (the tray runs off the right edge: that is where it is)
    const [l, r, bottom] = loose ? [0, W, H] : [keep.l, W - keep.r, H - keep.b];
    if (all[name]!.some((p) => p.x < l - 0.01 || p.y < -0.01 || (name !== 'tray' && p.x + p.w > r + 0.01) || p.y + p.h > bottom + 0.01)) out.push(`${name} off the window`);
  }
  return out;
}

describe('what stands round the cards', () => {
  it('is all in the window and no two things of it meet, in every window, for two to eight players', () => {
    const bad: string[] = [];
    for (const [W, H] of WINDOWS) {
      for (const n of PLAYERS) {
        const game = longPiles(n, 8);
        for (const keep of insetsOf(W, H)) {
          for (const [said, chat] of Object.entries(CHATS)) {
            for (const vote of [false, true]) {
              const fit: Fittings = { chat, clock: true, seats: n, vote, name: nameWidth('Brian', '120') };
              const L = computeLayout(W, H, game, 0, 'live', null, undefined, keep, [], fit);
              const found = wrong(L, W, H, keep, vote);
              if (found.length) bad.push(`${W}x${H}, ${n} players${keep.l || keep.b ? ', notched' : ''}, ${said}${vote ? ', vote' : ''}: ${found.join('; ')}`);
            }
          }
        }
      }
    }
    expect(bad).toEqual([]);
  });
});
