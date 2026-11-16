// What a press, a move, a release and a tap do (hand.ts), played at a table laid out as the window lays it out
// (testkit.ts `seatAt`): by mouse, by tapping, and by finger.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { legalDrops } from '../shared/engine';
import { DRAG_HZ, type DragAt } from '../shared/protocol';
import type { Pt } from '../shared/table';
import { hold, move, pile, slot, table, work } from '../shared/testkit';
import type { GameState, Intent } from '../shared/types';
import { CARD_H, CARD_W } from './cards/Face';
import { reporter } from './hand';
import { toScreen, toTable, type Rect } from './layout';
import { seatAt, type Seated } from './testkit';

/**
 * Seat 0 with a Four for its Five, a Queen (on the nertz pile) for its King, a Two (on the waste) for the pile in the
 * middle and an Ace for the felt; seat 1, who may call Nertz at any moment, with the same Two, and their Ace of spades
 * in the middle.
 */
const game = (): GameState => table([{ nertz: 'C3 DQ', work: ['S5', 'H4', 'DA', 'CK'], waste: 'S2' }, { waste: 'S2' }], { slots: [pile('S1', 1)] });
/** Seat 0 has put a King on its pile in the middle, and has not carried it to the tray yet. */
const finished = (): GameState => table([{ nertz: 'C3 DQ', work: ['C5', 'H4', 'DA', 'CK'] }, {}], { slots: [pile('S13', 0)] });
const phone = { W: 390, H: 844, touch: true };
const release: Intent = { k: 'release' };
const by = (p: Pt, dx: number, dy: number): Pt => ({ x: p.x + dx, y: p.y + dy });
const off: Pt = { x: 40, y: 300 }; // nothing lies there
/** The middle of the card in hand, where it is drawn. */
const centre = (t: Seated): Pt => {
  const d = t.hand;
  if (!d || d.phase === 'pressed') throw new Error('nothing in hand');
  return { x: d.at.x + (d.s * CARD_W) / 2, y: d.at.y + (d.s * CARD_H) / 2 };
};
/** Carries what is in hand until its middle is at `c`. (Under a finger the card is not where the finger is.) */
const bring = (t: Seated, c: Pt) => {
  t.move(c);
  t.move(by(c, c.x - centre(t).x, c.y - centre(t).y));
  expect(centre(t).x).toBeCloseTo(c.x);
  expect(centre(t).y).toBeCloseTo(c.y);
};
/** A point of this window where an Ace may start a pile. */
const room = (t: Seated, ace: string): Pt => {
  const to = legalDrops(t.game, 0, ace).find((d) => d.k === 'felt')!;
  return toScreen(t.L.felt, to);
};
const right = (r: Rect, d: number): Pt => ({ x: r.x + r.w + d, y: r.y + r.h / 2 });

afterEach(() => void vi.useRealTimers());

