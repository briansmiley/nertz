import { useEffect, useRef, type RefObject } from 'react';

/**
 * What is drawn over everything: the sheet of backs (put straight into the page, outside any slip it was opened from)
 * and an Are-you-sure. Live while a slip is open, and a press on it is not beside the slip. (The same list is in
 * styles/base.css.)
 */
const OVER = '.picker, .asked';

/** An open slip: where it is, and how it is put away. */
type Slip = { root: RefObject<Element | null>; close: RefObject<() => void> };

/** The slips open now, each opened after (and so over, or inside) the one before: the last is the live one. */
const slips: Slip[] = [];
/** A press beside the live slip, until it ends. `touch`: it ends with its touch, which is held back too. */
let press: { pointer: number; touch: boolean; slip: Slip } | null = null;

/**
 * A slip that puts itself away: while `open`, a press anywhere outside `root`, or Escape, calls `close`. The page under
 * an open slip is shut to the pointer (`data-slipped` on <html>, styles/base.css), as if behind a sheet of glass, so
 * that press touches nothing: no button under it is pressed, lit or tipped, and no card is picked up. It only puts the
 * slip away, as it ends. Only the last slip opened is live, so a press beside a slip opened inside another (a dropdown
 * on a slip) puts away the inner one alone.
 */
export function useDismiss(root: RefObject<Element | null>, open: boolean, close: () => void): void {
  const shut = useRef(close);
  shut.current = close;
  useEffect(() => {
    if (!open) return;
    const slip: Slip = { root, close: shut };
    slips.push(slip);
    mark();
    const onKey = (e: KeyboardEvent) => e.code === 'Escape' && shut.current();
    window.addEventListener('keydown', onKey);
    return () => {
      slips.splice(slips.indexOf(slip), 1);
      mark();
      window.removeEventListener('keydown', onKey);
    };
  }, [open, root]);
}

/** Marks the page and the live slip, and listens for presses, for as long as a slip is open or a press beside one is on. */
function mark(): void {
  const live = slips.at(-1)?.root.current;
  for (const el of document.querySelectorAll('[data-live]')) if (el !== live) el.removeAttribute('data-live');
  live?.setAttribute('data-live', '');
  const on = slips.length > 0 || !!press;
  if (on === document.documentElement.hasAttribute('data-slipped')) return;
  document.documentElement.toggleAttribute('data-slipped', on);
  const listen = on ? addEventListener : removeEventListener;
  listen('pointerdown', onDown, true);
  listen('pointerup', onUp, true);
  listen('pointercancel', onUp, true);
  listen('touchend', onTouchEnd, { capture: true, passive: false } as AddEventListenerOptions);
  listen('touchcancel', onTouchEnd, true);
}

function onDown(e: PointerEvent): void {
  const slip = slips.at(-1);
  if (press || !slip || slip.root.current?.contains(e.target as Node) || (e.target as Element).closest?.(OVER)) return;
  press = { pointer: e.pointerId, touch: e.pointerType === 'touch', slip };
}

function onUp(e: PointerEvent): void {
  if (press && !press.touch && e.pointerId === press.pointer) end();
}

/** (Held back, the touch makes no tap: no click, and no mouse over what is under it once the page is open again.) */
function onTouchEnd(e: TouchEvent): void {
  if (!press?.touch || e.touches.length) return;
  if (e.cancelable) e.preventDefault();
  end();
}

function end(): void {
  const { slip } = press!;
  press = null;
  if (slips.includes(slip)) slip.close.current();
  mark();
}
