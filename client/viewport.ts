import { useSyncExternalStore } from 'react';
import type { Insets } from './layout';

/** The window the game is laid out in: its size, and what the screen keeps for itself at its edges. */
export interface Viewport {
  W: number;
  H: number;
  pad: Insets;
}

/** How the page lies under the window: scrolled this far, as far as it reaches, and what is shown of it. */
export interface Page {
  x: number;
  y: number;
  maxX: number;
  maxY: number;
  /** How far what is shown is off the window (the visual viewport off the layout one): 0 but while the keyboard is up, or zoomed. */
  offX: number;
  offY: number;
  /** Zoomed in or out by hand. */
  zoomed: boolean;
  /** A field has the keyboard up. */
  typing: boolean;
}

/**
 * Where the page goes back to, or null where it is right. To keep a field clear of the keyboard a phone moves the page
 * under the window, and does not always move it back when the keyboard goes or the phone is turned (iOS); left moved,
 * all that is drawn fixed to the window (the table, its sheets, the menu) is pressed somewhere other than where it shows.
 * So, but while a field is typed into or the page is zoomed, the page is never further down or right than it reaches
 * (at a table, which scrolls not at all, that is the top), and what is shown is the window itself.
 */
export function putBack(p: Page): [number, number] | null {
  if (p.typing || p.zoomed) return null;
  const x = Math.min(p.x, Math.max(0, p.maxX));
  const y = Math.min(p.y, Math.max(0, p.maxY));
  return p.x - x > 1 || p.y - y > 1 || Math.abs(p.offX) > 1 || Math.abs(p.offY) > 1 ? [x, y] : null;
}

/** The kinds of input that bring no keyboard up. */
const KEYLESS = new Set(['button', 'checkbox', 'color', 'file', 'image', 'radio', 'range', 'reset', 'submit']);
const typing = (e: Element | null): boolean =>
  e instanceof HTMLTextAreaElement || e instanceof HTMLSelectElement || (e instanceof HTMLInputElement && !KEYLESS.has(e.type)) || (e instanceof HTMLElement && e.isContentEditable);

function pageNow(): Page {
  const root = document.documentElement;
  const v = window.visualViewport;
  return {
    x: window.scrollX,
    y: window.scrollY,
    maxX: root.scrollWidth - root.clientWidth,
    maxY: root.scrollHeight - root.clientHeight,
    offX: v?.offsetLeft ?? 0,
    offY: v?.offsetTop ?? 0,
    zoomed: !!v && Math.abs(v.scale - 1) > 0.01,
    typing: typing(document.activeElement),
  };
}

let probe: HTMLElement | null = null;
/**
 * What the screen keeps for itself at its edges, in px (`viewport-fit=cover`: the page runs under a phone's notch and
 * its bottom bar, and says here how far they reach). Read off an unseen element whose padding is those insets.
 */
function insets(): Insets {
  if (!probe) {
    probe = document.createElement('div');
    probe.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;visibility:hidden;pointer-events:none;padding:0 env(safe-area-inset-right,0px) env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px)';
    document.body.appendChild(probe);
  }
  const c = getComputedStyle(probe);
  const px = (v: string) => Math.round(parseFloat(v) || 0);
  return { l: px(c.paddingLeft), r: px(c.paddingRight), b: px(c.paddingBottom) };
}

const read = (): Viewport => ({ W: window.innerWidth, H: window.innerHeight, pad: insets() });
const same = (a: Viewport, b: Viewport): boolean => a.W === b.W && a.H === b.H && a.pad.l === b.pad.l && a.pad.r === b.pad.r && a.pad.b === b.pad.b;

/** The window as last looked at: the same object for as long as nothing of it changes. */
let now: Viewport | null = null;
const readers = new Set<() => void>();
/** The page put back where it belongs, and the window read again (told to every reader if it changed). */
function look(): void {
  const to = putBack(pageNow());
  if (to) window.scrollTo(to[0], to[1]);
  const seen = read();
  if (now && same(now, seen)) return;
  now = seen;
  for (const r of readers) r();
}

let frame = 0;
let later: ReturnType<typeof setTimeout> | undefined;
/**
 * A phone that is turned can say so (`resize`, `orientationchange`, the visual viewport's own `resize`) before
 * `innerWidth`, `innerHeight` and the insets have their new values, and moves the page back (if at all) after the
 * keyboard has gone: so after each, the window is looked at again a frame and a moment later. A field just left is
 * looked at only then, once the focus has settled (it may be going to the next field, the keyboard staying up).
 */
function soon(e: Event): void {
  if (e.type !== 'focusout') look();
  cancelAnimationFrame(frame);
  frame = requestAnimationFrame(look);
  clearTimeout(later);
  later = setTimeout(look, 350);
}
const EVENTS = ['resize', 'orientationchange', 'focusout'] as const;
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