describe('carrying a card (a mouse)', () => {
  it('a press that does not travel takes nothing up: the card lies where it was and nothing is sent', () => {
    const t = seatAt(game());
    t.down(t.at('0:H4'));
    t.move(by(t.at('0:H4'), 3, 3));
    expect(t.hand?.phase).toBe('pressed');
    expect(t.sight).toBeNull();
    t.up(by(t.at('0:H4'), 3, 3));
    expect(t.sent).toEqual([hold('0:H4')]); // (the click took it up: see "tap to move")
  });

  it('past the slop the card is taken up, the server is told, and it goes exactly as the pointer goes; let go on a pile that takes it, it is moved there', () => {
    const t = seatAt(game());
    const lay = t.card('0:H4');
    t.down(t.at('0:H4'));
    t.move(by(t.at('0:H4'), 50, -80));
    expect(t.sent).toEqual([hold('0:H4')]);
    expect(t.hand).toMatchObject({ phase: 'carried', pointer: 1, held: { k: 'card', id: '0:H4', ace: false }, ids: ['0:H4'], at: { x: lay.x + 50, y: lay.y - 80 }, s: lay.s });
    t.move(t.work(0));
    t.up(t.work(0));
    expect(t.sent).toEqual([hold('0:H4'), move('0:H4', work(0))]);
    expect(t.hand).toBeNull();
    expect(t.did).toEqual([]);
  });

  it('let go where nothing takes it, it is put back', () => {
    const t = seatAt(game());
    t.drag(t.at('0:H4'), off);
    t.drag(t.at('0:H4'), t.work(3)); // a Four does not go on a King
    expect(t.sent).toEqual([hold('0:H4'), release, hold('0:H4'), release]);
    expect(t.hand).toBeNull();
  });

  it('a card with others lying on it is carried with them, and all of them are moved', () => {
    const t = seatAt(table([{ nertz: 'C3', work: [['C8', 'H7'], 'D9', 'S5', 'CK'] }, {}]));
    const [under, over] = [t.card('0:C8'), t.card('0:H7')];
    const grip = { x: under.x + 20, y: under.y + 4 }; // the strip of the Eight that shows above the Seven
    t.down(grip);
    t.move(by(grip, 30, -40));
    expect(t.hand).toMatchObject({ ids: ['0:C8', '0:H7'], lead: '0:C8', at: { x: under.x + 30, y: under.y - 40 } });
    t.move(t.work(1));
    t.up(t.work(1));
    expect(t.sent).toEqual([hold('0:C8'), move('0:C8', work(1), 2)]);
    expect(over.y).toBeGreaterThan(under.y);
  });

  it('a card goes onto the pile of the middle it is let go on', () => {
    const t = seatAt(game());
    t.drag(t.at('0:S2'), t.slot(0));
    expect(t.sent).toEqual([hold('0:S2'), move('0:S2', slot(0))]);
  });

  it('an Ace comes down to the size of a pile over the felt, shows where it would start one, and starts it at that very point', () => {
    const t = seatAt(game());
    const at = room(t, '0:DA');
    t.down(t.at('0:DA'));
    t.move(by(t.at('0:DA'), 0, -20));
    expect(t.hand).toMatchObject({ held: { ace: true }, s: t.card('0:DA').s });
    expect(t.sight).toMatchObject({ over: false, felt: undefined });
    t.move(at);
    expect(t.hand?.phase === 'carried' && t.hand.s).toBeCloseTo(t.L.fs);
    expect(centre(t).x).toBeCloseTo(at.x);
    expect(t.sight).toMatchObject({ over: true, felt: { ok: true, rect: { w: t.L.fs * CARD_W } } });
    t.up(at);
    const to = toTable(t.L.felt, at.x, at.y);
    expect(t.sent).toEqual([hold('0:DA'), move('0:DA', { k: 'felt', x: Math.round(to.x * 1000) / 1000, y: Math.round(to.y * 1000) / 1000 })]);
  });

  it('an Ace too near a pile is shown that no pile may start there, and goes home', () => {
    const t = seatAt(game());
    t.down(t.at('0:DA'));
    t.move(t.slot(0));
    expect(t.sight?.felt?.ok).toBe(false);
    t.up(t.slot(0));
    expect(t.sent).toEqual([hold('0:DA'), release]);
  });

  it('one card let go on a pile of the middle that will not take it: the server is asked whether that was a snipe, with the top the pile had when the card was taken up', () => {
    const t = seatAt(game());
    t.down(t.at('0:S2'));
    t.move(by(t.at('0:S2'), 0, -30));
    t.plays(1, move('1:S2', slot(0))); // the same card, there first
    t.move(t.slot(0));
    t.up(t.slot(0));
    expect(t.did).toEqual([{ k: 'tried', card: '0:S2', slot: 0, seen: '1:SA' }]);
    expect(t.sent).toEqual([hold('0:S2'), release]);
  });

  it('the pile took the card as the table was last drawn, but the game has moved on and the window will not play it: the card is put back, and the server is asked about that too', () => {
    const t = seatAt(game(), { scene: { plays: (intent) => intent.k !== 'move' } });
    t.drag(t.at('0:S2'), t.slot(0));
    expect(t.did).toEqual([{ k: 'tried', card: '0:S2', slot: 0, seen: '1:SA' }]);
    expect(t.sent).toEqual([hold('0:S2'), release]);
  });

  it('nobody is asked about a run let go on the middle: only single cards go there', () => {
    const t = seatAt(table([{ nertz: 'C3', work: [['C8', 'H7'], 'D9', 'S5', 'CK'] }, {}], { slots: [pile('S1', 1)] }));
    const under = t.card('0:C8');
    t.drag({ x: under.x + 20, y: under.y + 4 }, t.slot(0));
    expect(t.did).toEqual([]);
    expect(t.sent).toEqual([hold('0:C8'), release]);
  });

  it('a press on the stock deals a group; one on another player\'s card, or on nothing, does nothing', () => {
    const t = seatAt(game());
    const stock = t.L.cards.find((c) => c.mine && c.pile === 'stock')!;
    t.tap(t.at(stock.card.id));
    t.down(off, 'stock'); // (the stock's empty place)
    t.up(off);
    expect(t.did).toEqual([{ k: 'deal' }, { k: 'deal' }]);
    t.tap(t.at('1:S2'));
    t.tap(off);
    expect(t.did).toHaveLength(2);
    expect(t.sent).toEqual([]);
    expect(t.hand).toBeNull();
  });

  it('nothing is started while nothing can be: the round is paused, or its end is playing out', () => {
    for (const t of [seatAt(game(), { room: { paused: { by: 1 } } }), seatAt(game(), { scene: { playingOut: true } })]) {
      t.drag(t.at('0:H4'), t.work(0));
      t.tap(t.at(t.L.cards.find((c) => c.mine && c.pile === 'stock')!.card.id));
      expect(t.sent).toEqual([]);
      expect(t.did).toEqual([]);
    }
  });

  it('a card that may not be held is not taken up', () => {
    const t = seatAt(game(), { scene: { plays: () => false } }); // (the line has just come back: nothing is played yet)
    t.down(t.at('0:H4'));
    t.move(t.work(0));
    expect(t.hand).toBeNull();
    expect(t.sent).toEqual([]);
  });

  it('while one pointer has a card no other takes anything up, nor moves it', () => {
    const t = seatAt(game());
    t.down(t.at('0:H4'));
    t.move(by(t.at('0:H4'), 40, -40));
    const was = t.hand;
    t.act({ k: 'down', pointer: 2, ...t.at('0:CK'), touch: false, main: true, on: { card: '0:CK' } });
    t.act({ k: 'move', pointer: 2, x: 5, y: 5 });
    t.act({ k: 'up', pointer: 2, x: 5, y: 5, touch: false });
    t.act({ k: 'cancel', pointer: 2 });
    expect(t.hand).toBe(was);
    expect(t.sent).toEqual([hold('0:H4')]);
  });

  it('a carry the browser cancels puts the card back; a press it cancels was nothing', () => {
    const t = seatAt(game());
    t.down(t.at('0:H4'));
    t.act({ k: 'cancel', pointer: 1 });
    expect(t.hand).toBeNull();
    expect(t.sent).toEqual([]);
    t.down(t.at('0:H4'));
    t.move(t.work(0));
    t.act({ k: 'cancel', pointer: 1 });
    expect(t.hand).toBeNull();
    expect(t.sent).toEqual([hold('0:H4'), release]);
  });

  it('Nertz is called with a card in hand: one that has somewhere to go may still land; one that has not is taken back by the table', () => {
    const t = seatAt(game());
    t.down(t.at('0:H4'));
    t.move(by(t.at('0:H4'), 0, -60));
    t.plays(1, { k: 'nertz' });
    expect(t.hand?.phase).toBe('carried');
    t.move(t.work(0));
    t.up(t.work(0));
    expect(t.sent).toEqual([hold('0:H4'), move('0:H4', work(0))]);

    const u = seatAt(game());
    u.down(u.at('0:CK'));
    u.move(by(u.at('0:CK'), 0, -60));
    u.plays(1, { k: 'nertz' });
    expect(u.hand).toBeNull();
    expect(u.sent).toEqual([hold('0:CK')]);
    u.drag(u.at('0:H4'), u.work(0)); // and nothing more can be started
    expect(u.sent).toEqual([hold('0:CK')]);
  });
});

