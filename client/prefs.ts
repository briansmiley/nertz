// Personal settings: sound levels and reduced motion. They belong to this
// browser, not to the table, and are remembered in localStorage when there is
// one (without it they last as long as the page).
import { useSyncExternalStore } from 'react';
import { isBack, isDeck, type Back, type Deck } from '../shared/protocol';

export { CARD_BACKS, DECKS, type Back, type Deck } from '../shared/protocol';

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
}

/** Your deck as it is named for drawing (client/cards/Face.tsx): its name, with `:night` after it for the dark one. */
export const deckOf = (p: Pick<Prefs, 'deck' | 'night'>): string => `${p.deck}${p.night ? ':night' : ''}`;


export const DEFAULT_PREFS: Prefs = { muted: false, volume: 0.8, others: 0.25, calm: null, deck: 'modern', back: 'plain', night: false };
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

/** Calls `l` after every change. Returns the way to stop. */
export const watchPrefs = (l: () => void): (() => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export const usePrefs = (): Prefs => useSyncExternalStore(watchPrefs, getPrefs);

apply();
system?.addEventListener?.('change', () => {
  prefs = { ...prefs }; // what `calm()` answers may have changed
  apply();
  for (const l of listeners) l();
});
