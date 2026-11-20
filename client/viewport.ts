import { useEffect, useState, useSyncExternalStore } from 'react';
import type { Insets } from './layout';

/** The window the game is laid out in: its size, and what the screen keeps for itself at its edges. */
export interface Viewport {
  W: number;
  H: number;
  pad: Insets;
}

/** A part of the window, in its px: where it starts, and how big it is. */
export interface Area {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** What of the window is seen (the visual viewport): where it is in the window, its size, and how far it is pinched in. */
export interface Seen {
  offsetLeft: number;
  offsetTop: number;
  width: number;
  height: number;
  scale: number;
}

/** How much shorter than the window what is seen must be for a keyboard to be up: more than a browser's bars come and go by, less than any phone's keyboard. */
export const KEYBOARD_MIN = 120;

/**
 * The part of the window a phone's keyboard leaves to be seen, or null while no keyboard is up. `H`: the window's
 * height. A phone's browser does not shrink the window for its keyboard; it shrinks what is seen, and may move that
 * down the window to show the field being typed in. A pinch shrinks what is seen too, but all of it in proportion.
 */
export function aboveKeyboard(H: number, seen: Seen): Area | null {
  return H - seen.height * seen.scale >= KEYBOARD_MIN ? { x: seen.offsetLeft, y: seen.offsetTop, w: seen.width, h: seen.height } : null;
}

const sameArea = (a: Area | null, b: Area | null) => a === b || (!!a && !!b && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h);

/** While `on`: the part of the window a phone's keyboard leaves (`aboveKeyboard`), followed as the keyboard comes and goes and as what is seen is moved. */
export function useAboveKeyboard(on: boolean): Area | null {
  const [area, setArea] = useState<Area | null>(null);
  useEffect(() => {
    const seen = window.visualViewport;
    if (!on || !seen) return;
    // (The window's height: the larger of the two, as a pinch can shrink `innerHeight` on iOS.)
    const read = () => {
      const next = aboveKeyboard(Math.max(window.innerHeight, document.documentElement.clientHeight), seen);
      setArea((was) => (sameArea(was, next) ? was : next));
    };
    read();
    seen.addEventListener('resize', read);
    seen.addEventListener('scroll', read);
    return () => {
      seen.removeEventListener('resize', read);
      seen.removeEventListener('scroll', read);
      setArea(null);
    };
  }, [on]);
  return on ? area : null;
}

let probe: HTMLElement | null = null;
/**
 * What the screen keeps for itself at its edges, in px (`viewport-fit=cover`: the page runs under a phone's notch and
 * its bottom bar, and says here how far they reach). Read off an unseen element whose padding is those insets.
 * On its side the home bar's strip is not kept: the line is thin and a tap there still lands, and keeping it left a
 * gap under the menu's button and your cards on top of the table's own margin.
 */
function insets(): Insets {
  if (!probe) {
    probe = document.createElement('div');
    probe.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;visibility:hidden;pointer-events:none;padding:0 env(safe-area-inset-right,0px) env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px)';
    document.body.appendChild(probe);
  }
  const c = getComputedStyle(probe);
  const px = (v: string) => Math.round(parseFloat(v) || 0);
  const sideways = window.innerWidth > window.innerHeight;
  return { l: px(c.paddingLeft), r: px(c.paddingRight), b: sideways ? 0 : px(c.paddingBottom) };
}

const read = (): Viewport => ({ W: window.innerWidth, H: window.innerHeight, pad: insets() });
const same = (a: Viewport, b: Viewport): boolean => a.W === b.W && a.H === b.H && a.pad.l === b.pad.l && a.pad.r === b.pad.r && a.pad.b === b.pad.b;

/** The window as last looked at: the same object for as long as nothing of it changes. */
let now: Viewport | null = null;
const readers = new Set<() => void>();
/** The window read again (told to every reader if it changed). */
function look(): void {
  const seen = read();
  if (now && same(now, seen)) return;
  now = seen;
  for (const r of readers) r();
}

let frame = 0;
let later: ReturnType<typeof setTimeout> | undefined;
/**
 * A phone that is turned can say so (`resize`, `orientationchange`, the visual viewport's own `resize`) before
 * `innerWidth`, `innerHeight` and the insets have their new values: so after each, the window is looked at again a
 * frame and a moment later.
 */
function soon(): void {
  look();
  cancelAnimationFrame(frame);
  frame = requestAnimationFrame(look);
  clearTimeout(later);
  later = setTimeout(look, 350);
}
const EVENTS = ['resize', 'orientationchange'] as const;
function subscribe(reader: () => void): () => void {
  if (!readers.size) {
    for (const e of EVENTS) window.addEventListener(e, soon);
    window.visualViewport?.addEventListener('resize', soon);
    look();
  }
  readers.add(reader);
  return () => {
    readers.delete(reader);
    if (readers.size) return;
    for (const e of EVENTS) window.removeEventListener(e, soon);
    window.visualViewport?.removeEventListener('resize', soon);
    cancelAnimationFrame(frame);
    clearTimeout(later);
  };
}

/** The window, kept up to date: one watcher for the page, however many read it. */
export function useWindow(): Viewport {
  return useSyncExternalStore(subscribe, () => (now ??= read()));
}