describe('tap to move', () => {
  it('a tap (or a click) takes the card up where it lies: the server is told, it stands lifted, and no pointer has it; the next tap, on a pile that takes it, puts it there', () => {
    const t = seatAt(game());
    const lay = t.card('0:H4');
    t.tap(t.at('0:H4'));
    expect(t.sent).toEqual([hold('0:H4')]);
    expect(t.hand).toMatchObject({ phase: 'tapped', held: { k: 'card', id: '0:H4' }, at: { x: lay.x, y: lay.y - lay.s * CARD_H * 0.16 }, s: lay.s });
    expect(t.hand).not.toHaveProperty('pointer');
    t.move(t.work(0)); // the mouse goes over to the pile: the card stays where it stands
    expect(t.hand).toMatchObject({ phase: 'tapped', at: { x: lay.x } });
    expect(t.sight).toMatchObject({ felt: undefined, tray: false });
    t.tap(t.work(0));
    expect(t.sent).toEqual([hold('0:H4'), move('0:H4', work(0))]);
    expect(t.hand).toBeNull();
  });

  it('a tap anywhere else puts it back and does nothing more: it does not deal from the stock, nor take up another card', () => {
    const t = seatAt(game());
    t.tap(t.at('0:H4'));
    t.tap(t.at(t.L.cards.find((c) => c.mine && c.pile === 'stock')!.card.id));
    expect(t.sent).toEqual([hold('0:H4'), release]);
    t.tap(t.at('0:H4'));
    t.tap(t.at('0:CK'));
    expect(t.sent).toEqual([hold('0:H4'), release, hold('0:H4'), release]);
    expect(t.hand).toBeNull();
    expect(t.did).toEqual([]);
  });

  it('Escape puts a tapped card back, and leaves a carried one alone', () => {
    const t = seatAt(game());
    t.tap(t.at('0:H4'));
    t.act({ k: 'escape' });
    expect(t.hand).toBeNull();
    expect(t.sent).toEqual([hold('0:H4'), release]);
    t.down(t.at('0:H4'));
    t.move(t.work(0));
    t.act({ k: 'escape' });
    expect(t.hand?.phase).toBe('carried');
  });

  it('a tapped Ace starts its pile on the very spot of the felt that is tapped next', () => {
    const t = seatAt(game());
    const at = room(t, '0:DA');
    t.tap(t.at('0:DA'));
    t.tap(at);
    expect(t.sent).toEqual([hold('0:DA'), { k: 'move', cardId: '0:DA', count: 1, to: { k: 'felt', x: expect.closeTo(toTable(t.L.felt, at.x, at.y).x, 3), y: expect.closeTo(toTable(t.L.felt, at.x, at.y).y, 3) } }]);
  });

  it('tapped onto a pile of the middle that will not take it: the server is asked whether that was a snipe, as for a card let go there', () => {
    const t = seatAt(game());
    t.tap(t.at('0:S5'));
    t.tap(t.slot(0));
    expect(t.did).toEqual([{ k: 'tried', card: '0:S5', slot: 0, seen: '1:SA' }]);
    expect(t.sent).toEqual([hold('0:S5'), release]);
  });

  it('a tapped card may still be put down once Nertz is called', () => {
    const t = seatAt(game());
    t.tap(t.at('0:H4'));
    t.plays(1, { k: 'nertz' });
    t.tap(t.work(0));
    expect(t.sent).toEqual([hold('0:H4'), move('0:H4', work(0))]);
  });

  it('where the table rule is off a click takes nothing up, and a card is still carried', () => {
    const t = seatAt(game(), { scene: { tapToMove: false } });
    t.tap(t.at('0:H4'));
    expect(t.hand).toBeNull();
    expect(t.sent).toEqual([]);
    t.drag(t.at('0:H4'), t.work(0));
    expect(t.sent).toEqual([hold('0:H4'), move('0:H4', work(0))]);
  });
});

