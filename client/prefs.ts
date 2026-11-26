// Personal settings: sound, reduced motion, your cards' faces and backs (and
// which faces every card has on your screen), hotkeys and how the
// chat is shown. They belong to this browser, not to the table, and are
// remembered in localStorage when there is one (without it they last as long
// as the page).
import { useSyncExternalStore } from 'react';
import { isBack, isDeck, isLot, type Back, type Deck, type Look } from '../shared/protocol';

export { backGroups, CARD_BACKS, DECKS, type Back, type Deck } from '../shared/protocol';

/** Whose faces you see on every card: its owner's, your own deck's, or Big print. */
export const FACES = ['owner', 'mine', 'big'] as const;
export type Faces = (typeof FACES)[number];

export interface Prefs {
  /** The game's sounds off. Voice chat is not muted by it: only by its own level, or by `levels.master`. */
  muted: boolean;
  levels: Levels;
  /** Your own microphone, as it goes out to voice chat. */
  mic: Mic;
  /** Reduced motion: true or false overrides the system setting; null follows it. */
  calm: boolean | null;
  /** Which card faces your own deck has (client/cards/Face.tsx): the table is told, and everyone sees your cards so (but as `faces` says). */
  deck: Deck;
  /** The backs of your cards, likewise. */
  back: Back;
  /** Your cards dark: light on a dark card. */
  night: boolean;
  /** The faces every card has on your screen (`seenLook`): its owner's, yours (`deck`, `night`), or Big print (light or dark as yours are). Nobody else is told, or sees anything of it. */
  faces: Faces;
  /** A bot that goes out says "Nertz" aloud, in a machine's voice (the browser's own speech, where it has any). */
  botVoice: boolean;
  /** What is said in the chat is shown over the table as it comes, while the chat is closed. */
  chatOver: boolean;
  /**
   * Tap to play: a tap or a click takes a card up, and the next one says where it goes (client/hand.ts). Off, a card
   * has to be dragged. Dragging always works. The table is not told: to the server a card moved so is a drag like any.
   */
  tapToMove: boolean;
  /** The time a message takes to the server and back, in a corner of the screen (client/net.ts measures it while this is on). */
  ping: boolean;
  /** Play offline: tables of this window's own, with bots, and nothing asked of the game server (client/net.ts `NetState.offline`, which is what to go by). */
  offline: boolean;
  /** Rounds played offline count toward the record of whoever was last signed in here, once they are back (client/record.ts). */
  saveStats: boolean;
  /** Your backs without the white edge: the pattern runs to the edge of the card. */
  bare: boolean;
  /**
   * A back drawn by lot for each table (when its first round is dealt), in place of `back`: from all of them ('all'),
   * or from one kind (the name of a group in `BACK_GROUPS`). Null: always `back`.
   */
  random: string | null;
  /** The key that mutes and unmutes the sound (a KeyboardEvent `code`); null: none. */
  soundKey: string | null;
  /** The key that mutes and unmutes your microphone while you are in voice, likewise. */
  voiceKey: string | null;
  /** The key that pauses and unpauses the round, when you may (actions.ts), likewise. */
  pauseKey: string | null;
}

/** How loud things are, each 0..1. Every channel plays at `master` times its own. */
export interface Levels {
  /** Everything, voice chat included. */
  master: number;
  /** The game's sounds at your end of the table: your cards, and those of the whole table (the count, the call of Nertz, a bot's spoken "Nertz"). */
  mine: number;
  /** Other players' cards. */
  others: number;
  /** Other players' voices, in voice chat. */
  voice: number;
}
export type Channel = Exclude<keyof Levels, 'master'>;

/** Your voice as the others hear it: how loud (0..2, 1 as the microphone gives it), and the gate (0..1, 0 off) under which nothing is sent. */
export interface Mic {
  level: number;
  gate: number;
}
/** The loudest a gate can be set to: the rms (of the signal after `micGain`) under which nothing is sent, at the gate's top. */
export const GATE_MAX = 0.1;
/** The microphone's gain: squared, as `loudness` is, so that its slider feels even (200%: four times as loud). */
export const micGain = (m: Mic): number => m.level ** 2;
/** The rms under which nothing is sent: 0 with the gate off. Squared likewise, so that the low end, where a room's noise is, has room on the slider. */
export const gateLevel = (m: Mic): number => GATE_MAX * m.gate ** 2;
export const CHANNELS = ['mine', 'others', 'voice'] as const satisfies readonly Channel[];

