import { describe, expect, it } from 'vitest';
import { cleanPrefs, DEFAULT_PREFS, keyFree } from './prefs';

describe('cleanPrefs: hotkeys', () => {
  it('gives the defaults to prefs stored before there were any (or before the sound key)', () => {
    expect(cleanPrefs(null)).toMatchObject({ soundKey: 'KeyM', voiceKey: 'KeyV' });
    expect(cleanPrefs({ muted: true, voiceKey: 'KeyB' })).toMatchObject({ muted: true, soundKey: 'KeyM', voiceKey: 'KeyB' });
    expect(cleanPrefs({ voiceKey: null })).toMatchObject({ soundKey: 'KeyM', voiceKey: null });
  });

  it('keeps a key chosen, and none', () => {
    expect(cleanPrefs({ soundKey: 'KeyS', voiceKey: 'Digit7' })).toMatchObject({ soundKey: 'KeyS', voiceKey: 'Digit7' });
    expect(cleanPrefs({ soundKey: null, voiceKey: null })).toMatchObject({ soundKey: null, voiceKey: null });
  });

  it('puts back the default for a key the game uses, a modifier, or anything damaged', () => {
    for (const bad of ['KeyP', 'Space', 'Enter', 'Escape', 'Tab', 'ShiftLeft', 'MetaRight', 'Backspace', 'Delete', '', 'Key-M', 'x'.repeat(21), 7, true, {}])
      expect(cleanPrefs({ soundKey: bad, voiceKey: bad })).toMatchObject({ soundKey: DEFAULT_PREFS.soundKey, voiceKey: DEFAULT_PREFS.voiceKey });
  });

  it('never gives both the same key', () => {
    expect(cleanPrefs({ soundKey: 'KeyX', voiceKey: 'KeyX' })).toMatchObject({ soundKey: 'KeyX', voiceKey: 'KeyV' });
    expect(cleanPrefs({ soundKey: 'KeyV', voiceKey: 'KeyV' })).toMatchObject({ soundKey: 'KeyV', voiceKey: null });
    expect(cleanPrefs({ soundKey: 'KeyV' })).toMatchObject({ soundKey: 'KeyV', voiceKey: null });
    expect(cleanPrefs({ voiceKey: 'KeyM' })).toMatchObject({ soundKey: 'KeyM', voiceKey: 'KeyV' });
  });
});

describe('keyFree', () => {
  const keys = { soundKey: 'KeyM', voiceKey: 'KeyV' };
  it('refuses the other hotkey, but not the key the same one already has', () => {
    expect(keyFree(keys, 'soundKey', 'KeyV')).toBe(false);
    expect(keyFree(keys, 'voiceKey', 'KeyM')).toBe(false);
    expect(keyFree(keys, 'soundKey', 'KeyM')).toBe(true);
    expect(keyFree({ soundKey: 'KeyM', voiceKey: null }, 'voiceKey', 'KeyN')).toBe(true);
  });
  it('refuses the keys the game uses', () => {
    for (const code of ['KeyP', 'Space', 'Enter', 'Escape', 'Tab']) expect(keyFree({ soundKey: null, voiceKey: null }, 'soundKey', code)).toBe(false);
  });
});
