// Personal settings: sound levels and reduced motion. They belong to this
// browser, not to the table, and are remembered in localStorage when there is
// one (without it they last as long as the page).
import { useSyncExternalStore } from 'react';
import { deckNamed, isBack, isDeck, isLot, type Back, type Deck } from '../shared/protocol';

export { backGroups, CARD_BACKS, DECKS, type Back, type Deck } from '../shared/protocol';

export interface Prefs {
  muted: boolean;
  /** Everything, 0..1. */
  volume: number;
  /** Other players' cards relative to your own, 0..1. */
  others: number;
  /** Reduced motion: true or false overrides the system setting; null follows it. */
  calm: boolean | null;
  /** Which card faces your own deck has (client/cards/Face.tsx): the table is told, and everyone sees your cards so. */
  deck: Deck;
  /** The backs of your cards, likewise. */
  back: Back;
  /** Your cards dark: light on a dark card. */
  night: boolean;
  /** A bot that goes out says "Nertz" aloud, in a machine's voice (the browser's own speech, where it has any). */
  botVoice: boolean;
  /** What is said in the chat is shown over the table as it comes, while the chat is closed. */
  chatOver: boolean;
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
}

/** Your deck as it is named for drawing (client/cards/Face.tsx): its name, with `:night` after it for the dark one. */
export const deckOf = (p: Pick<Prefs, 'deck' | 'night'>): string => deckNamed(p.deck, p.night);

export const DEFAULT_PREFS: Prefs = { muted: false, volume: 0.8, others: 0.25, calm: null, deck: 'modern', back: 'plain', night: false, bare: false, random: null, botVoice: true, chatOver: true, soundKey: 'KeyM', voiceKey: 'KeyV' };
const KEY = 'nertz.prefs';

/** The keys you choose for yourself, in the order they are listed. */
export const HOTKEYS = ['soundKey', 'voiceKey'] as const;
export type Hotkey = (typeof HOTKEYS)[number];
/** Keys the game already uses: not to be had for a hotkey. */
export const TAKEN_KEYS = ['KeyP', 'Space', 'Enter', 'Escape', 'Tab'];
/**
 * May `code` be the key for `which`? A plain key (no modifier, nor Backspace or Delete, which choose none) that the
 * game does not use and that is not already another of your hotkeys.
 */
export const keyFree = (p: Pick<Prefs, Hotkey>, which: Hotkey, code: string): boolean =>
  /^[A-Za-z0-9]{1,20}$/.test(code) && !/^(Shift|Control|Alt|Meta|OS)|^(Backspace|Delete)$/.test(code) && !TAKEN_KEYS.includes(code) && HOTKEYS.every((k) => k === which || p[k] !== code);
/** A phone or tablet: no keyboard to speak of, so no key is offered or named. */
export const touchOnly = (): boolean => typeof matchMedia === 'function' && matchMedia('(hover: none) and (pointer: coarse)').matches;
/** A key as it is shown: "V" for KeyV, "7" for Digit7, otherwise its own name. */
export const keyName = (code: string): string => code.replace(/^(Key|Digit)/, '');
/** A hotkey as a button's tooltip names it: not on a phone, nor when there is none. */
export const hotkeyName = (code: string | null): string | null => (code && !touchOnly() ? keyName(code) : null);

const unit = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : fallback);

/** Whatever was stored, made into valid preferences: unknown or damaged fields fall back to the defaults. */
export function cleanPrefs(raw: unknown): Prefs {
  const v = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  return {
    muted: typeof v.muted === 'boolean' ? v.muted : DEFAULT_PREFS.muted,
    volume: unit(v.volume, DEFAULT_PREFS.volume),
    others: unit(v.others, DEFAULT_PREFS.others),
    calm: typeof v.calm === 'boolean' ? v.calm : null,
    deck: isDeck(v.deck) ? v.deck : DEFAULT_PREFS.deck,
    night: typeof v.night === 'boolean' ? v.night : v.deck === 'night', // ("night" was once a deck of its own)
    back: isBack(v.back) ? v.back : DEFAULT_PREFS.back,
    bare: v.bare === true,
    botVoice: v.botVoice !== false,
    chatOver: v.chatOver !== false,
    random: isLot(v.random) ? v.random : null,
    ...cleanKeys(v),
  };
}

/** Each hotkey as stored, if it may be that key (null stays none); otherwise its default, or none if another has that. */
function cleanKeys(v: Record<string, unknown>): Pick<Prefs, Hotkey> {
  const keys: Pick<Prefs, Hotkey> = { soundKey: null, voiceKey: null };
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

// (A choice of backs made at a table, from the card beside your name in its lobby, was once for that table only. It
// is now your own choice like any other, kept for every table; what follows only honours one that an open window
// still remembers from before.)
export interface Choice {
  back: Back;
  random: string | null;
}
const HERE = 'nertz.here';
let here: ({ room: string } & Choice) | null = null;
try {
  const v = JSON.parse(sessionStorage.getItem(HERE) ?? 'null') as ({ room: string } & Choice) | null;
  if (v && typeof v.room === 'string' && isBack(v.back) && (v.random === null || isLot(v.random))) here = v;
} catch {
  // no storage: a reload goes back to your own choice
}
function keep(): void {
  try {
    if (here) sessionStorage.setItem(HERE, JSON.stringify(here));
    else sessionStorage.removeItem(HERE);
  } catch {
    // no storage
  }
}

/** The backs you have at the table `room`: the choice made there if there is one, else your own. */
export const choiceAt = (room: string | null | undefined, p: Pick<Prefs, 'back' | 'random'> = prefs): Choice => (here && here.room === room ? { back: here.back, random: here.random } : { back: p.back, random: p.random });

export function setPrefs(patch: Partial<Prefs>): void {
  prefs = cleanPrefs({ ...prefs, ...patch });
  if ('back' in patch || 'random' in patch) {
    here = null; // your own choice, made anew, stands everywhere: also at the table you are at
    keep();
  }
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // no storage: the choice lasts until the page is closed
  }
  apply();
  for (const l of listeners) l();
}

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
    const was = prefs;
    prefs = load();
    if (prefs.back !== was.back || prefs.random !== was.random) {
      here = null; // as in `setPrefs`: your own choice, made anew, stands also at the table you are at
      keep();
    }
    apply();
    for (const l of listeners) l();
  });
system?.addEventListener?.('change', () => {
  prefs = { ...prefs }; // what `calm()` answers may have changed
  apply();
  for (const l of listeners) l();
});
