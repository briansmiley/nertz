import { describe, expect, it } from 'vitest';
import { PLAIN_LOOK, type Look } from '../shared/protocol';
import { cleanPrefs, DEFAULT_PREFS, gateLevel, GATE_MAX, hotkeyPressed, keyFree, loudness, micGain, seenLook, takeKey, type Levels, type Prefs } from './prefs';

describe('cleanPrefs: hotkeys', () => {
  it('gives the defaults to prefs stored before there were any (or before the sound key)', () => {
    expect(cleanPrefs(null)).toMatchObject({ soundKey: 'KeyM', voiceKey: 'KeyV', pauseKey: 'KeyP' });
    expect(cleanPrefs({ muted: true, voiceKey: 'KeyB' })).toMatchObject({ muted: true, soundKey: 'KeyM', voiceKey: 'KeyB' });
    expect(cleanPrefs({ voiceKey: null })).toMatchObject({ soundKey: 'KeyM', voiceKey: null });
  });

  it('gives the pause key P to prefs stored before it was a hotkey, unless another has P', () => {
    expect(cleanPrefs({ soundKey: 'KeyS', voiceKey: 'KeyB' })).toMatchObject({ soundKey: 'KeyS', voiceKey: 'KeyB', pauseKey: 'KeyP' });
    expect(cleanPrefs({ soundKey: 'KeyP' })).toMatchObject({ soundKey: 'KeyP', pauseKey: null });
    expect(cleanPrefs({ pauseKey: 'KeyK' })).toMatchObject({ pauseKey: 'KeyK' });
    expect(cleanPrefs({ pauseKey: null })).toMatchObject({ pauseKey: null });
  });

  it('keeps a key chosen, and none', () => {
    expect(cleanPrefs({ soundKey: 'KeyS', voiceKey: 'Digit7' })).toMatchObject({ soundKey: 'KeyS', voiceKey: 'Digit7' });
    expect(cleanPrefs({ soundKey: null, voiceKey: null })).toMatchObject({ soundKey: null, voiceKey: null });
  });

  it('puts back the default for a key the game uses, a modifier, or anything damaged', () => {
    for (const bad of ['Space', 'Enter', 'Escape', 'Tab', 'ShiftLeft', 'MetaRight', 'Backspace', 'Delete', '', 'Key-M', 'x'.repeat(21), 7, true, {}])
      expect(cleanPrefs({ soundKey: bad, voiceKey: bad, pauseKey: bad })).toMatchObject({ soundKey: DEFAULT_PREFS.soundKey, voiceKey: DEFAULT_PREFS.voiceKey, pauseKey: DEFAULT_PREFS.pauseKey });
  });

  it('never gives both the same key', () => {
    expect(cleanPrefs({ soundKey: 'KeyX', voiceKey: 'KeyX' })).toMatchObject({ soundKey: 'KeyX', voiceKey: 'KeyV' });
    expect(cleanPrefs({ soundKey: 'KeyV', voiceKey: 'KeyV' })).toMatchObject({ soundKey: 'KeyV', voiceKey: null });
    expect(cleanPrefs({ soundKey: 'KeyV' })).toMatchObject({ soundKey: 'KeyV', voiceKey: null });
    expect(cleanPrefs({ voiceKey: 'KeyM' })).toMatchObject({ soundKey: 'KeyM', voiceKey: 'KeyV' });
    expect(cleanPrefs({ voiceKey: 'KeyX', pauseKey: 'KeyX' })).toMatchObject({ voiceKey: 'KeyX', pauseKey: 'KeyP' });
  });
});

describe('cleanPrefs: levels', () => {
  const close = (got: Levels, want: Levels) => {
    for (const k of ['master', 'mine', 'others', 'voice'] as const) expect(got[k]).toBeCloseTo(want[k], 9);
  };
  /** What played before there were levels: the game's sounds at volume², other players' cards at volume² × others (× sound.ts's OTHERS), voice chat at full. */
  const before = (volume: number, others: number) => ({ mine: volume ** 2, others: volume ** 2 * others, voice: 1 });
  const now = (p: Prefs) => ({ mine: loudness(p, 'mine'), others: loudness(p, 'others'), voice: loudness(p, 'voice') });

  it('carries a volume and a share for other players over just as loud, and defaults as loud as they were', () => {
    for (const [volume, others] of [[0.8, 0.25], [0.3, 1], [1, 0], [0.55, 0.6], [0, 0.5]] as const) {
      const p = cleanPrefs({ volume, others });
      const was = before(volume, others);
      const is = now(p);
      expect(is.mine).toBeCloseTo(was.mine, 9);
      expect(is.others).toBeCloseTo(was.others, 9);
      expect(is.voice).toBe(1);
      expect(p).not.toHaveProperty('volume');
    }
    const fresh = now(cleanPrefs(null));
    expect(fresh.mine).toBeCloseTo(before(0.8, 0.25).mine, 9);
    expect(fresh.others).toBeCloseTo(before(0.8, 0.25).others, 9);
    expect(DEFAULT_PREFS.levels).toMatchObject({ master: 1, voice: 1 });
    close(cleanPrefs({ volume: 0.5 }).levels, cleanPrefs({ volume: 0.5, others: 0.25 }).levels);
  });

  it('keeps levels stored as such, over any old volume, and mends a damaged one', () => {
    const levels = { master: 0.6, mine: 0.2, others: 0.9, voice: 0.45 };
    expect(cleanPrefs({ levels, volume: 0.1, others: 0.1 }).levels).toEqual(levels);
    expect(cleanPrefs({ levels: { ...levels, voice: 7, mine: 'loud' } }).levels).toEqual({ ...levels, voice: 1, mine: DEFAULT_PREFS.levels.mine });
    expect(cleanPrefs({ levels: { master: -1 } }).levels).toEqual({ ...DEFAULT_PREFS.levels, master: 0 });
    expect(cleanPrefs({ levels: 'all of them' }).levels).toEqual(DEFAULT_PREFS.levels);
    expect(cleanPrefs(cleanPrefs({ volume: 0.3, others: 0.7 }))).toEqual(cleanPrefs({ volume: 0.3, others: 0.7 }));
  });
});

