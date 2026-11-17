import { describe, expect, it } from 'vitest';
import { anotherBack, CARD_BACKS, cleanName, DRAG_HZ, DRAG_RATE, isBack, isRoomCode, MAX_MESSAGE_BYTES, MAX_NAME_LENGTH, parseClientMsg, parseIntent, PLAIN_LOOK, randomRoomCode } from './protocol';
import { TABLE } from './table';

const TOKEN = 'abcDEF123_-xyz';

describe('parseClientMsg', () => {
  it('accepts and normalises each message type, from text or objects', () => {
    expect(parseClientMsg({ t: 'join', room: ' abcd ', name: '  Ann\t\n Lee  ', token: TOKEN, extra: 1 })).toEqual({
      t: 'join',
      room: 'ABCD',
      name: 'Ann Lee',
      token: TOKEN,
    });
    expect(parseClientMsg({ t: 'create', name: ' Ann ', token: TOKEN, room: 'ZZZZ' })).toEqual({ t: 'create', name: 'Ann', token: TOKEN });
    expect(parseClientMsg('{"t":"start","junk":true}')).toEqual({ t: 'start' });
    expect(parseClientMsg('{"t":"go","seat":3}')).toEqual({ t: 'go' }); // the dealer's "1, 2, 3": carries nothing
    expect(parseClientMsg({ t: 'leave' })).toEqual({ t: 'leave' });
    expect(parseClientMsg(JSON.stringify({ t: 'intent', seq: 4, intent: { k: 'move', cardId: 'c1', count: 2, to: { k: 'work', i: 3, z: 1 } } }))).toEqual({
      t: 'intent',
      seq: 4,
      intent: { k: 'move', cardId: 'c1', count: 2, to: { k: 'work', i: 3 } },
    });
    expect(parseClientMsg({ t: 'intent', seq: 0, intent: { k: 'stuck', on: false } })).toEqual({ t: 'intent', seq: 0, intent: { k: 'stuck', on: false } });
    for (const intent of [{ k: 'move', cardId: 'c1', count: 1, to: { k: 'slot', i: 23 } }, { k: 'hold', cardId: 'c1' }, { k: 'release' }, { k: 'clear', slot: 0 }, { k: 'nertz' }]) {
      expect(parseClientMsg({ t: 'intent', seq: 1, intent: { ...intent, extra: true } })).toEqual({ t: 'intent', seq: 1, intent });
    }
    expect(parseClientMsg({ t: 'tried', card: 'c1', seen: ['c2', null], by: 0 })).toEqual({ t: 'tried', card: 'c1', seen: ['c2', null] }); // (who did it is the server's to say)
    expect(parseClientMsg({ t: 'tried', card: 'c1', seen: [] })).toEqual({ t: 'tried', card: 'c1', seen: [] });
    expect(parseClientMsg({ t: 'tried', card: 'c1', slot: 3, seen: 'c2' })).toEqual({ t: 'sniped' }); // a window from before a snipe counted wherever the card is let go: taken, and ignored
    expect(parseClientMsg({ t: 'sniped', slot: 2 })).toEqual({ t: 'sniped' }); // a window from before the server judged snipes: taken, and ignored
  });

  it('takes a look whole, with every part said, and a lot always undrawn', () => {
    const look = { deck: 'classic', night: true, backs: { k: 'own', back: 'fern', lot: 'all' }, bare: true, x: 1 };
    expect(parseClientMsg({ t: 'deck', look })).toEqual({ t: 'deck', look: { deck: 'classic', night: true, backs: { k: 'own', back: 'fern' }, bare: true } });
    expect(parseClientMsg({ t: 'botBack', seat: 2, backs: { k: 'lot', lot: 'Plants', drawn: 'fern' } })).toEqual({ t: 'botBack', seat: 2, backs: { k: 'lot', lot: 'Plants', drawn: null } });
    for (const bad of [{ ...PLAIN_LOOK, night: undefined }, { ...PLAIN_LOOK, deck: 'modern:night' }, { ...PLAIN_LOOK, backs: 'fern:bare' }, { ...PLAIN_LOOK, backs: { k: 'own', back: 'any' } }, { ...PLAIN_LOOK, backs: { k: 'lot' } }]) expect(parseClientMsg({ t: 'deck', look: bad })).toBeNull();
  });

  it('caps the name length', () => {
    const msg = parseClientMsg({ t: 'join', room: 'ABCD', name: 'x'.repeat(50), token: TOKEN });
    expect(msg).toMatchObject({ name: 'x'.repeat(MAX_NAME_LENGTH) });
  });

  it('returns null for anything malformed and never throws', () => {
    const bad: unknown[] = [
      undefined, null, 3, '', 'nope', '{', '[]', '"start"', 'null', [], {}, { t: 'fly' }, { t: ['start'] },
      { t: 'join' }, { t: 'join', room: 'ABCD', name: 'A' }, { t: 'join', room: 'ABC', name: 'A', token: TOKEN },
      { t: 'join', room: 'ABCI', name: 'A', token: TOKEN }, { t: 'join', room: 'AB1D', name: 'A', token: TOKEN },
      { t: 'join', room: 'ABCD', name: '   ', token: TOKEN }, { t: 'join', room: 'ABCD', name: 'x'.repeat(201), token: TOKEN },
      { t: 'join', room: 'ABCD', name: 7, token: TOKEN }, { t: 'join', room: 'ABCD', name: 'A', token: 'short' },
      { t: 'join', room: 'ABCD', name: 'A', token: 'has spaces in it' }, { t: 'join', room: 'ABCD', name: 'A', token: 'x'.repeat(65) },
      { t: 'intent' }, { t: 'intent', seq: 1 }, { t: 'intent', seq: -1, intent: { k: 'flip' } }, { t: 'intent', seq: 1.5, intent: { k: 'flip' } },
      { t: 'intent', seq: '1', intent: { k: 'flip' } }, { t: 'intent', seq: 2 ** 60, intent: { k: 'flip' } }, { t: 'intent', seq: 1, intent: { k: 'jump' } },
      { t: 'intent', seq: 1, intent: { k: 'move', cardId: 'c', count: 1, to: { k: 'work', i: 4 } } },
      // a move must say how many cards were lifted: 1 to 13
      ...[undefined, 0, 14, 1.5, '1'].map((count) => ({ t: 'intent', seq: 1, intent: { k: 'move', cardId: 'c', count, to: { k: 'work', i: 0 } } })),
      { t: 'intent', seq: 1, intent: { k: 'move', cardId: 'c', count: 1, to: { k: 'slot', i: 40 } } }, { t: 'intent', seq: 1, intent: { k: 'move', cardId: 'c', count: 1, to: { k: 'slot' } } },
      { t: 'intent', seq: 1, intent: { k: 'move', cardId: 'c', count: 1, to: { k: 'foundation', id: 'f' } } }, { t: 'intent', seq: 1, intent: { k: 'move', cardId: 'c', count: 1, to: { k: 'newFoundation' } } },
      { t: 'intent', seq: 1, intent: { k: 'hold' } }, { t: 'intent', seq: 1, intent: { k: 'hold', cardId: 'x'.repeat(65) } },
      { t: 'intent', seq: 1, intent: { k: 'clear' } }, { t: 'intent', seq: 1, intent: { k: 'clear', slot: 40 } }, { t: 'intent', seq: 1, intent: { k: 'clear', slot: -1 } },
      { t: 'tried', seen: [] }, { t: 'tried', card: 'c', slot: 40, seen: null }, { t: 'tried', card: 'c' }, { t: 'tried', card: 'c', seen: [7] }, { t: 'tried', card: 'c', seen: Array(41).fill(null) },
      { t: 'create' }, { t: 'create', name: 'A' }, { t: 'create', name: '  ', token: TOKEN }, { t: 'create', name: 'A', token: 'short' }, { t: 'create', name: 7, token: TOKEN },
      `{"t":"start","pad":"${'x'.repeat(MAX_MESSAGE_BYTES)}"}`,
    ];
    for (const raw of bad) {
      expect(() => parseClientMsg(raw)).not.toThrow();
      expect(parseClientMsg(raw), JSON.stringify(raw)?.slice(0, 80)).toBeNull();
    }
  });
});