describe('a finger', () => {
  it('the card comes up as it is carried off, until its lower edge is just above the fingertip', () => {
    const t = seatAt(game(), phone);
    const lay = t.card('0:H4');
    const from = t.at('0:H4');
    t.down(from);
    t.move(by(from, 0, -22)); // half the way up
    const half = t.hand;
    t.move(by(from, 0, -120));
    const d = t.hand;
    if (d?.phase !== 'carried' || half?.phase !== 'carried') throw new Error('not carried');
    expect(d.at.y + lay.s * CARD_H).toBeCloseTo(from.y - 120 - 10);
    expect(d.at.x).toBeCloseTo(lay.x);
    expect(half.at.y).toBeLessThan(lay.y - 22);
    expect(half.at.y + lay.s * CARD_H).toBeGreaterThan(from.y - 22 - 10);
  });

  it('the card is aimed by its own middle, not by the finger under it', () => {
    const t = seatAt(game(), phone);
    t.down(t.at('0:H4'));
    bring(t, t.work(0));
    const finger = t.hand?.phase === 'carried' ? { x: t.hand.px, y: t.hand.py } : off;
    expect(finger.y).toBeGreaterThan(t.work(0).y + 20);
    t.up(finger);
    expect(t.sent).toEqual([hold('0:H4'), move('0:H4', work(0))]);
  });

  it('a finger on a pile does not put there a card that is itself well off it; a mouse pointing at the same spot does', () => {
    const t = seatAt(game(), phone);
    const hit = t.L.me!.workHit[0]!;
    const spot = { x: hit.x + hit.w / 2, y: hit.y + 5 }; // just inside the top of the column
    t.down(t.at('0:H4'));
    t.move(spot);
    expect(centre(t).y).toBeLessThan(hit.y - 40);
    t.up(spot);
    expect(t.sent).toEqual([hold('0:H4'), release]);

    const mouse = seatAt(game(), { ...phone, touch: false });
    mouse.drag(mouse.at('0:H4'), spot);
    expect(mouse.sent).toEqual([hold('0:H4'), move('0:H4', work(0))]);
  });

  it('let go a little off a pile, a finger is taken to mean it; a mouse is not', () => {
    const t = seatAt(game(), phone);
    t.down(t.at('0:S2'));
    bring(t, right(t.L.slotHit[0]!, 20));
    t.up(t.hand?.phase === 'carried' ? { x: t.hand.px, y: t.hand.py } : off);
    expect(t.sent).toEqual([hold('0:S2'), move('0:S2', slot(0))]);

    const far = seatAt(game(), phone);
    far.down(far.at('0:S2'));
    bring(far, right(far.L.slotHit[0]!, 60));
    far.up(far.hand?.phase === 'carried' ? { x: far.hand.px, y: far.hand.py } : off);
    expect(far.sent).toEqual([hold('0:S2'), release]);

    const mouse = seatAt(game());
    mouse.drag(mouse.at('0:S2'), right(mouse.L.slotHit[0]!, 20));
    expect(mouse.sent).toEqual([hold('0:S2'), release]);
  });

  it('a tap that takes nothing up fans out the pile under it (or closes the one that is); the tap that takes a card up does not, nor the one that puts it down', () => {
    const t = seatAt(game(), phone);
    t.tap(t.at('0:H4'));
    t.tap(t.work(0));
    expect(t.sent).toEqual([hold('0:H4'), move('0:H4', work(0))]);
    expect(t.did).toEqual([]);
    t.tap(off);
    expect(t.did).toEqual([{ k: 'fan', ...off }]);

    const dragged = seatAt(game(), { ...phone, scene: { tapToMove: false } });
    dragged.tap(dragged.at('0:H4'));
    expect(dragged.did).toEqual([{ k: 'fan', ...dragged.at('0:H4') }]);
    expect(dragged.hand).toBeNull();
    expect(seatAt(game()).did).toEqual([]);
  });

  it('a mouse fans nothing out by clicking', () => {
    const t = seatAt(game(), { scene: { tapToMove: false } });
    t.tap(t.at('0:H4'));
    t.tap(off);
    expect(t.did).toEqual([]);
  });
});