describe('cleanPrefs: the microphone', () => {
  it('leaves your voice as it was by default: at full, with no gate', () => {
    expect(cleanPrefs(null).mic).toEqual({ level: 1, gate: 0 });
    expect(cleanPrefs({ levels: { master: 0.5 } }).mic).toEqual(DEFAULT_PREFS.mic);
    expect(micGain(DEFAULT_PREFS.mic)).toBe(1);
    expect(gateLevel(DEFAULT_PREFS.mic)).toBe(0);
  });

  it('keeps a level up to twice as loud and a gate up to its top, and mends a damaged one', () => {
    expect(cleanPrefs({ mic: { level: 1.6, gate: 0.3 } }).mic).toEqual({ level: 1.6, gate: 0.3 });
    expect(cleanPrefs({ mic: { level: 9, gate: 2 } }).mic).toEqual({ level: 2, gate: 1 });
    expect(cleanPrefs({ mic: { level: -1, gate: 'loud' } }).mic).toEqual({ level: 0, gate: 0 });
    expect(cleanPrefs({ mic: { level: 'quiet' } }).mic).toEqual({ level: 1, gate: 0 });
    expect(cleanPrefs({ mic: 'on' }).mic).toEqual(DEFAULT_PREFS.mic);
  });

  it('squares both, as the volume is', () => {
    expect(micGain({ level: 2, gate: 0 })).toBe(4);
    expect(micGain({ level: 0.5, gate: 0 })).toBe(0.25);
    expect(gateLevel({ level: 1, gate: 1 })).toBe(GATE_MAX);
    expect(gateLevel({ level: 1, gate: 0.5 })).toBeCloseTo(GATE_MAX / 4, 9);
  });
});

describe('loudness', () => {
  const levels = { master: 0.5, mine: 0.8, others: 0.4, voice: 1 };
  it('is the master times the channel, squared', () => {
    expect(loudness({ muted: false, levels }, 'mine')).toBeCloseTo(0.16, 9);
    expect(loudness({ muted: false, levels }, 'others')).toBeCloseTo(0.04, 9);
    expect(loudness({ muted: false, levels }, 'voice')).toBeCloseTo(0.25, 9);
    expect(loudness({ muted: false, levels: { ...levels, master: 0 } }, 'voice')).toBe(0);
  });
  it('mutes the game, not voice chat', () => {
    expect(loudness({ muted: true, levels }, 'mine')).toBe(0);
    expect(loudness({ muted: true, levels }, 'others')).toBe(0);
    expect(loudness({ muted: true, levels }, 'voice')).toBeCloseTo(0.25, 9);
  });
});

describe('keyFree', () => {
  const none = { soundKey: null, voiceKey: null, pauseKey: null };
  const keys = { soundKey: 'KeyM', voiceKey: 'KeyV', pauseKey: 'KeyP' };
  it('refuses the other hotkey, but not the key the same one already has', () => {
    expect(keyFree(keys, 'soundKey', 'KeyV')).toBe(false);
    expect(keyFree(keys, 'voiceKey', 'KeyM')).toBe(false);
    expect(keyFree(keys, 'soundKey', 'KeyM')).toBe(true);
    expect(keyFree(keys, 'soundKey', 'KeyP')).toBe(false);
    expect(keyFree(keys, 'pauseKey', 'KeyM')).toBe(false);
    expect(keyFree(keys, 'pauseKey', 'KeyP')).toBe(true);
    expect(keyFree({ ...none, soundKey: 'KeyM' }, 'voiceKey', 'KeyN')).toBe(true);
  });
  it('refuses the keys the game uses', () => {
    for (const code of ['Space', 'Enter', 'Escape', 'Tab']) for (const k of ['soundKey', 'pauseKey'] as const) expect(keyFree(none, k, code)).toBe(false);
  });
  it("lets P go to another hotkey: it is the pause key's own, not the game's", () => {
    expect(keyFree(none, 'soundKey', 'KeyP')).toBe(true);
  });
});