/** A channel's gain as it plays: squared, so that a slider feels even. Muted, the game's channels are silent and voice chat is not. */
export const loudness = (p: Pick<Prefs, 'muted' | 'levels'>, ch: Channel): number => (p.muted && ch !== 'voice' ? 0 : (p.levels.master * p.levels[ch]) ** 2);

/** Your cards as you chose them: by lot, a lot not drawn yet (the table draws it, and says what it drew). */
export const lookOf = (p: Pick<Prefs, 'deck' | 'night' | 'back' | 'bare' | 'random'>): Look => ({
  deck: p.deck,
  night: p.night,
  backs: p.random ? { k: 'lot', lot: p.random, drawn: null } : { k: 'own', back: p.back },
  bare: p.bare,
});

/**
 * A player's cards (`look`, as they chose them, yours included) as they are drawn on your screen: with your own faces
 * or Big print in place of theirs, if `faces` says so (light or dark as yours are). Their backs are theirs either way: a
 * back says whose the card is.
 */
export const seenLook = (p: Pick<Prefs, 'deck' | 'night' | 'faces'>, look: Look): Look => (p.faces === 'owner' ? look : { ...look, deck: p.faces === 'big' ? 'big' : p.deck, night: p.night });

const unit = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : fallback);

/**
 * The levels from when there was one volume, for the game's sounds only (`volume`: voice chat was always at full), and
 * other players' cards as a share of it (`others`): everything just as loud as it was. Unset, as they were by default.
 */
function fromOne(volume?: unknown, others?: unknown): Levels {
  const mine = unit(volume, 0.8);
  return { master: 1, mine, others: mine * Math.sqrt(unit(others, 0.25)), voice: 1 };
}

export const DEFAULT_PREFS: Prefs = { muted: false, levels: fromOne(), mic: { level: 1, gate: 0 }, calm: null, deck: 'modern', back: 'plain', night: false, faces: 'owner', bare: false, random: null, botVoice: true, chatOver: true, tapToMove: false, ping: false, offline: false, saveStats: true, soundKey: 'KeyM', voiceKey: 'KeyV', pauseKey: 'KeyP' };
const KEY = 'nertz.prefs';

/** The keys you choose for yourself, in the order they are listed. */
export const HOTKEYS = ['soundKey', 'voiceKey', 'pauseKey'] as const;
export type Hotkey = (typeof HOTKEYS)[number];
/** Every hotkey with no key. */
const NO_KEYS = (): Pick<Prefs, Hotkey> => ({ soundKey: null, voiceKey: null, pauseKey: null });
/** Keys the game already uses: not to be had for a hotkey. */
export const TAKEN_KEYS = ['Space', 'Enter', 'Escape', 'Tab'];
/**
 * May `code` be the key for `which`? A plain key (no modifier, nor Backspace or Delete, which choose none) that the
 * game does not use and that is not already another of your hotkeys.
 */
export const keyFree = (p: Pick<Prefs, Hotkey>, which: Hotkey, code: string): boolean =>
  /^[A-Za-z0-9]{1,20}$/.test(code) && !/^(Shift|Control|Alt|Meta|OS)|^(Backspace|Delete)$/.test(code) && !TAKEN_KEYS.includes(code) && HOTKEYS.every((k) => k === which || p[k] !== code);
/**
 * `which` given the key `code`, as a change to your preferences: it takes the key, and a hotkey of yours that had it
 * is left with none. Null if it is no key for a hotkey at all (a modifier, or one the game uses).
 */
export function takeKey(p: Pick<Prefs, Hotkey>, which: Hotkey, code: string): Partial<Pick<Prefs, Hotkey>> | null {
  if (!keyFree(NO_KEYS(), which, code)) return null;
  const patch: Partial<Pick<Prefs, Hotkey>> = { [which]: code };
  for (const k of HOTKEYS) if (k !== which && p[k] === code) patch[k] = null;
  return patch;
}
/**
 * Is this key press the hotkey `code`? Pressed bare (no Shift, Ctrl, Alt or Cmd, not held down), and not while typing
 * in a text field. (A slider or a checkbox that has the focus does not swallow it.)
 */
export const hotkeyPressed = (e: KeyboardEvent, code: string | null): boolean =>
  !!code && e.code === code && !e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && !(e.target as Element | null)?.closest?.('input:not([type=range]):not([type=checkbox]),textarea');