describe('a finished pile of yours', () => {
  it('until it is in the tray nothing else is taken up or dealt: the player is told instead', () => {
    const t = seatAt(finished());
    t.drag(t.at('0:H4'), t.work(0));
    t.tap(t.at(t.L.cards.find((c) => c.mine && c.pile === 'stock')!.card.id));
    expect(t.did).toEqual([{ k: 'nag' }, { k: 'nag' }]);
    expect(t.sent).toEqual([]);
    expect(t.hand).toBeNull();
  });

  it('the whole pile is carried by its King to the tray, which shows when the pile is over it; the server is not told it is held', () => {
    const t = seatAt(finished());
    const tray = by({ x: t.L.trayHit.x, y: t.L.trayHit.y }, 20, 20);
    t.down(t.slot(0));
    t.move(by(t.slot(0), 60, 0));
    expect(t.hand).toMatchObject({ phase: 'carried', held: { k: 'pile', slot: 0 }, lead: '0:SK' });
    expect(t.hand?.ids).toEqual(t.L.cards.filter((c) => c.pile === 'slot').map((c) => c.card.id)); // (every card of the pile that is drawn)
    expect(t.sight).toMatchObject({ tray: false, report: null });
    t.move(tray);
    expect(t.sight?.tray).toBe(true);
    t.up(tray);
    expect(t.sent).toEqual([{ k: 'clear', slot: 0 }]);
    expect(t.hand).toBeNull();
  });

  it('let go anywhere but over the tray it goes back, and nothing is sent', () => {
    const t = seatAt(finished());
    t.drag(t.slot(0), off);
    expect(t.sent).toEqual([]);
    expect(t.hand).toBeNull();
  });

  it('tapped, it stands in hand, and a tap on the tray takes it there; a tap anywhere else only puts it back', () => {
    const t = seatAt(finished());
    t.tap(t.slot(0));
    expect(t.hand).toMatchObject({ phase: 'tapped', held: { k: 'pile', slot: 0 } });
    t.tap(off);
    expect(t.hand).toBeNull();
    expect(t.sent).toEqual([]);
    t.tap(t.slot(0));
    t.tap(by({ x: t.L.trayHit.x, y: t.L.trayHit.y }, 20, 20));
    expect(t.sent).toEqual([{ k: 'clear', slot: 0 }]);
    expect(t.did).toEqual([]);
  });

  it('Nertz is called with the pile in hand: it is let go, and scores where it lies', () => {
    const t = seatAt(finished());
    t.down(t.slot(0));
    t.move(by(t.slot(0), 60, 0));
    t.plays(1, { k: 'nertz' });
    expect(t.hand).toBeNull();
    expect(t.sent).toEqual([]);
  });

  it('someone else\'s finished pile is not yours to take up', () => {
    const t = seatAt(table([{ nertz: 'C3', work: ['C5', 'H4', 'DA', 'CK'] }, {}], { slots: [pile('S13', 1)] }));
    t.drag(t.slot(0), off);
    t.tap(t.slot(0));
    expect(t.hand).toBeNull();
    expect(t.did).toEqual([]);
  });
});