describe('takeKey', () => {
  const keys = { soundKey: 'KeyM', voiceKey: 'KeyV', pauseKey: 'KeyP' };
  it('takes a key the other hotkey has, and leaves that one with none', () => {
    expect(takeKey(keys, 'soundKey', 'KeyV')).toEqual({ soundKey: 'KeyV', voiceKey: null });
    expect(takeKey(keys, 'voiceKey', 'KeyM')).toEqual({ voiceKey: 'KeyM', soundKey: null });
    expect(takeKey(keys, 'soundKey', 'KeyP')).toEqual({ soundKey: 'KeyP', pauseKey: null });
    expect(takeKey(keys, 'pauseKey', 'KeyV')).toEqual({ pauseKey: 'KeyV', voiceKey: null });
  });
  it('takes a key nobody has, and touches nothing else', () => {
    expect(takeKey(keys, 'soundKey', 'KeyB')).toEqual({ soundKey: 'KeyB' });
    expect(takeKey(keys, 'soundKey', 'KeyM')).toEqual({ soundKey: 'KeyM' });
    expect(takeKey(keys, 'pauseKey', 'KeyK')).toEqual({ pauseKey: 'KeyK' });
  });
  it('refuses a key the game uses, and a modifier', () => {
    for (const code of ['Space', 'Escape', 'ShiftLeft', 'Backspace']) for (const k of ['soundKey', 'pauseKey'] as const) expect(takeKey(keys, k, code)).toBeNull();
  });
});

describe('hotkeyPressed', () => {
  const press = (over: Partial<KeyboardEvent> = {}) => ({ code: 'KeyM', repeat: false, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, target: null, ...over }) as KeyboardEvent;
  it('is the key pressed bare', () => {
    expect(hotkeyPressed(press(), 'KeyM')).toBe(true);
    expect(hotkeyPressed(press(), 'KeyV')).toBe(false);
    expect(hotkeyPressed(press(), null)).toBe(false);
  });
  it('is not the key with a modifier, or held down', () => {
    for (const over of [{ shiftKey: true }, { ctrlKey: true }, { altKey: true }, { metaKey: true }, { repeat: true }]) expect(hotkeyPressed(press(over), 'KeyM')).toBe(false);
  });
});

describe("seenLook: someone's cards on your screen", () => {
  const theirs: Look = { deck: 'pixel', night: true, backs: { k: 'own', back: 'hilbert' }, bare: true };
  const mine = { deck: 'cute', night: false } as const;

  it("is as they chose them, owner's faces being the default", () => {
    expect(seenLook({ ...mine, faces: 'owner' }, theirs)).toBe(theirs);
    expect(seenLook(DEFAULT_PREFS, theirs)).toBe(theirs);
  });

  it('has your faces, light or dark as yours are, and still their backs', () => {
    expect(seenLook({ ...mine, faces: 'mine' }, theirs)).toEqual({ deck: 'cute', night: false, backs: theirs.backs, bare: true });
  });

  it('has Big print, light or dark as yours are, and still their backs; your own hand too', () => {
    expect(seenLook({ ...mine, faces: 'big' }, theirs)).toEqual({ deck: 'big', night: false, backs: theirs.backs, bare: true });
    expect(seenLook({ deck: 'pixel', night: true, faces: 'big' }, PLAIN_LOOK)).toEqual({ ...PLAIN_LOOK, deck: 'big', night: true });
  });

  it("is the owner's until chosen, and kept once it is; a stored myFaces box becomes Mine", () => {
    expect(cleanPrefs(null).faces).toBe('owner');
    expect(cleanPrefs({ faces: 'big' }).faces).toBe('big');
    expect(cleanPrefs({ faces: 'mine' }).faces).toBe('mine');
    expect(cleanPrefs({ faces: 'huge' }).faces).toBe('owner');
    expect(cleanPrefs({ myFaces: true }).faces).toBe('mine');
    expect(cleanPrefs({ myFaces: false }).faces).toBe('owner');
    expect(cleanPrefs({ myFaces: 'yes' }).faces).toBe('owner');
  });
});

describe('cleanPrefs: offline', () => {
  it('is online unless it was plainly chosen: prefs stored before there was the choice, or damaged, are online', () => {
    expect(DEFAULT_PREFS.offline).toBe(false);
    expect(cleanPrefs(null).offline).toBe(false);
    expect(cleanPrefs({ offline: 'yes' }).offline).toBe(false);
    expect(cleanPrefs({ offline: true }).offline).toBe(true);
  });
});
