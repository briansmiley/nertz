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
}

/** Your deck as it is named for drawing (client/cards/Face.tsx): its name, with `:night` after it for the dark one. */
export const deckOf = (p: Pick<Prefs, 'deck' | 'night'>): string => deckNamed(p.deck, p.night);

export const DEFAULT_PREFS: Prefs = { muted: false, volume: 0.8, others: 0.25, calm: null, deck: 'modern', back: 'plain', night: false, bare: false, random: null, botVoice: true, chatOver: true };
const KEY = 'nertz.prefs';

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
  };
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