describe('a pile started on the felt', () => {
  it('is a point of the table: both coordinates finite and within the box the felt lies in, kept to a thousandth', () => {
    const felt = (x: unknown, y: unknown) => parseIntent({ k: 'move', cardId: 'a', count: 1, to: { k: 'felt', x, y, i: 3 } });
    expect(felt(0.25, -0.5)).toEqual({ k: 'move', cardId: 'a', count: 1, to: { k: 'felt', x: 0.25, y: -0.5 } });
    expect(felt(0.123456, -0.9876543)).toEqual({ k: 'move', cardId: 'a', count: 1, to: { k: 'felt', x: 0.123, y: -0.988 } });
    expect(felt(TABLE.hw, -1)).not.toBeNull(); // (the box: whether a card fits there is the engine's business)
    expect(felt(-TABLE.hw, 1)).not.toBeNull();
    expect(Object.is((felt(-0.0001, 0) as { to: { x: number } }).to.x, 0)).toBe(true); // never minus zero: it does not survive JSON
    for (const bad of [TABLE.hw + 0.001, -7, NaN, Infinity, -Infinity, '0.5', null, undefined, [0], {}]) {
      expect(felt(bad, 0)).toBeNull();
      expect(felt(0, bad)).toBeNull();
    }
    expect(felt(0, 1.001)).toBeNull(); // the felt is wider than it is high
    expect(felt(1.001, 0)).not.toBeNull();
    expect(parseIntent({ k: 'move', cardId: 'a', count: 1, to: { k: 'felt' } })).toBeNull();
  });
});