/** A phone or tablet: no keyboard to speak of, so no key is offered or named. */
export const touchOnly = (): boolean => typeof matchMedia === 'function' && matchMedia('(hover: none) and (pointer: coarse)').matches;
/** A key as it is shown: "V" for KeyV, "7" for Digit7, otherwise its own name. */
export const keyName = (code: string): string => code.replace(/^(Key|Digit)/, '');
/** A hotkey as a button's tooltip names it: not on a phone, nor when there is none. */
export const hotkeyName = (code: string | null): string | null => (code && !touchOnly() ? keyName(code) : null);

function cleanLevels(v: Record<string, unknown>): Levels {
  const was = fromOne(v.volume, v.others);
  const l = typeof v.levels === 'object' && v.levels !== null ? (v.levels as Record<string, unknown>) : {};
  return { master: unit(l.master, was.master), mine: unit(l.mine, was.mine), others: unit(l.others, was.others), voice: unit(l.voice, was.voice) };
}

function cleanMic(v: unknown): Mic {
  const m = typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
  return { level: 2 * unit(typeof m.level === 'number' ? m.level / 2 : null, 0.5), gate: unit(m.gate, 0) };
}

/** Whatever was stored, made into valid preferences: unknown or damaged fields fall back to the defaults. */
export function cleanPrefs(raw: unknown): Prefs {
  const v = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  return {
    muted: typeof v.muted === 'boolean' ? v.muted : DEFAULT_PREFS.muted,
    levels: cleanLevels(v),
    mic: cleanMic(v.mic),
    calm: typeof v.calm === 'boolean' ? v.calm : null,
    deck: isDeck(v.deck) ? v.deck : DEFAULT_PREFS.deck,
    night: typeof v.night === 'boolean' ? v.night : v.deck === 'night', // ("night" was once a deck of its own)
    faces: FACES.find((f) => f === v.faces) ?? (v.myFaces === true ? 'mine' : 'owner'), // (`myFaces`, a box, was ticked or not)
    back: isBack(v.back) ? v.back : DEFAULT_PREFS.back,
    bare: v.bare === true,
    botVoice: v.botVoice !== false,
    chatOver: v.chatOver !== false,
    tapToMove: v.tapToMove === true,
    ping: v.ping === true,
    offline: v.offline === true,
    saveStats: v.saveStats !== false,
    random: isLot(v.random) ? v.random : null,
    ...cleanKeys(v),
  };
}

/** Each hotkey as stored, if it may be that key (null stays none); otherwise its default, or none if another has that. */
function cleanKeys(v: Record<string, unknown>): Pick<Prefs, Hotkey> {
  const keys = NO_KEYS();
  for (const k of HOTKEYS) {
    const code = v[k];
    if (code === null) continue;
    if (typeof code === 'string' && keyFree(keys, k, code)) keys[k] = code;
    else {
      const d = DEFAULT_PREFS[k];
      if (d && keyFree(keys, k, d)) keys[k] = d;
    }
  }
  return keys;
}

function load(): Prefs {
  try {
    return cleanPrefs(JSON.parse(localStorage.getItem(KEY) ?? 'null'));
  } catch {
    return DEFAULT_PREFS;
  }
}

let prefs = load();
const listeners = new Set<() => void>();
const system = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;

/** Reduced motion as it applies right now: the player's choice if they made one, else the system's. */
export const calm = (): boolean => prefs.calm ?? system?.matches ?? false;

/** The stylesheet goes by a class on the root element, so that the choice here can overrule the system either way. */
function apply(): void {
  if (typeof document !== 'undefined') document.documentElement.classList.toggle('calm', calm());
}

export const getPrefs = (): Prefs => prefs;

export function setPrefs(patch: Partial<Prefs>): void {
  prefs = cleanPrefs({ ...prefs, ...patch });
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // no storage: the choice lasts until the page is closed
  }
  apply();
  for (const l of listeners) l();
}

export const setLevel = (which: keyof Levels, to: number): void => setPrefs({ levels: { ...prefs.levels, [which]: to } });

/** Calls `l` after every change. Returns the way to stop. */
export const watchPrefs = (l: () => void): (() => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export const usePrefs = (): Prefs => useSyncExternalStore(watchPrefs, getPrefs);

apply();
// Another window of this browser changed them (the page of cards, opened from the settings in a round): this one takes
// them over, so that it shows them, tells its table, and does not write its old ones back over them.
if (typeof window !== 'undefined')
  window.addEventListener('storage', (e) => {
    if (e.key !== KEY) return;
    prefs = load();
    apply();
    for (const l of listeners) l();
  });
system?.addEventListener?.('change', () => {
  prefs = { ...prefs }; // what `calm()` answers may have changed
  apply();
  for (const l of listeners) l();
});