describe('telling the others where the card is', () => {
  const at = (id: string): DragAt => ({ id, w: 0, h: [0, 0], p: [0, 0] });

  it('the first report goes at once, then at most DRAG_HZ a second: the last always goes out, late if need be', () => {
    vi.useFakeTimers();
    const out: string[] = [];
    const telling = reporter((r) => out.push(r.id));
    telling.tell(at('a'));
    telling.tell(at('b'));
    telling.tell(at('c'));
    expect(out).toEqual(['a']);
    vi.advanceTimersByTime(1000 / DRAG_HZ + 1);
    expect(out).toEqual(['a', 'c']);
    vi.advanceTimersByTime(1000);
    expect(out).toEqual(['a', 'c']);
    telling.tell(at('d'));
    expect(out).toEqual(['a', 'c', 'd']);
  });

  it('once it is stopped (the hand opened, the table is gone) nothing that was waiting is sent, and the next hand reports at once', () => {
    vi.useFakeTimers();
    const out: string[] = [];
    const telling = reporter((r) => out.push(r.id));
    telling.tell(at('a'));
    telling.tell(at('b'));
    telling.stop();
    vi.advanceTimersByTime(1000);
    expect(out).toEqual(['a']);
    telling.tell(at('c'));
    expect(out).toEqual(['a', 'c']);
  });

  it('a carried card is reported as it goes: how far from its pile in cards of the hand, where on the table, and how far along to a pile of the middle that takes it', () => {
    vi.useFakeTimers();
    const t = seatAt(game());
    const from = t.at('0:S2');
    const w = t.card('0:S2').s * CARD_W;
    t.down(from);
    t.move(by(from, w, -2 * w));
    expect(t.reports).toHaveLength(1);
    expect(t.reports[0]).toMatchObject({ id: '0:S2', h: [1, 2] });
    expect(t.reports[0]!.w).toBeGreaterThan(0);
    expect(t.reports[0]!.w).toBeLessThan(1);
    t.move(by(t.slot(0), 0, 40));
    t.move(t.slot(0));
    expect(t.reports).toHaveLength(1); // not yet: too soon after the last
    vi.advanceTimersByTime(1000 / DRAG_HZ + 1);
    expect(t.reports).toHaveLength(2);
    const there = toTable(t.L.felt, t.slot(0).x, t.slot(0).y);
    expect(t.reports[1]).toMatchObject({ id: '0:S2', w: 1, p: [expect.closeTo(there.x, 2), expect.closeTo(there.y, 2)] });
    t.move(by(t.slot(0), 0, 5));
    t.up(by(t.slot(0), 0, 5));
    vi.advanceTimersByTime(1000);
    expect(t.reports).toHaveLength(2); // the hand is open: the report that was waiting is not sent
  });

  it('a card that stands tapped is reported where it stands, and one with no pile of the middle to go to has come no way', () => {
    vi.useFakeTimers();
    const t = seatAt(game());
    t.tap(t.at('0:H4'));
    expect(t.reports).toEqual([{ id: '0:H4', w: 0, h: [0, expect.closeTo(0.16 * (CARD_H / CARD_W), 2)], p: expect.anything() }]);
  });
});
