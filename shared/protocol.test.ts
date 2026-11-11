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
    expect(parseClientMsg('{"t":"start","junk":true}')).toEqual({ t: 'start' });
    expect(parseClientMsg({ t: 'leave' })).toEqual({ t: 'leave' });
    expect(parseClientMsg(JSON.stringify({ t: 'intent', seq: 4, intent: { k: 'move', cardId: 'c1', to: { k: 'work', i: 3, z: 1 } } }))).toEqual({
      t: 'intent',
      seq: 4,
      intent: { k: 'move', cardId: 'c1', to: { k: 'work', i: 3 } },
    });
    expect(parseClientMsg({ t: 'intent', seq: 0, intent: { k: 'stuck', on: false } })).toEqual({ t: 'intent', seq: 0, intent: { k: 'stuck', on: false } });
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
      { t: 'intent', seq: 1, intent: { k: 'move', cardId: 'c', to: { k: 'work', i: 4 } } },
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
    expect(parseIntent({ k: 'move', cardId: 'a', to: { k: 'foundation', id: 'f' } })).toEqual({ k: 'move', cardId: 'a', to: { k: 'foundation', id: 'f' } });
    expect(parseIntent({ k: 'move', cardId: 'a', to: { k: 'newFoundation' } })).toEqual({ k: 'move', cardId: 'a', to: { k: 'newFoundation' } });
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