describe('card-position reports (drag)', () => {
  const good = { t: 'drag', id: 'c1', w: 0.5, h: [1.25, -2], p: [0.1, 0.9] };

  it('accepts a well-formed report as a clean, rounded copy', () => {
    expect(parseClientMsg({ ...good, seat: 4, extra: true })).toEqual(good); // the seat is the server's to stamp
    expect(parseClientMsg(JSON.stringify({ ...good, w: 0.123456, h: [1.23456, -2.00049], p: [0.33333, -0.66666] }))).toEqual({ t: 'drag', id: 'c1', w: 0.123, h: [1.235, -2], p: [0.333, -0.667] });
    expect(parseClientMsg({ ...good, w: 0, h: [60, -60], p: [8, -8] })).not.toBeNull();
    expect(parseClientMsg({ ...good, w: 1 })).not.toBeNull();
  });

  it('refuses anything else: missing or wrong-typed fields, numbers out of range or not finite', () => {
    const bad: unknown[] = [
      { ...good, id: '' },
      { ...good, id: 7 },
      { ...good, id: 'x'.repeat(65) },
      { ...good, w: -0.01 },
      { ...good, w: 1.01 },
      { ...good, w: '1' },
      { ...good, w: NaN },
      { ...good, h: [0] },
      { ...good, h: [0, 0, 0] },
      { ...good, h: [61, 0] },
      { ...good, h: [0, Infinity] },
      { ...good, h: 'up' },
      { ...good, p: [8.5, 0] },
      { ...good, p: [0, null] },
      { ...good, p: { x: 0, y: 0 } },
      { t: 'drag' },
      { t: 'drag', id: 'c1', w: 0.5, h: [0, 0] },
    ];
    for (const msg of bad) expect(parseClientMsg(msg), JSON.stringify(msg)).toBeNull();
  });

  it('is small, and the rate a client sends at is within what the server lets through', () => {
    const biggest = JSON.stringify({ t: 'drag', id: 'x'.repeat(64), w: 0.123, h: [-59.999, -59.999], p: [-7.999, -7.999] });
    expect(biggest.length).toBeLessThan(140);
    expect(biggest.length).toBeLessThan(MAX_MESSAGE_BYTES);
    expect(DRAG_HZ).toBeGreaterThanOrEqual(15);
    expect(DRAG_HZ).toBeLessThanOrEqual(20);
    expect(DRAG_HZ).toBeLessThan(DRAG_RATE);
  });
});

describe('small helpers', () => {
  it('parseIntent returns clean copies', () => {
    expect(parseIntent({ k: 'flip', x: 1 })).toEqual({ k: 'flip' });
    expect(parseIntent({ k: 'move', cardId: 'a', count: 13, to: { k: 'slot', i: 7, id: 'f' } })).toEqual({ k: 'move', cardId: 'a', count: 13, to: { k: 'slot', i: 7 } });
    expect(parseIntent({ k: 'hold', cardId: 'a', to: 1 })).toEqual({ k: 'hold', cardId: 'a' });
    expect(parseIntent({ k: 'release', cardId: 'a' })).toEqual({ k: 'release' });
    expect(parseIntent({ k: 'clear', slot: 3, x: 1 })).toEqual({ k: 'clear', slot: 3 });
    expect(parseIntent({ k: 'move', cardId: 'a', count: 1, to: { k: 'newFoundation' } })).toBeNull(); // the old "anywhere in the middle" target is gone
    expect(parseIntent({ k: 'stuck' })).toBeNull();
  });

  it('cleanName and room codes', () => {
    expect(cleanName(' \u0007 Bob \n')).toBe('Bob');
    expect(cleanName('')).toBe('');
    for (let i = 0; i < 50; i++) expect(isRoomCode(randomRoomCode())).toBe(true);
    expect(isRoomCode(randomRoomCode(() => 1))).toBe(true);
    expect(isRoomCode('abcd')).toBe(false);
    expect(isRoomCode('ABCDE')).toBe(false);
  });

  it('anotherBack is any back but the one the card had', () => {
    const all = Object.keys(CARD_BACKS) as (keyof typeof CARD_BACKS)[];
    for (const had of all) {
      const seen = new Set([0, 0.25, 0.5, 0.75, 0.999999, 1].map((roll) => anotherBack(had, undefined, roll)));
      for (const b of seen) expect(isBack(b) && b !== had).toBe(true);
    }
    const reached = new Set(Array.from({ length: all.length - 1 }, (_, i) => anotherBack('plain', undefined, (i + 0.5) / (all.length - 1))));
    expect(reached.size).toBe(all.length - 1); // every other back can come up
    expect(anotherBack('plain', ['plain'], 0.5)).toBe('plain'); // a lot of one: that one
    expect(anotherBack('plain', ['plain', all[1]!], 0)).toBe(all[1]); // never the one it had while there is another
  });
});
