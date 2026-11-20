import { useEffect, useState } from 'react';

/**
 * The window's size, kept up to date. A phone that is turned can fire `resize` before `innerWidth` / `innerHeight`
 * have their new values (iOS Safari), which would leave the table laid out for the old shape on half the screen:
 * so the size is also read on `orientationchange` and on the visual viewport's own `resize`, and once more a frame
 * and a moment later.
 */
export function useViewport(): [number, number] {
  const [size, setSize] = useState<[number, number]>([window.innerWidth, window.innerHeight]);
  useEffect(() => {
    let frame = 0;
    let later: ReturnType<typeof setTimeout> | undefined;
    const read = () => setSize((was) => (was[0] === window.innerWidth && was[1] === window.innerHeight ? was : [window.innerWidth, window.innerHeight]));
    const on = () => {
      read();
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(read);
      clearTimeout(later);
      later = setTimeout(read, 350);
    };
    window.addEventListener('resize', on);
    window.addEventListener('orientationchange', on);
    window.visualViewport?.addEventListener('resize', on);
    return () => {
      window.removeEventListener('resize', on);
      window.removeEventListener('orientationchange', on);
      window.visualViewport?.removeEventListener('resize', on);
      cancelAnimationFrame(frame);
      clearTimeout(later);
    };
  }, []);
  return size;
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
export function insets(): { l: number; r: number; b: number } {
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
