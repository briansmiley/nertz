import { describe, expect, it } from 'vitest';
import { cleanName, isRoomCode, MAX_MESSAGE_BYTES, MAX_NAME_LENGTH, parseClientMsg, parseIntent, randomRoomCode } from './protocol';

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
      { t: 'intent', seq: 1, intent: { k: 'move', cardId: 'c', count: 1, to: { k: 'slot', i: 24 } } }, { t: 'intent', seq: 1, intent: { k: 'move', cardId: 'c', count: 1, to: { k: 'slot' } } },
      { t: 'intent', seq: 1, intent: { k: 'move', cardId: 'c', count: 1, to: { k: 'foundation', id: 'f' } } }, { t: 'intent', seq: 1, intent: { k: 'move', cardId: 'c', count: 1, to: { k: 'newFoundation' } } },
      { t: 'intent', seq: 1, intent: { k: 'hold' } }, { t: 'intent', seq: 1, intent: { k: 'hold', cardId: 'x'.repeat(65) } },
      { t: 'intent', seq: 1, intent: { k: 'clear' } }, { t: 'intent', seq: 1, intent: { k: 'clear', slot: 24 } }, { t: 'intent', seq: 1, intent: { k: 'clear', slot: -1 } },
      { t: 'create' }, { t: 'create', name: 'A' }, { t: 'create', name: '  ', token: TOKEN }, { t: 'create', name: 'A', token: 'short' }, { t: 'create', name: 7, token: TOKEN },
      `{"t":"start","pad":"${'x'.repeat(MAX_MESSAGE_BYTES)}"}`,
    ];
    for (const raw of bad) {
      expect(() => parseClientMsg(raw)).not.toThrow();
      expect(parseClientMsg(raw), JSON.stringify(raw)?.slice(0, 80)).toBeNull();
    }
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
});
